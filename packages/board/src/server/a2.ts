import type { z } from 'zod'
import { A2Error, idempotentId, reducer } from 'experimental-a2'
import { createServer, type A2Scheduler } from 'experimental-a2/server'
import { boardContract, SCHEDULES_SESSION } from '../contract/contract.ts'
import type { AttentionResponders } from '../contract/attention.ts'
import { BOARD_SESSION } from '../contract/events.ts'
import { createTrust } from './trust.ts'
import { createSchemas } from './schemas.ts'
import { actorsReducer, channelsReducer, identitiesReducer } from '../contract/reducers.ts'
import { type Actor, type ExternalCopy, type Message } from '../contract/folds.ts'
import { importedHandle, shownName, userIdOf } from '../contract/profiles.ts'
import { extractMentions, isEmail, replaceMentions } from '../contract/mentions.ts'
import { ATTACHMENT_BYTES_MAX, ATTACHMENTS_PER_MESSAGE_MAX, MESSAGE_TEXT_MAX, RemoteWatcherId, type Labels } from '../contract/schemas.ts'
import { CHANNELS_LIMIT_DEFAULT, REGISTERED_WATCHERS_MAX, type Discovery, type Me, type ScheduleView } from '../api/routes.ts'
import type { Method, Protocol } from '../api/protocol.ts'
import { FULL_ACCESS, parseCan, type Access, type Permission } from './access.ts'
import { authenticates, type Granted } from './auth.ts'
import { viaOf } from './actors.ts'
import { type Backend, type BackendRoute, type BoardBinding, type Caller, type ProtocolMethods, type SelfCaller, type Trust } from './backend.ts'
import { BoardError } from '../client/client.ts'
import { attachmentBody, attachmentNotFound, finishUpload, ownUpload, readUpload, startUpload, writeUpload, type BlobStore, type Uploader } from './blob.ts'
import { badRequest, duplicateId, forbidden, HttpError, notFound, textTooLong, toErrorResponse } from './errors.ts'
import { eventView, foldEvent, indexOf, lastFeed, loadBefore, OWN_CODE, pollFeed, readableFilter, ref, toMessageFilter, verifiedRecord, view, viewedBy, viewLinkedIds, viaOfRecord } from './feed.ts'
import { createReads, tablesConsumer } from './reads.ts'
import { createdBy, createSchedules, type Schedule } from './schedules.ts'
import { createControl, publicStatus } from './control.ts'
import { createTasks, taskLimits, type WorkLifecycleOptions } from './tasks.ts'
import type { EvidencePolicy } from '../contract/evidence.ts'
import { AccessMoved, appendRefusal, wallTime, writerFor } from '../store/single-writer.ts'
import type { BoardStore, MessageFilter, ThreadPosition } from '../store/types.ts'
import { compileWatcher, createWatchers, ID, registrantSession } from './watch.ts'
import { ack, pull, type QueueSession } from './registered.ts'
import { createRegistry, storedPrincipal } from './registry.ts'
import { METHODS } from './routing.ts'
import { authorizeMessage, authorizeOwn, authorizePost, blindText, untilApplied, whileHeadMoves, trusted, writeChannel, writeChannelSettings, writeIdentity, writeDelete, writeEdit, writeLabels, writePost, writeReaction, writeRoots, landedBatch, deploymentIdentity, landedFor, type Identity, type WriteContext } from './writes.ts'
import type { WriteOrigin } from './origin.ts'
import { derivedId, isKeyIdOf } from '../client/ids.ts'
import { DroppedError, MIDDLEWARE_ACTOR } from './middleware.ts'
import { VERSION } from '../version.ts'

/**
 * The engine behind `local()`, internal: a board on A2's log, and what runs it. Who may use it,
 * and what its writes go through, are board()'s: `board({ authenticate, access, middleware })`.
 */
export type A2Options = {
  /** Where the board keeps its log and tables: `sqlite()` or `memory()` (`store/sqlite.ts`, `store/memory.ts`). */
  store: BoardStore
  /**
   * What gives the board a clock: `localScheduler()` (`scheduler/local.ts`). Without one, the
   * consumers (the tables, watchers) run in the request that writes, a failure is tried again
   * on the next write, and scheduling answers 501 `no_scheduler`. `local()` always passes one.
   */
  scheduler?: A2Scheduler
  /**
   * Where attachments live: `fsBlob()` or `memoryBlob()` (`server/blob.ts`). Without one, the board
   * keeps no files: uploads, and posts that carry them, answer 501 `no_files`. `local()` always passes one.
   */
  blob?: BlobStore
  workLifecycle?: WorkLifecycleOptions
  workEvidence?: EvidencePolicy | undefined
  /** Enables structured attention with a responder allowlist. */
  attentionResponders?: AttentionResponders
}

const boardServer = (options: A2Options) =>
  createServer({
    contract: boardContract,
    store: options.store.log,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  })

export type BoardSession = ReturnType<ReturnType<typeof boardServer>['session']>

/** The board's own code, through its handle: `team.post(…)`. With `as(profile)`, `board:client:<profile>`. */
const CLIENT_ACTOR = 'board:client'

/** A cursor or message ref in a request, as this board's log index: decimals, from 0. */
function cursorAt(value: string): number {
  const index = indexOf(value)
  if (index === null) throw badRequest(`${value} isn't a cursor or a message ID on this board`, 'invalid_cursor')
  return index
}

/** A `/threads` page's `older` on this board: where its oldest thread stands, its latest message's index then its root's. */
const olderRef = (position: ThreadPosition) => `${position.at}.${position.id}`

function olderAt(value: string): ThreadPosition {
  const match = /^(\d{1,15})\.(\d{1,15})$/.exec(value)
  if (!match) throw badRequest(`${value} isn't a page of threads on this board`, 'invalid_cursor')
  return { at: Number(match[1]), id: Number(match[2]) }
}

/** The message a ref in a request names, as its log index, or a 404 for one that names nothing here. */
function messageAt(value: string): number {
  const index = indexOf(value)
  if (index === null || index === 0) throw notFound(`message not found: #${value}`, 'message_not_found')
  return index
}

/**
 * A reply's `after`, as the index of a message. One that isn't one is 0, which names no message:
 * the post refuses it, after a retry that landed gets its reply back.
 */
