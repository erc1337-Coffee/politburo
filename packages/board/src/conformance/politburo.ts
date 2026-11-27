import type { AttentionDraft, MessageView } from '../api/routes.ts'
import { BoardError } from '../client/client.ts'
import { canonical } from '../contract/data-schemas.ts'
import { compileAccess } from '../server/access.ts'
import type { Board } from '../server/board.ts'
import type { Check, CheckResult, Context, PolitburoHelpers } from './index.ts'

/**
 * What a check created, to delete only what it still finds as it made it: its ID, the board it was
 * created on, the principal it's by, where and when the board says it was made, and the check
 * that made it.
 */
export type Made = { id: string; re: string | null; board: string | null; principal: string; channel: string; createdAt: string; check: string; unconfirmed?: string }

export function politburo(helpers: PolitburoHelpers) {
  const { Mismatch, Skip, alike, isRef, refused, rejects, reply, same, show, task, taskBatch } = helpers
  const check: PolitburoHelpers['check'] = helpers.check

  const requestFailure = (error: unknown) =>
    error instanceof BoardError && Number.isInteger(error.status) ? `got HTTP ${error.status}` : 'request failed'

  /**
   * The board a handle names, or null when it can't be read. On `http()` discovery is cached,
   * so also verify the message itself.
   */
  async function boardOf(board: Board): Promise<string | null> {
    try {
      const { url, audience, team_id, project_id } = await board.discovery()
      return typeof url === 'string' && typeof audience === 'string' ? JSON.stringify([url, audience, team_id ?? null, project_id ?? null]) : null
    } catch {
      return null
    }
  }

  /** Reads the message itself, paging from the root if it isn't in the newest replies. */
  async function readMade(by: Board, { id, re }: Pick<Made, 'id' | 're'>): Promise<MessageView | undefined> {
    const thread = await by.thread(id)
    if (re === null) return thread.message.id === id ? thread.message : undefined
    if (thread.message.id !== re) return undefined
    const found = thread.replies.find((reply) => reply.id === id)
    if (found) return found
    const seen = new Set([re])
    for (let after = re; ; ) {
      const page = await by.thread(id, { after, limit: 500 })
      if (page.message.id !== re) return undefined
      const reply = page.replies.find((one) => one.id === id)
      if (reply) return reply
      const next = page.replies.at(-1)?.id
      if (next === undefined || seen.has(next)) return undefined
      seen.add(next)
      after = next
    }
  }

  /** Confirms what the creating handle reads back against its board and create answer. */
  async function record(ctx: Context, by: Board, on: string | null, message: MessageView): Promise<Made> {
    const made: Made = { id: message.id, re: message.re, board: on, principal: message.by?.principal, channel: message.channel, createdAt: message.createdAt, check: ctx.running }
    if (on === null) return { ...made, unconfirmed: 'the run could not name the board before creating it' }
    if (typeof made.principal !== 'string' || typeof made.channel !== 'string') return { ...made, unconfirmed: 'the create answer did not give its provenance' }
    try {
      const read = await readMade(by, made)
      if (await boardOf(by) !== on) return { ...made, unconfirmed: 'the board changed during read-back' }
      // Some creates stamp a different time. Require the run's label when it has one.
      const marked = message.labels?.conformance === ctx.labels.conformance
      if (
        !read || read.channel !== made.channel || read.by?.principal !== made.principal || read.text !== message.text ||
        typeof read.createdAt !== 'string' || (marked ? read.labels?.conformance !== ctx.labels.conformance : read.createdAt !== made.createdAt)
      ) return { ...made, unconfirmed: 'the read-back did not match the create answer' }
      return { ...made, createdAt: read.createdAt }
    } catch (error) {
      return { ...made, unconfirmed: `reading it back: ${requestFailure(error)}` }
    }
  }

  /** Records what a check created, on the board the creating handle names before the write. */
  async function keep<T extends MessageView | { task: MessageView } | MessageView[]>(
    ctx: Context, by: Board, create: () => Promise<T>, posted = ctx.posted,
  ): Promise<T> {
    const on = await boardOf(by)
    const made = await create()
    const messages = Array.isArray(made) ? made : 'id' in made ? [made] : [made.task]
    for (const message of messages) posted.push(await record(ctx, by, on, message))
    return made
  }

  /**
   * Why `made` stays, or null if the writing handle finds it on the same board, by the same principal,
   * in the same channel, and from the same moment. An unconfirmed or unreadable message, even a 404, stays.
   */
  async function stays(by: Board, made: Made): Promise<string | null> {
    const what = `${made.id} is not the message this run created (by ${made.principal} in ${made.channel} at ${made.createdAt}), so it was not touched`
    if (made.unconfirmed !== undefined) return `${what}: ${made.unconfirmed}`
    const here = await boardOf(by)
    if (made.board === null || here !== made.board) return `${what}: it was created on ${made.board ?? 'a board the run could not name'} and the handle is on ${here ?? 'a board the run cannot name'} now`
    try {
      const message = await readMade(by, made)
      if (!message) return `${what}: the thread did not return the message`
      if (message.by.principal !== made.principal || message.channel !== made.channel || message.createdAt !== made.createdAt)
        return `${what}: it is by ${message.by.principal} in ${message.channel} from ${message.createdAt} now`
    } catch (error) {
      return `${what}: reading it: ${requestFailure(error)}`
    }
    return null
  }

  /** Deletes what the run made, or says why it stayed. */
  async function deleteMade(made: Made, by: Board, options: { revision?: number } = {}): Promise<string | null> {
    const why = await stays(by, made)
    if (why !== null) return why
    await by.delete(made.id, options)
    return null
  }

  /** What the run made with this ID. */
  const madeOf = (ctx: Context, id: string): Made => {
    const made = ctx.posted.find((one) => one.id === id)
    if (!made) throw new Mismatch(`${id} is not something this run created`)
    return made
  }

  /** Deletes what the run made now, as a check of deletes does: a check that can't, because the board has changed under it, fails and names what stays. */
  async function remove(ctx: Context, made: Made | string, by: Board = ctx.board, options?: { revision?: number }) {
    const why = await deleteMade(typeof made === 'string' ? madeOf(ctx, made) : made, by, options)
    if (why !== null) throw new Mismatch(`a delete the run makes: ${why}`)
  }

  /** That a write expected to be refused would go to what the run made: the board and the principal are the ones that made it. */
  async function onMade(ctx: Context, id: string, by: Board = ctx.board) {
    const why = await stays(by, madeOf(ctx, id))
    if (why !== null) throw new Mismatch(`a write the run expects refused: ${why}`)
  }

  /** Only the first extension call can declare that this board has no task authority. */
  async function taskAuthority<T>(attempt: Promise<T>): Promise<T> {
    try {
      return await attempt
    } catch (error) {
      if (error instanceof BoardError && error.status === 501 && error.code === 'no_task_authority') throw new Skip('not kept here: no task authority')
      throw error
    }
  }

  const taskFeed = (ctx: Context, after?: string) => ctx.board.poll({ channel: ctx.channel, label: [`conformance=${ctx.labels.conformance}`], ...(after === undefined ? {} : { after }) })
  const handoffPacket = { commit: 'a'.repeat(40), packetPath: 'handoffs/conformance.md', sha256: 'b'.repeat(64) }

  const NETWORK_PAUSE: Check = {
    group: 'network-pause',
    name: 'pauses claims without stopping collaboration, and resumes without reviving old claims',
    async run(ctx) {
      const board = ctx.board
      const start = await board.status().catch((error: unknown) => {
        if (error instanceof BoardError && error.status === 501 && error.code === 'no_network_pause') return null
        throw error
      })
      if (start === null) return 'not kept here: this board does not support network pause'
      check(start.paused === false && Number.isSafeInteger(start.pauseEpoch) && start.pauseEpoch >= 0, 'network pause checks need a running board with a valid pause epoch')
      const { task: held } = await task(ctx, 'conformance: claimed before the pause')
      const old = await board.tasks.claim(held.id)
      const labels = { ...ctx.labels, queue: 'network-pause' }
      try {
        const paused = await board.pause('conformance: check the network pause')
        same(paused.paused, true, 'status returned by pause')
        same(paused.pauseEpoch, start.pauseEpoch + 1, 'pause epoch after pause')
        const read = await board.status()
        same(read.paused, true, 'status read while paused')
        same(read.pauseEpoch, paused.pauseEpoch, 'pause epoch read while paused')
        const { task: queued } = await task(ctx, 'conformance: queued during the pause', { labels })
        const note = await reply(ctx, queued.id, 'conformance: human replies still land')
        const thread = await board.thread(queued.id)
        same(thread.message.id, queued.id, 'task read while paused')
        check(thread.replies.some((message) => message.id === note.id), 'a human reply should be visible while paused')
        await rejects(board.tasks.claim(queued.id), 409, 'board_paused', 'claiming by ID while paused')
        await rejects(board.tasks.claim({ channel: ctx.channel, label: labels }), 409, 'board_paused', 'claiming the next task while paused')
        await rejects(task(ctx, 'conformance: cannot create and claim during the pause', { claim: true }), 409, 'board_paused', 'creating and claiming while paused')
        const resumed = await board.resume('conformance: check resuming')
        same(resumed.paused, false, 'status returned by resume')
        same(resumed.pauseEpoch, paused.pauseEpoch, 'pause epoch after resume')
        await rejects(old.complete(), 409, 'claim_lost', 'settling with the pre-pause claim after resume')
        const fresh = await board.tasks.claim({ channel: ctx.channel, label: labels })
        same(fresh?.task.id, queued.id, 'a fresh claim after resume')
        await fresh?.release()
      } finally {
        if ((await board.status()).paused) await board.resume('conformance: restore the running board')
      }
    },
  }

  const taskAuthorityChecks: Check[] = [
    {
      group: 'tasks',
      taskAuthority: true,
      name: 'parks a task only as a verified person with manage, and unpark restores work without the claim',
      run: async (ctx) => {
        const { task: root } = await task(ctx, 'conformance: operator park')
        const reason = 'conformance: hold for an operator'
        const lifted = 'conformance: approved by an operator'
        if (ctx.me.kind !== 'person' || ctx.me.profile !== null || !compileAccess(ctx.me.can).can('manage', ctx.channel)) {
          try {
            await taskAuthority(ctx.board.tasks.park(root.id, reason))
          } catch (error) {
            if (!(error instanceof BoardError) || error.status !== 403 || error.code !== 'forbidden') throw error
            await rejects(ctx.board.tasks.unpark(root.id, lifted), 403, 'forbidden', 'unparking without a verified person with manage')
            return
          }
          throw new Mismatch('parking without a verified person with manage: expected 403 forbidden, and it succeeded')
        }
        const { cursor } = await taskFeed(ctx)
        const held = await ctx.board.tasks.claim(root.id)
        const parked = await taskAuthority(ctx.board.tasks.park(root.id, reason))
        same(parked.task?.state, 'blocked', 'the parked task')
        same(parked.labels['board.task'], 'blocked', "the parked root's board.task")
        same(parked.task?.claim, null, 'the claim of a parked task')
        same(parked.task?.parked?.reason, reason, 'why the task was parked')
        same(parked.task?.parked?.previous, 'claimed', 'where the task was before it was parked')
        same(parked.task?.parked?.by.actor, ctx.me.actor, 'who parked the task')
        await rejects(ctx.board.tasks.claim(root.id), 409, 'task_blocked', 'claiming a parked task')
        await rejects(ctx.board.tasks.unblock(root.id), 409, 'task_blocked', 'lifting a park with the legacy unblock')
        if (ctx.withHeaders) {
          const agent = ctx.withHeaders({ 'x-board-profile': 'conformance' })
          await rejects(agent.tasks.unpark(root.id, lifted), 403, 'forbidden', 'unparking as a profile')
        }
        if (ctx.withCan) {
          const narrowed = ctx.withCan(`${ctx.channel}=read,label`)
          await rejects(narrowed.tasks.unpark(root.id, lifted), 403, 'forbidden', 'unparking without manage in the channel')
        }
        const resumed = await ctx.board.tasks.unpark(root.id, lifted)
        same(resumed.task?.state, 'ready', 'the unparked task')
        same(resumed.task?.claim, null, 'the claim of a task after unpark')
        await rejects(held.complete(), 409, 'claim_lost', 'settling the claim that was parked and unparked')
        const { events } = await taskFeed(ctx, cursor)
        const operatorEvents = events.filter((event) => event.message?.id === root.id && (event.type === 'task.parked' || event.type === 'task.unparked'))
        alike(operatorEvents.map((event) => {
          const payload = event.payload as { reason?: string; by?: { actor: string; principal: string } }
          return [event.type, payload.reason, payload.by?.actor, payload.by?.principal]
        }), [
          ['task.parked', reason, ctx.me.actor, ctx.me.principal],
          ['task.unparked', lifted, ctx.me.actor, ctx.me.principal],
        ], 'the park and unpark events, with their verified operators and reasons')
      },
    },
    {
      group: 'tasks',
      taskAuthority: true,
      name: 'binds a claim to its verified owner and fences an older generation even with the same token',
      run: async (ctx) => {
        const { task: root } = await task(ctx, 'conformance: bound claim')
        const owner = { principal: ctx.me.principal, actor: ctx.me.actor }
        const binding = { owner, controller: owner, provider: 'conformance', model: 'example', session: 'first', branch: 'topic/conformance', worktree: '/workspace/conformance', baseCommit: 'a'.repeat(40) }
        // 32 random bytes encoded as base64url, without Node dependencies. Never put the proof in a diagnostic.
        const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=$/, '')
        if (/^board:client(?::|$)/.test(ctx.me.principal)) {
          await rejects(ctx.board.tasks.claim(root.id, { binding, token }), 403, 'forbidden', 'binding a claim without a verified caller')
          return
        }
        const first = await taskAuthority(ctx.board.tasks.claim(root.id, { binding, token }))
        const assertBinding = (got: unknown, expected: typeof binding, what: string) => check(canonical(got) === canonical(expected), `${what} should show the complete binding that was supplied`)
        assertBinding(first.binding, binding, 'the claim')
        assertBinding((await ctx.board.thread(root.id)).message.task?.claim?.binding, binding, 'the read of the task')
        const sameClaim = await ctx.board.tasks.claim(root.id, { token })
        same(sameClaim.epoch, first.epoch, 'the generation on retry with the live token')
        assertBinding(sameClaim.binding, binding, 'a retry with no binding supplied')
        const next = { ...binding, session: 'second' }
        await rejects(ctx.board.tasks.claim(root.id, { token, binding: next }), 409, 'binding_mismatch', 'changing the binding of a live claim on retry')
        await first.release()
        await rejects(ctx.board.tasks.claim(root.id, { binding: { ...binding, owner: { principal: 'vercel:user:u_not_claimant', actor: 'vercel:user:u_not_claimant' } } }), 403, 'forbidden', 'naming an unverified owner in the binding')
        const second = await ctx.board.tasks.claim(root.id, { token, binding: next })
        same(second.epoch, first.epoch + 1, 'the next generation')
        check(second.token === first.token && first.token === token, 'both generations should use the supplied token')
        await rejects(first.complete(), 409, 'claim_lost', 'settling a previous generation with the current token')
        same((await second.complete()).task?.state, 'completed', 'the result of settling the current generation')
      },
    },
    {
      group: 'tasks',
      taskAuthority: true,
      name: 'records an immutable handoff and accepts only one of two replacements naming the same predecessor',
      run: async (ctx) => {
        const { task: root } = await task(ctx, 'conformance: immutable handoff')
        const { cursor } = await taskFeed(ctx)
        const claim = await ctx.board.tasks.claim(root.id)
        const first = (await taskAuthority(claim.handoff(handoffPacket))).task?.handoff
        check(first, 'the handoff write should answer a handoff record')
        isRef(first.id, 'the handoff id')
        same(first.commit, handoffPacket.commit, 'the handoff commit')
        same(first.packetPath, handoffPacket.packetPath, 'the handoff packet path')
        same(first.sha256, handoffPacket.sha256, 'the handoff packet hash')
        same(first.by?.actor, ctx.me.actor, 'the handoff author')
        same(first.generation, claim.epoch, 'the handoff generation')
        await rejects(claim.handoff(handoffPacket), 409, 'handoff_conflict', 'replacing a handoff without naming it')
        const racing = await Promise.allSettled(['c', 'd'].map((digit) => claim.handoff({ ...handoffPacket, commit: digit.repeat(40), supersedes: first.id })))
        const won = racing.filter((result) => result.status === 'fulfilled')
        same(won.length, 1, 'the number of supersessions that won the race')
        const lost = racing.find((result) => result.status === 'rejected')
        check(lost?.reason instanceof BoardError && lost.reason.status === 409 && lost.reason.code === 'handoff_conflict', 'the other supersession should lose with 409 handoff_conflict')
        const latest = (await ctx.board.thread(root.id)).message.task?.handoff
        check(latest && latest.id !== first.id, 'the task should show a new, distinct handoff')
        same(latest.supersedes, first.id, 'the predecessor of the latest handoff')
        same(latest.commit, won[0]!.value.task?.handoff?.commit, 'the commit of the replacement that won')
        const { events } = await taskFeed(ctx, cursor)
        const history = events.filter((event) => event.type === 'task.handoff' && event.message?.id === root.id).map((event) => (event.payload as { handoff: unknown }).handoff)
        check(canonical(history) === canonical([first, latest]), 'the feed should retain the original handoff and the one replacement, unchanged')
        check(!show(history).includes(claim.token), 'the handoff feed must not reveal the claim token')
        await claim.release()
        await rejects(claim.handoff({ ...handoffPacket, supersedes: latest.id }), 409, 'claim_lost', 'publishing a handoff with a released claim')
      },
    },
    {
      group: 'tasks',
      name: 'opens structured attention through a claim, and the hold cannot be unblocked or settled through the old claim',
      requires: 'task_attention',
      async run(ctx) {
        const { task: root } = await task(ctx, 'conformance: a task to hold for structured attention')
        const supporting = await keep(ctx, ctx.board, () => ctx.board.reply(root.id, 'conformance: the evidence for the request'))
        same((await ctx.board.tasks.attention(root.id)).attention, null, 'attention on a new task')
        const claim = await ctx.board.tasks.claim(root.id, { lease: 60 })
        const draft: AttentionDraft = {
          kind: 'needs_input', question: 'conformance: proceed?', context: 'conformance: request review',
          options: [
            { id: 'go', label: 'Proceed', consequence: 'Resume work', next: 'resume' },
            { id: 'stop', label: 'Stop', consequence: 'Do not continue', next: 'fail' },
          ],
          evidence: [{ message: supporting.id, revision: supporting.revision }],
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), revision: root.revision, commit: 'a'.repeat(40),
        }
        const opened = await ctx.board.tasks.ask(root.id, { ...draft, claim: { epoch: claim.epoch, token: claim.token } })
        isRef(opened.attention.id, 'the request ID')
        same(opened.attention.status, 'pending', 'the new request')
        same(opened.attention.by.actor, ctx.me.actor, 'the requester')
        same(opened.task.task?.state, 'blocked', 'the task with an attention request')
        same(opened.task.task?.attentionId, opened.attention.id, "the task's current request ID")
        same(opened.task.task?.claim, null, 'the claim after it requested attention')
        check(!show(opened).includes(claim.token), 'opening attention should not show the claim token')
        alike((await ctx.board.tasks.attention(root.id)).attention, opened.attention, 'the current request, read back')
        await rejects(claim.complete(), 409, 'claim_lost', 'completing through the claim that requested attention')
        await rejects(ctx.board.tasks.unblock(root.id), 409, 'attention_required', 'unblocking a structured hold')
      },
    },
  ]

  const taskPriorityChecks: Check[] = [
    {
      group: 'tasks',
      name: 'keeps task priority and claims highest priority first, then oldest',
      run: async (ctx) => {
        const labels = { ...ctx.labels, queue: 'priority' }
        const { task: normal } = await task(ctx, 'conformance: default priority', { labels })
        await taskBatch(ctx, [
          { text: 'conformance: low priority', priority: 'low', labels },
          { text: 'conformance: high priority', priority: 'high', labels },
          { text: 'conformance: lowest priority', priority: 'lowest', labels },
          { text: 'conformance: urgent priority', priority: 'urgent', labels },
          { text: 'conformance: urgent priority again', priority: 'urgent', labels },
        ])
        same((await ctx.board.thread(normal.id)).message.task?.priority, 'normal', 'the default priority on a task read')
        const listed = await ctx.board.tasks.list({ channel: ctx.channel, label: Object.entries(labels).map(([key, value]) => `${key}=${value}`) })
        alike(listed.tasks.map(({ message }) => message.task?.priority), ['normal', 'low', 'high', 'lowest', 'urgent', 'urgent'], 'priorities in creation order on the list')
        // Take the IDs from the list, not from the order the batch answered in.
        const [first, low, high, lowest, urgent, laterUrgent] = listed.tasks
        for (const { message } of [urgent!, laterUrgent!, high!, first!, low!, lowest!]) {
          const claim = await ctx.board.tasks.claim({ channel: ctx.channel, label: labels })
          same(claim?.task.id, message.id, 'the next task by priority and age')
          await claim!.complete()
        }
      },
    },
    {
      group: 'tasks',
      name: 'lets task writers set priority and live claims only lower it',
      run: async (ctx) => {
        const { task: root } = await task(ctx, 'conformance: change priority', { priority: 'low' })
        same(root.task?.priority, 'low', 'the priority set on create')
        same((await ctx.board.tasks.priority(root.id, 'high')).task?.priority, 'high', 'the priority raised by the owner')
        const { cursor } = await ctx.board.poll({ channel: ctx.channel })
        const claim = await ctx.board.tasks.claim(root.id)
        await rejects(claim.priority('urgent'), 403, 'priority_raise_forbidden', 'a claim raising priority')
        await rejects(ctx.board.tasks.priority(root.id, 'urgent'), 409, 'task_claimed', 'a claim holder raising priority without proof')
        const lowered = await claim.priority('low')
        same(lowered.task?.priority, 'low', 'the priority lowered by the claim')
        same(lowered.task?.state, 'claimed', 'the task state after lowering priority')
        await claim.release()
        await rejects(claim.priority('lowest'), 409, 'claim_lost', 'a released claim lowering priority')
        same((await ctx.board.thread(root.id)).message.task?.priority, 'low', 'the stored priority after rejected writes')
        const { events } = await ctx.board.poll({ channel: ctx.channel, after: cursor })
        alike(events.flatMap((event) => event.type === 'task.priority_changed' && event.message?.id === root.id ? [[event.payload.priority, event.message.task?.priority]] : []), [['low', 'low']], 'priority changes in the feed')
      },
    },
  ]

  async function finishCleanup(ctx: Context, checks: CheckResult[]) {
    // Delete replies first. Report what stays on the check that made it.
    const staying = new Map<string, string[]>()
    for (const made of [...ctx.posted].reverse()) {
      const why = await deleteMade(made, ctx.board).catch((error: unknown) => `deleting a message this run created: ${requestFailure(error)}`)
      if (why !== null) staying.set(made.check, [...(staying.get(made.check) ?? []), why])
    }
    for (const [running, reasons] of staying) {
      const found = checks.find(({ group, name }) => `${group}/${name}` === running)
      if (found) found.status = 'failed'
      // What already says why it stays isn't said twice.
      const detail = reasons.filter((why) => !found?.detail?.includes(why)).join('; ')
      if (!detail) continue
      if (found) found.detail = found.detail ? `${found.detail}; ${detail}` : detail
      else checks.push({ group: 'core', name: 'deletes only what it created', status: 'failed', detail })
    }
  }

  return {
    finishCleanup,
    keep,
    onMade,
    remove,
    requestFailure,
    NETWORK_PAUSE,
    taskAuthorityChecks,
    taskPriorityChecks,
  }
}