const afterAt = (value: string | undefined): number | undefined => (value === undefined ? undefined : (indexOf(value) ?? 0))

/**
 * A schedule's ID, `s12`, as its index in session `schedules`. `12` from a client that strips the
 * `s`, and `ss12` from an older CLI that adds one to what this board hands out, name it too.
 */
function scheduleAt(value: string): number {
  const bare = value.replace(/^s{1,2}/, '')
  const index = indexOf(bare)
  if (index === null || index === 0) throw notFound(`schedule not found: s${bare}`, 'schedule_not_found')
  return index
}

/** A signal that never aborts, for what the board does by itself. */
const NEVER = new AbortController().signal

/**
 * `idempotentId`'s shape, a UUIDv8: the IDs the board derives for its own writes (schedule
 * sends, watchers). They're guessable, so an API caller can't post with one and take it first.
 */
const DERIVED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A request to the board, as board() verified it, as opposed to a write the board's own code makes in-process. */
const fromRequest = (caller: Caller) => 'identity' in caller && (caller.origin.via?.kind ?? 'api') === 'api'

/** board()'s own code, as the backend's discovery is asked for it. */
const OWN: SelfCaller = { self: null, origin: { via: { kind: 'client', name: null } } }

/**
 * Who a caller writes as. This deployment's own code writes as `board:client` from a handle,
 * `board:client:<profile>` from `as(profile)`, as `board:watch:<id>` from a watcher, which its
 * own writes never wake, and as `board:middleware` from board()'s middleware.
 */
function selfIdentity(caller: SelfCaller): Identity {
  const identity = ownIdentity(caller)
  if (caller.can === undefined) return identity
  // A handle narrowed with `as(profile, { can })`: what a request narrowed with x-board-can gets.
  const { principal } = identity
  return { ...identity, principal: { ...principal, scope: caller.can, access: principal.access.narrow(parseCan(caller.can)) } }
}

/** Who this deployment's own code is, before a handle's `can` narrows it. */
function ownIdentity(caller: SelfCaller): Identity {
  const { self, origin } = caller
  if (origin.via?.kind === 'watcher') return deploymentIdentity(`board:watch:${self}`, self ?? 'watch')
  if (origin.via?.kind === 'middleware') return deploymentIdentity(MIDDLEWARE_ACTOR, 'middleware')
  if (self === null) return deploymentIdentity(CLIENT_ACTOR, 'client')
  if (!ID.test(self)) throw badRequest(`as: profiles use lowercase letters, numbers, - and _, got: ${self}`)
  return deploymentIdentity(`${CLIENT_ACTOR}:${self}`, self)
}

/** An actor's name as people see it, with who it acts through: `Malte via www (preview)`. */
const shownOf = (actor: Actor | undefined) => (actor ? shownName({ name: actor.name, via: viaOfRecord(actor) }) : undefined)

/** A schedule as its creator sees it where it can't read: its text as a blind writer's message's is. */
const blindSchedule = (schedule: ScheduleView, access: Access, own: string): ScheduleView =>
  access.readable(schedule.channel) ? schedule : { ...schedule, text: blindText(schedule.text, own) }

/** An append that holds an event ID already in the log. */
const duplicate = (error: unknown) => error instanceof A2Error && error.code === 'PARTIAL_DUPLICATE_BATCH'

/** Everything behind a board on the engine, built once board() binds it. Nothing in it connects until it's used. */
function refuseMovedAccess(error: unknown): never {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof AccessMoved) throw new HttpError(409, 'access_changed', cause.message)
  }
  throw appendRefusal(error)
}

function build(options: A2Options, binding: BoardBinding) {
  const blob = options.blob ?? null
  const { store } = options
  // The same A2 store object for every server: A2 recognizes its own stores by identity.
  const log = store.log
  const writer = writerFor(log)
  const registry = createRegistry({ store: log, scheduler: options.scheduler })

  // Keep the verified identity and its scope, not the permissions from request admission.
  async function currentCaller(caller: Caller, now: number): Promise<Caller> {
    if (!('identity' in caller)) return caller
    const { identity } = caller
    const rights = await binding.accessNow(identity.principal, await access.trust.grants(), now)
    if (rights === null) throw forbidden("this token can't use this board")
    return { ...caller, identity: { ...identity, principal: { ...identity.principal, access: rights } } }
  }

  /** The caller as verified for a read, or as refreshed by the writer for a mutation. */
  const identityOf = async (caller: Caller): Promise<Identity> => ('identity' in caller ? caller.identity : selfIdentity(caller))
  const boundClaimIdentity = (caller: Caller, input: { binding?: unknown }) => {
    if (input.binding !== undefined && !('identity' in caller)) throw forbidden('a bound claim needs a verified claimant')
    return identityOf(caller)
  }
  /** Its own code's handle, which reaches it in process. */
  let ownHandle: ReturnType<BoardBinding['handle']> | null = null
  const tails = Object.fromEntries(
    Object.entries(binding.subscriptions).flatMap(([id, subscription]) => (subscription.kind === 'tail' ? [[id, { tail: subscription.tail }]] : [])),
  )
  // Always, since anyone may register watchers here, to pull, at any time.
  const watchers = createWatchers({
    watch: tails,
    run: (id, event, trigger, attempt) => writer.detached(() => binding.run(id, event, { trigger, attempt })),
    store: log,
    scheduler: options.scheduler,
    registered: { state: registry.state, accessNow: (principal) => binding.accessNow(principal) },
  })
  const schedules = createSchedules({ store: log, scheduler: options.scheduler })
  const attentionEnabled = options.attentionResponders !== undefined
  const tasks = createTasks({ store: log, scheduler: options.scheduler, workLifecycle: options.workLifecycle, attentionResponders: options.attentionResponders, workEvidence: options.workEvidence })
  const attentionAt = (id: string) => {
    if (!attentionEnabled) throw new HttpError(501, 'no_task_attention', 'this board does not keep task attention requests')
    return messageAt(id)
  }
  const projection = tablesConsumer(store.tables)

  // The tables and watchers each keep their own place in the board's log.
  const consumers = [projection, watchers.boardConsumer]
  const server = createServer({
    contract: boardContract,
    store: log,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    consumers,
  })
  const session = server.session(BOARD_SESSION)
  const reads = createReads(store.tables, session, projection)
  const work = createControl(log, session, binding.initiallyPaused)
  // Who the board trusts beside its defaults: its grants.
  const access = createTrust({
    store: log,
    // Drop the writer FIFO while a grant append waits on the fence, so a staged
    // append already inside the fence can rejoin the FIFO and finish.
    fence: store.fence && {
      access: (write) => writer.outside(() => store.fence!.access(write)),
      guarded: store.fence.guarded.bind(store.fence),
    },
    clock: writer.time,
    accessNow: (principal, grants) => binding.accessNow(principal, grants, writer.time()),
    explain: (principal, channel) => binding.explain(principal, channel),
    team: async () => (await binding.project()).teamId,
    logins: () => binding.logins,
  })
  const writes: WriteContext = { session, reads, work, writer, fence: store.fence, accessPosition: access.position }

  async function setPaused(caller: Caller, paused: boolean, reason: string) {
    if (!fromRequest(caller) || !('identity' in caller)) throw forbidden('only a person with board-wide manage can change work control')
    const { principal, author } = caller.identity
    if (principal.kind !== 'person' || author.profile !== null || !principal.access.everywhere('manage'))
      throw forbidden('only a person with board-wide manage can change work control')
    return whileHeadMoves(async () => {
      const { status, index } = await work.at()
      if (status.paused === paused) return publicStatus(status)
      const pauseEpoch = status.pauseEpoch + (paused ? 1 : 0)
      const rows = await writer.outside(() => session.append.ifLastIndex(index, { type: 'work.control', payload: { paused, pauseEpoch, reason, by: author } }))
      await untilApplied(writes, rows)
      return { paused, pauseEpoch }
    })
  }

  // The schema registry, in a session of its own beside the board's.
  const schemaRegistry = createSchemas({ store: log })

  // A schedule sends with what its creator may do now, which board()'s `access` says at each send. It
  // posts as its creator, through board(), so the middleware sees it.
  schedules.bind({ writes, accessNow: binding.accessNow, send: async (identity, origin, input) => sendAs(identity, origin, input) })
  tasks.bind({ writes, accessNow: binding.accessNow, accessPosition: access.position })
  watchers.bind({ reads })

  /**
   * Whether `principal` may have a file: one it uploaded, or one a message it
   * can read carries. A deleted message drops its files, so it no longer counts.
   */
  async function attachmentReadable(principal: Granted, id: string, uploader: Uploader) {
    if (principal.access.readsAll || ownUpload(uploader, principal)) return true
    await reads.ensure()
    return (await reads.tables.withAttachment(id)).some((message) => principal.access.readable(message.channel))
  }

  /**
   * `filter`, narrowed to the channels `access` reads among those the log has,
   * and the index that list reflects: a read's cursor goes no further, or the
   * first post in a channel newer than the list would be in neither the page
   * nor the feed after it.
   */
  async function readable(filter: MessageFilter, access: Access): Promise<{ filter: MessageFilter; through: number }> {
    if (access.readsAll) return { filter, through: Number.POSITIVE_INFINITY }
    const { state, index } = await session.state(channelsReducer)
    return { filter: readableFilter(filter, Object.keys(state), access), through: index }
  }

  /** Who wrote, was mentioned by actor ID (`@[actor-id]`), or reacted in the channels `access` reads, a page at a time. */
  async function actorsIn(access: Access): Promise<Set<string>> {
    const ids = new Set<string>()
    const { filter } = await readable({}, access)
    for (let before: number | undefined; ; ) {
      const { messages } = await reads.messages(filter, { limit: 500, ...(before !== undefined ? { before } : {}) })
      for (const message of messages) {
        ids.add(message.by.actor)
        for (const token of extractMentions(message.text)) if (token.kind === 'actor' && !isEmail(token.actor)) ids.add(token.actor)
        for (const reactors of Object.values(message.reactions)) for (const id of reactors) ids.add(id)
      }
      if (messages.length < 500) return ids
      before = messages[0]!.id
    }
  }

  /**
   * The IDs the events of a batch made under `id` carry, as a post's carries its own: each root's post in turn, and the
   * event after the first root, which says what the batch was asked for. A batch is found again by them alone.
   */
  const batchRoot = (id: string, at: number) => derivedId('board-batch', id, String(at))
  const batchAsked = (id: string, request: string) => derivedId('board-batch-request', id, request)

  /** Files a write carries, as the board stored them: each one the caller may have, or 404 as if it didn't exist. */
  const attachmentsFor = (principal: Granted, ids: readonly string[] | undefined) =>
    Promise.all(
      [...new Set(ids ?? [])].map(async (id) => {
        const { attachment, ...uploader } = await readUpload(blob, id)
        if (!(await attachmentReadable(principal, id, uploader))) throw attachmentNotFound(id)
        return attachment
      }),
    )

  /** This board's own limits on a message, which requests leave to the backend. */
  const withinLimits = ({ text, attachments }: { text: string; attachments?: readonly string[] | undefined }) => {
    if (text.length > MESSAGE_TEXT_MAX) throw textTooLong()
    if ((attachments?.length ?? 0) > ATTACHMENTS_PER_MESSAGE_MAX) throw badRequest(`attachments: a message carries at most ${ATTACHMENTS_PER_MESSAGE_MAX}`)
  }

  /** A registrant's queue, in the watch contract: its watchers' matches. */
  const queueOf = (owner: string) => watchers.server.session(registrantSession(owner))

  /**
   * A schedule's send, as its creator, through board(): its middleware sees it as any post. One the
   * middleware drops is a `DroppedError`, as the schedule takes it.
   */
  async function sendAs(identity: Identity, origin: WriteOrigin, input: Parameters<Parameters<typeof schedules.bind>[0]['send']>[2]) {
    const { channel, re, ...rest } = input
    const handle = binding.handle({ identity, origin })
    try {
      return channel !== undefined ? await handle.post(channel, rest) : await handle.reply(re!, rest)
    } catch (error) {
      if (error instanceof BoardError && error.code === 'dropped') throw new DroppedError(error.message === 'the board dropped this message' ? [] : error.message.split('\n'))
      if (error instanceof BoardError && error.code === 'board_paused') throw new HttpError(409, error.code, error.message)
      throw error
    }
  }

  /** Refuses a request's post an ID that's someone else's to post with: the board's own, or another client's key. */
  function ownId(caller: Caller, principal: Granted, id: string | undefined) {
    if (!fromRequest(caller) || id === undefined) return
    if (DERIVED_ID.test(id)) throw badRequest("id: UUIDv8s are the board's own, for the writes it makes itself")
    // A client elsewhere derives its posts' IDs from its key, under its own principal, so no
    // one else can post with one first and make its retry fail.
    if (id.startsWith('key:') && !isKeyIdOf(id, principal.id)) throw badRequest(`id: key:… IDs derive from a client's key, and this token's are key:${principal.id}:…`)
  }

  /** A post as it lands: what the caller may post, with the files it may have. */
  async function postNow(caller: Caller, identity: Identity, parsed: Protocol['post']['input']): Promise<Protocol['post']['output']> {
    const { principal } = identity
    withinLimits(parsed)
    const body = { ...parsed, re: parsed.re === undefined ? undefined : messageAt(parsed.re) }
    const proofs = await authorizePost(writes, principal.access, body)
    ownId(caller, principal, body.id)
    const attachments = await attachmentsFor(principal, body.attachments)
    const { schedule, scheduleEpoch } = caller.origin
    const message = await writePost(writes, {
      attachments,
      identity,
      proofs,
      channel: body.channel,
      re: body.re,
      text: body.text,
      labels: body.labels,
      noSync: body.noSync,
      id: body.id,
      after: afterAt(body.after),
      // A schedule's send, which only this board's own schedules make.
      ...(schedule && caller.origin.via?.kind === 'schedule' ? { schedule, workEpoch: scheduleEpoch } : {}),
    })
    return { message }
  }

  const methods: ProtocolMethods = {
    status: async () => publicStatus((await work.at()).status),
    pause: (caller, { reason }) => setPaused(caller, true, reason),
    resume: (caller, { reason }) => setPaused(caller, false, reason),
    async discovery() {
      // As its own code sees it: board() answers a request with who the board is to it, the URL it
      // reached and the project tokens are minted for. Its own code reaches it in process when
      // nothing says where else.
      const url = binding.url() ?? (ownHandle ??= binding.handle(OWN)).url
      const { id, teamId } = await binding.project()
      const body: Discovery = {
        version: VERSION,
        url,
        audience: url,
        team_id: teamId,
        project_id: id,
        task_claim_hold: true,
        ...(attentionEnabled ? { task_attention: true } : {}),
        ...(options.workLifecycle ? { workLifecycle: 1, ...(store.fence ? { accessFence: 1, accessFenceScope: 'process' } : {}) } : {}),
        task_authority: true,
        ...(tasks.workCapability ? { workEvidence: tasks.workCapability } : {}),
      }
      return body
    },
    async me(caller) {
      const { principal, author, actor } = (await identityOf(caller))
      const body: Me = {
        actor: actor.id,
        principal: principal.id,
        kind: actor.kind,
        handle: actor.handle,
        name: actor.name,
        avatar: actor.avatar,
        profile: author.profile,
        ...(actor.via ? { via: { ...actor.via } } : {}),
        expiresAt: principal.expiresAt?.toISOString() ?? null,
        can: principal.access.summary(),
      }
      return body
    },
    async channels(caller, { prefix, after, limit = CHANNELS_LIMIT_DEFAULT }) {
      const { principal } = (await identityOf(caller))
      const { state, index } = await session.state(channelsReducer)
      // By path, and a page after the last path of the one before it.
      const listed = Object.values(state)
        .filter((channel) => principal.access.readable(channel.path) && (prefix === undefined || channel.path.startsWith(prefix)) && (after === undefined || channel.path > after))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      const channels = listed.slice(0, limit)
      return { channels, cursor: ref(index), next: listed.length > limit ? channels.at(-1)!.path : null }
    },
    async createChannel(caller, { path }) {
      return writeChannel(writes, { identity: await identityOf(caller), path })
    },
    async configureChannel(caller, { path, settings }) {
      return writeChannelSettings(writes, { identity: await identityOf(caller), path, settings })
    },
    async identities(caller) {
      await identityOf(caller)
      const { state } = await session.state(identitiesReducer)
      return { identities: Object.entries(state).map(([key, shown]) => ({ key, ...shown })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) }
    },
    async setIdentity(caller, { key, name, avatar }) {
      return writeIdentity(writes, { identity: await identityOf(caller), key, name, avatar })
    },
    async modelRoutes(caller) {
      await identityOf(caller)
      return { routes: [...(binding.modelRoutes?.() ?? [])] }
    },
    async repositories(caller, { query }, signal) {
      const { principal } = await identityOf(caller)
      if (!principal.access.anywhere('manage')) throw forbidden('finding repositories needs manage in a channel')
      if (!binding.repositories) throw new HttpError(501, 'no_repositories', 'this board was given no Git account')
      return { repositories: await binding.repositories(query, signal) }
    },
    async actors(caller, { id: only }) {
      const { principal, actor } = (await identityOf(caller))
      const { state, index } = await session.state(actorsReducer)
      // A reader of every channel sees everyone; anyone else, who wrote, was mentioned by ID, or reacted where they read, and themselves.
      let seen: ((id: string) => boolean) | null = null
      if (!principal.access.readsAll) {
        const ids = await actorsIn(principal.access)
        ids.add(actor.id)
        seen = (id) => ids.has(id)
      }
      const wanted = only ? new Set(only) : null
      const actors = (wanted ? [...wanted].flatMap((id) => (Object.hasOwn(state.byId, id) ? [state.byId[id]!] : [])) : Object.values(state.byId))
        .filter((a) => seen === null || seen(a.id))
        .sort((a, b) => a.handle.localeCompare(b.handle))
        .map((found) => {
          const { host: _host, via: _via, ...a } = found
          const via = viaOfRecord(found)
          return { ...a, ...(via ? { via } : {}), ...(verifiedRecord(found) ? { verified: true as const } : {}) }
        })
      return { actors, cursor: ref(index) }
    },
    async channelMessages(caller, query) {
      const { principal } = (await identityOf(caller))
      const { state: actors } = await session.state(actorsReducer)
      const { filter, through } = await readable({ channel: { path: query.channel, subtree: false } }, principal.access)
      const limit = query.limit ?? 50
      const { messages, position } = await reads.messages(filter, {
        ...(query.after !== undefined ? { after: cursorAt(query.after) } : {}),
        limit,
      })
      const reader = await reads.reader(principal.access, messages)
      // A page after a cursor that its limit cut short stops at its last message, so reading on from its cursor
      // reaches the rest; any other has all there is, up to where the board is now.
      const stopped = query.after !== undefined && messages.length === limit ? messages.at(-1)!.id : position
      return { messages: messages.map((m) => view(m, actors, reader)), cursor: ref(Math.min(stopped, through)) }
    },
    async threads(caller, query) {
      const { principal, actor } = (await identityOf(caller))
      const { state: actors } = await session.state(actorsReducer)
      const { filter, through } = await readable(toMessageFilter(query, { me: { id: actor.id, handle: actor.handle }, actors, access: principal.access }), principal.access)
      const { threads, position, older } = await reads.threads(filter, {
        ...(query.after !== undefined ? { after: cursorAt(query.after) } : {}),
        ...(query.before !== undefined ? { before: olderAt(query.before) } : {}),
        limit: query.limit ?? 50,
      })
      const reader = await reads.reader(principal.access, threads.flatMap((t) => (t.last ? [t.root, t.last] : [t.root])))
      return {
        threads: threads.map((t) => ({ message: view(t.root, actors, reader), replies: t.replies, last: t.last && view(t.last, actors, reader) })),
        cursor: ref(Math.min(position, through)),
        ...(older !== undefined ? { older: older && olderRef(older) } : {}),
      }
    },
    async message(caller, { id, after, limit }, signal) {
      const { principal } = (await identityOf(caller))
      const at = messageAt(id)
      const message = await reads.message(at, signal)
      if (!message || !principal.access.readable(message.channel)) throw notFound(`message not found: #${at}`, 'message_not_found')
      const [{ messages, cursor }, { state: actors }] = await Promise.all([reads.thread(message.re ?? message.id, signal), session.state(actorsReducer)])
      const [root, ...all] = messages
      // The replies after one of its messages, the first `limit` of them; or with no message, the newest.
      const from = after === undefined ? 0 : messages.findIndex((each) => each.id === messageAt(after))
      if (from === -1) throw new HttpError(400, 'invalid_request', `after: ${after} isn't a message of this thread`)
      const rest = all.slice(from)
      const replies = limit === undefined ? rest : after === undefined ? rest.slice(-limit) : rest.slice(0, limit)
      const reader = await reads.reader(principal.access, messages)
      return {
        message: view(root!, actors, reader),
        replies: replies.map((reply) => view(reply, actors, reader)),
        cursor: ref(cursor),
        schedules: await schedules.forThread(root!.id),
      }
    },
    async posted(caller, { id }, signal) {
      const identity = (await identityOf(caller))
      const landed = await reads.byEventId(id, signal)
      const shown = landed ? await landedFor(writes, identity, landed) : null
      if (!shown) throw notFound(`no post of yours has id ${id}`, 'post_not_found')
      return { message: shown }
    },
    async post(caller, parsed) {
      return postNow(caller, await identityOf(caller), parsed)
    },
    async edit(caller, { id, text, revision }) {
      withinLimits({ text })
      const identity = await identityOf(caller)
      const authorized = await authorizeOwn(writes, identity, messageAt(id), 'edit')
      await writeEdit(writes, { identity, authorized, text, revision })
      return { ok: true as const }
    },
    async delete(caller, { id, revision }) {
      const identity = (await identityOf(caller))
      const authorized = await authorizeOwn(writes, identity, messageAt(id), 'delete')
      await writeDelete(writes, { identity, authorized, revision })
      return { ok: true }
    },
    async react(caller, { id, emoji, remove }) {
      const identity = (await identityOf(caller))
      const authorized = await authorizeMessage(writes, identity.principal.access, 'react', messageAt(id))
      await writeReaction(writes, { identity, authorized, emoji, remove })
      return { ok: true }
    },
    async label(caller, { id, set, unset, if: expected }) {
      const identity = (await identityOf(caller))
      const authorized = await authorizeMessage(writes, identity.principal.access, 'label', messageAt(id))
      await writeLabels(writes, { identity, authorized, set, unset, if: expected })
      return { ok: true }
    },
    async schedule(caller, parsed) {
      withinLimits(parsed)
      const identity = (await identityOf(caller))
      const body = { ...parsed, re: parsed.re === undefined ? undefined : messageAt(parsed.re) }
      // Checked now, where the caller sees it, and again at every send.
      await authorizePost(writes, identity.principal.access, body)
      const attachments = await attachmentsFor(identity.principal, body.attachments)
      return schedules.create(identity, body, attachments)
    },
    async schedules(caller, query) {
      const { principal, actor } = (await identityOf(caller))
      let root: number | undefined
      if (query.re !== undefined) {
        const at = messageAt(query.re)
        root = (await authorizeMessage(writes, principal.access, 'read', at)).message.re ?? at
      }
      const visible = (schedule: Schedule) => principal.access.readable(schedule.channel) || createdBy(schedule, { principal, actor })
      // `me` is the caller, as it is on Vercel's board.
      const by = query.by === 'me' ? actor.id : query.by
      return { schedules: (await schedules.list({ ...query, ...(by !== undefined ? { by } : {}), ...(root !== undefined ? { root } : {}) }, visible)).map((schedule) => blindSchedule(schedule, principal.access, actor.id)) }
    },
    async cancelSchedule(caller, { id }) {
      const identity = await identityOf(caller)
      const answer = await schedules.cancel(identity, scheduleAt(id))
      return { ...answer, schedule: blindSchedule(answer.schedule, identity.principal.access, identity.actor.id) }
    },

    tasks: async (caller, query) => tasks.list(await identityOf(caller), query),
    async createTask(caller, body) {
      // A new thread's root is a message, within what this board holds of one, and a task within what it holds of those.
      if (body.re === undefined) withinLimits({ text: body.text ?? '', attachments: body.attachments })
      taskLimits.needs(body.needs)
      taskLimits.lease(body.lease)
      const identity = await boundClaimIdentity(caller, body)
      const { principal } = identity
      const about = { needs: body.needs, for: body.for, priority: body.priority, claim: body.claim, lease: body.lease, token: body.token, binding: body.binding }
      if (body.re !== undefined) return tasks.adopt(identity, messageAt(body.re), about, caller.origin.claimEpoch)
      // A new thread, posted as any is: `post` where it lands, and `label` for the labels it carries.
      const proofs = await authorizePost(writes, principal.access, { channel: body.channel, labels: body.labels })
      ownId(caller, principal, body.id)
      const made = await tasks.starting(identity, { channel: body.channel!, id: body.id, ...about }, caller.origin.claimEpoch)
      const attachments = await attachmentsFor(principal, body.attachments)
      const task = await writePost(writes, { attachments, identity, proofs, channel: body.channel, text: body.text ?? '', labels: body.labels, noSync: body.noSync, id: body.id, with: made.along, workEpoch: made.workEpoch, onCommit: made.committed })
      // A retry gets back the post that landed with its ID: one that was no task's is another write's.
      if (!task.task) throw duplicateId()
      const claim = await made.claimed(messageAt(task.id))
      return { task, ...(claim ? { claim } : {}) }
    },
    async createTasks(caller, body) {
      // This board's own limits on a batch, and on each task's root as on any message.
      taskLimits.batch(body.tasks)
      for (const [at, task] of body.tasks.entries()) {
        if (task.text.length > MESSAGE_TEXT_MAX) throw textTooLong()
        if ((task.attachments?.length ?? 0) > ATTACHMENTS_PER_MESSAGE_MAX) throw badRequest(`tasks.${at}.attachments: a message carries at most ${ATTACHMENTS_PER_MESSAGE_MAX}`)
      }
      const identity = await identityOf(caller)
      const { principal } = identity
      // New threads, posted as any are: `post` where they land, and `label` when any carries labels.
      const proofs = await authorizePost(writes, principal.access, { channel: body.channel, labels: body.tasks.find((task) => Object.keys(task.labels ?? {}).length > 0)?.labels })
      ownId(caller, principal, body.id)
      const made = tasks.startingMany(identity, body.tasks)
      // A batch's `id` names its roots in order, so a retry finds the ones that landed. They're the board's own IDs, which no request posts with.
      const rootId = (at: number) => (body.id !== undefined ? batchRoot(body.id, at) : Promise.resolve(crypto.randomUUID()))
      const roots = await Promise.all(
        body.tasks.map(async (task, at) => ({ id: await rootId(at), text: task.text, labels: task.labels, noSync: task.noSync, attachments: await attachmentsFor(principal, task.attachments) })),
      )
      // The same `id` again is the same batch only for the same request, as board() gave it: the event after the first
      // root keeps that, in its ID. board() answers a retry before it gets here; two first calls at once meet in the write.
      const { id } = body
      const asked = id !== undefined ? await batchAsked(id, body.request ?? '') : undefined
      const again = id !== undefined && asked !== undefined ? { asked, landed: () => landedBatch(writes, identity, (at) => batchRoot(id, at), asked) } : undefined
      return { tasks: await writeRoots(writes, { identity, proofs, channel: body.channel, roots, with: made, again }) }
    },
    async createdTasks(caller, { id, request }) {
      const identity = await identityOf(caller)
      const found = await landedBatch(writes, identity, (at) => batchRoot(id, at), request !== undefined ? await batchAsked(id, request) : undefined)
      if ('tasks' in found) return found
      // Someone else's batch is none of the caller's, as a post is. Its own, made for another request, is another write's.
      if (found.not === 'asked') throw duplicateId()
      throw notFound(`no batch of yours has id ${id}`, 'batch_not_found')
    },
    async claimReadyTask(caller, body, signal) {
      taskLimits.lease(body.lease)
      taskLimits.from(body.from)
      const identity = await boundClaimIdentity(caller, body)
      return tasks.claimReady(identity, body, signal, (tryClaim) =>
        writer.run(async (now) => tryClaim(await identityOf(await currentCaller(caller, now)))).catch(refuseMovedAccess),
      )
    },
    async claimTask(caller, body) {
      taskLimits.lease(body.lease)
      return tasks.claim(await boundClaimIdentity(caller, body), messageAt(body.id), body, caller.origin.claimEpoch)
    },
    async renewTask(caller, { id, epoch, token, lease }) {
      taskLimits.lease(lease)
      return tasks.renew(await identityOf(caller), messageAt(id), { epoch, token }, lease)
    },
    releaseTask: async (caller, { id, epoch, token }) => tasks.settle(await identityOf(caller), messageAt(id), { epoch, token }, { type: 'task.released' }),
    async completeTask(caller, { id, epoch, token, result, commit }) {
      taskLimits.note('result', result)
      return tasks.settle(await identityOf(caller), messageAt(id), { epoch, token }, { type: 'task.completed', result: result ?? null, commit })
    },
    async failTask(caller, { id, epoch, token, reason }) {
      taskLimits.note('reason', reason)
      return tasks.settle(await identityOf(caller), messageAt(id), { epoch, token }, { type: 'task.failed', reason })
    },
    async blockTask(caller, { id, reason, kind, epoch, token }) {
      taskLimits.note('reason', reason)
      taskLimits.kind(kind)
      return tasks.block(await identityOf(caller), messageAt(id), { reason, kind, ...(epoch !== undefined && token !== undefined ? { proof: { epoch, token } } : {}) })
    },
    requestTaskAttention: async (caller, { id, ...body }) => tasks.requestAttention(await identityOf(caller), attentionAt(id), body),
    taskAttention: async (caller, { id }) => tasks.attention(await identityOf(caller), attentionAt(id)),
    answerTaskAttention: async (caller, { id, requestId, ...body }) => tasks.answerAttention(await identityOf(caller), attentionAt(id), requestId, body, fromRequest(caller)),
    unblockTask: async (caller, { id }) => tasks.unblock(await identityOf(caller), messageAt(id)),
    parkTask: async (caller, { id, reason }) => {
      if (!('identity' in caller)) throw forbidden('parking a task needs a verified person')
      return tasks.park(caller.identity, messageAt(id), reason, 'park')
    },
    unparkTask: async (caller, { id, reason }) => {
      if (!('identity' in caller)) throw forbidden('unparking a task needs a verified person')
      return tasks.park(caller.identity, messageAt(id), reason, 'unpark')
    },
    handoffTask: async (caller, { id, epoch, token, ...packet }) => tasks.handoff(await identityOf(caller), messageAt(id), { epoch, token }, packet),
    reopenTask: async (caller, { id, reason, ifVersion }) => tasks.reopen(await identityOf(caller), messageAt(id), reason, ifVersion),
    scopeTask: async (caller, { id, reason, ifVersion }) => tasks.scope(await identityOf(caller), messageAt(id), reason, ifVersion),
    stageTask: async (caller, { id, stage, reason, ifVersion }) => tasks.stage(await identityOf(caller), messageAt(id), stage, reason, ifVersion),
    assignTask: async (caller, { id, for: actor }) => tasks.assign(await identityOf(caller), messageAt(id), actor),
    setTaskPriority: async (caller, { id, priority, epoch, token }) =>
      tasks.priority(await identityOf(caller), messageAt(id), priority, epoch !== undefined && token !== undefined ? { epoch, token } : undefined),
    async setTaskNeeds(caller, { id, needs }) {
      taskLimits.needs(needs)
      return tasks.needs(await identityOf(caller), messageAt(id), needs)
    },
    async cancelTask(caller, { id, reason }) {
      taskLimits.note('reason', reason)
      return tasks.cancel(await identityOf(caller), messageAt(id), reason)
    },
    workEvidence: async (caller, { id }) => tasks.workEvidence(await identityOf(caller), messageAt(id)),
    submitWork: async (caller, input) => tasks.submitWork(await identityOf(caller), messageAt(input.id), input),
    recordEvidence: async (caller, input) => tasks.recordEvidence(await identityOf(caller), messageAt(input.id), input),
    overrideEvidence: async (caller, input) => tasks.overrideEvidence(await identityOf(caller), messageAt(input.id), input),
    resolveWorkEdge: async (caller, input) => tasks.resolveWorkEdge(await identityOf(caller), messageAt(input.id), input),
    grants: async (caller) => access.grants(await identityOf(caller)),
    createGrant: async (caller, body) => access.createGrant(await identityOf(caller), body),
    createGrants: async (caller, body) => access.createGrants(await identityOf(caller), body),
    updateGrant: async (caller, input) => access.updateGrant(await identityOf(caller), input),
    explain: async (caller, query) => access.explain(await identityOf(caller), query),
    revokeGrant: async (caller, input) => access.revokeGrant(await identityOf(caller), input),
    // Anyone board() let in reads the schemas: they say what anyone posting has to send.
    schemas: async () => schemaRegistry.schemas(),
    schema: async (_caller, input) => schemaRegistry.schema(input),
    createSchema: async (caller, body) => schemaRegistry.createSchema(await identityOf(caller), body),
    async upload(caller, { data, name, type }) {
      const { principal } = (await identityOf(caller))
      // A file is no use until a post carries it, so uploading needs `post` somewhere.
      if (!principal.access.anywhere('post')) throw forbidden("this token can't post anywhere, so it can't upload")
      return { attachment: await writeUpload(blob, { data, name, type, uploadedBy: principal.id }, ATTACHMENT_BYTES_MAX) }
    },
    async uploadStart(caller, { name, type, size }) {
      const { principal } = (await identityOf(caller))
      if (!principal.access.anywhere('post')) throw forbidden("this token can't post anywhere, so it can't upload")
      return startUpload(blob, { name: name ?? null, type: type ?? null, size, uploadedBy: principal.id })
    },
    async uploadFinish(caller, { id }) {
      const { principal } = (await identityOf(caller))
      return { attachment: await finishUpload(blob, id, principal) }
    },
    async attachment(caller, { id }) {
      const { principal } = (await identityOf(caller))
      const { attachment, ...uploader } = await readUpload(blob, id)
      if (!(await attachmentReadable(principal, attachment.id, uploader))) throw attachmentNotFound(attachment.id)
      return { attachment, data: await attachmentBody(blob, attachment.id) }
    },
    async watchers(caller) {
      const { principal } = (await identityOf(caller))
      // Each names a board's URL and tails: all of them only for `manage` in every channel, the caller's own for anyone.
      const all = await registry.list()
      return { watchers: principal.access.everywhere('manage') ? all : all.filter((found) => found.owner === principal.id) }
    },
    async register(caller, body) {
      const { principal } = (await identityOf(caller))
      ownWatchers(principal)
      // A registered watcher sees only what its registrant may read.
      if (!principal.access.anywhere('read'))
        throw forbidden("this token can't read anywhere, so a watcher it registers would see nothing")
      if (Object.keys(body.watch).length > REGISTERED_WATCHERS_MAX)
        throw badRequest(`a registration holds at most ${REGISTERED_WATCHERS_MAX} watchers`, 'too_many_watchers')
      for (const [id, spec] of Object.entries(body.watch)) {
        const name = RemoteWatcherId.safeParse(id)
        if (!name.success) throw badRequest(`watch ${id}: ${name.error.issues[0]!.message}`, 'bad_watcher')
        try {
          compileWatcher(id, spec)
        } catch (error) {
          throw badRequest((error as Error).message, 'bad_watcher')
        }
      }
      return registry.register(storedPrincipal(principal), { watch: body.watch })
    },
    async matches(caller, query, signal) {
      const { principal } = (await identityOf(caller))
      ownWatchers(principal)
      if (!(await registry.state()).byOwner[principal.id]) throw notFound('this token has no watchers registered here', 'no_registration')
      const queue = queueOf(principal.id) as unknown as QueueSession
      const deadline = wallTime() + (query.wait ?? 0) * 1000
      for (let pause = 100; ; pause = Math.min(pause * 2, 1000)) {
        const matches = await writer.run(async (now) => {
          const { principal: { access } } = await identityOf(await currentCaller(caller, now))
          const found = await pull(queue, { access, limit: query.limit ?? 10, now })
          if (found.length === 0) return found
          // Each was made for what its registrant could read when it matched: its links show what it may read now.
          const reader = await reads.readerOf(access, found.flatMap((match) => viewLinkedIds(match.event)))
          return found.map((match) => ({ ...match, event: viewedBy(match.event, reader) }))
        })
        const left = deadline - wallTime()
        if (matches.length > 0 || left <= 0 || signal.aborted) return { matches }
        await new Promise((resolve) => setTimeout(resolve, Math.min(pause, left)))
      }
    },
    async ack(caller, { id, ...body }) {
      const { principal } = (await identityOf(caller))
      ownWatchers(principal)
      const result = await ack(queueOf(principal.id) as unknown as QueueSession, id, body, { now: writer.time() })
      if (result === 'gone') throw notFound(`no match ${id} is waiting for this token`, 'no_match')
      if (result === 'stale') throw new HttpError(409, 'stale_lease', 'that lease ran out, and the match was pulled again')
      return { ok: true }
    },
    async events(caller, query, signal) {
      const { principal, actor } = (await identityOf(caller))
      const after = query.after !== undefined ? cursorAt(query.after) : undefined
      const { state: actors } = await session.state(actorsReducer)
      const feed = { session, reads, after, filters: query, all: query.all ?? false, me: { id: actor.id, handle: actor.handle }, actors, access: principal.access }
      const { events, cursor } = query.last !== undefined ? await lastFeed(feed, query.last, signal) : await pollFeed(feed, (query.wait ?? 0) * 1000, signal)
      return { events, cursor: ref(cursor) }
    },

  }

  /**
   * Refuses a caller narrowed with `x-board-can` (an agent's tool, say): its principal's
   * watchers are one registration, which its project registers and runs with the token it
   * narrowed. A narrowed pull would take matches from it, and a narrowed register replace it.
   */
  function ownWatchers(principal: Granted) {
    if (principal.scope !== undefined) throw forbidden("this token is narrowed with x-board-can: registering and running watchers is its project's job")
  }

  // The watchers' last, where tests and tools look for them.
  const servers = [server, schedules.server, registry.server, tasks.server, watchers.server]
  return {
    methods,
    writer,
    currentCaller,
    schedules,
    work,
    trust: access.trust,
    workCapability: tasks.workCapability,
    /** The scheduler's callback, for every A2 server behind the board. */
    scheduler: options.scheduler
      ? options.scheduler.handler(...servers)
      : async (_request: Request) => toErrorResponse(notFound('this board has no scheduler')),
    servers,
    session,
    store,
  }
}

/**
 * The engine behind `local()`, internal: a board on A2's log, in its store, and optionally with a
 * scheduler and somewhere for files. It's a backend: `local()` passes it to `board({ backend })`,
 * and tests do. It trusts the callers board() verified; what it does outside requests, it asks
 * board()'s policy about and writes through board(). Nothing is built until board() binds it, and
 * nothing connects until the first call.
 */
const serialized: ReadonlySet<Method> = new Set([
  'createChannel', 'post', 'edit', 'delete', 'react', 'label', 'pause', 'resume',
  'schedule', 'cancelSchedule', 'upload',
  'createTask', 'createTasks', 'claimTask', 'renewTask', 'releaseTask', 'completeTask', 'failTask',
  'blockTask', 'unblockTask', 'parkTask', 'unparkTask', 'handoffTask', 'reopenTask', 'scopeTask', 'stageTask', 'assignTask',
  'setTaskNeeds', 'setTaskPriority', 'cancelTask', 'requestTaskAttention', 'answerTaskAttention',
  'submitWork', 'recordEvidence', 'overrideEvidence', 'resolveWorkEdge',
  'createGrant', 'createGrants', 'updateGrant', 'revokeGrant',
  'createSchema', 'register', 'ack',
])

export function a2(options: A2Options) {
  let binding: BoardBinding | null = null
  let built: ReturnType<typeof build> | null = null
  /** What's built, once board() binds it. */
  const now = () => {
    if (!built) throw new Error("this backend isn't serving a board yet: pass it to board({ backend })")
    return built
  }
  const ready = async () => {
    const ran = now()
    await ran.work.ready()
    // The first call on an instance starts the schedules catching up, and doesn't wait.
    ran.writer.detached(() => ran.schedules.catchUp())
    return ran
  }
  const methods = Object.fromEntries(
    METHODS.map((name) => [name, async (caller: Caller, input: never, signal: AbortSignal) => {
      const ran = await ready()
      const invoke = ran.methods[name] as (caller: Caller, input: never, signal: AbortSignal) => Promise<unknown>
      if (!serialized.has(name)) return invoke(caller, input, signal)
      // A queued claim must not acquire work after a pause/resume that invalidated its request.
      if (caller.origin.claimEpoch === undefined && (name === 'claimTask' || (name === 'createTask' && (input as Protocol['createTask']['input']).claim))) {
        const { status } = await ran.work.at()
        caller = { ...caller, origin: { ...caller.origin, claimEpoch: status.pauseEpoch } }
      }
      return ran.writer.run(async (now) => invoke(await ran.currentCaller(caller, now), input, signal))
        .catch(refuseMovedAccess)
    }]),
  ) as unknown as ProtocolMethods
  const backend = {
    ...methods,
    // Everything it answers is the protocol's.
    routes: [] as BackendRoute[],
    // The board lives here: board() lets its people and own deployments in by default.
    keeps: true,
    supportsTaskAuthority: true,
    // Gates or explicit releases both check a commit against the current submission.
    enforcesCommitEvidence: () => now().workCapability !== undefined,
    // Its grants, in its log: board() checks requests against them.
    trust: {
      grants: async () => (await ready()).trust.grants(),
    } satisfies Trust,
    bind(given: BoardBinding) {
      if (binding) throw new Error('this backend already serves a board: create one per board()')
      binding = given
      // It builds now, and connects when it's first used.
      built = build(options, given)
    },
    /** The scheduler's callback. A board without a scheduler answers 404. */
    scheduler: async (request: Request): Promise<Response> => (await ready()).scheduler(request),
    /** The A2 servers behind this board, to share one scheduler with other A2 servers. */
    get servers() {
      return now().servers
    },
    /** For tests and tools. */
    get session() {
      return now().session
    },
    get store() {
      return now().store
    },
  }
  // What tests and tools look at stays out of a spread, so `{ ...a2(), delete }` is a backend too.
  for (const key of ['servers', 'session', 'store']) Object.defineProperty(backend, key, { enumerable: false })
  return backend satisfies Backend
}

export type A2Backend = ReturnType<typeof a2>
