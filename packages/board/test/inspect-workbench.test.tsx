// @vitest-environment happy-dom
import { act } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { createBoardClient, type ProfileOption } from '../src/client/client.ts'
import { shell } from '../src/inspect/shell.ts'
import { slack } from '../src/sync/slack.ts'
import { BOARD_URL, localBoard, personToken } from './harness.ts'
import { deploymentToken } from './tokens.ts'
import { fakePlatform } from './sync-fixtures.ts'

let visit = 0
const browser = (window as unknown as import('happy-dom').Window).happyDOM
const closed = () => Response.json({ error: { code: 'closed', message: 'page closed' } }, { status: 403 })
afterAll(() => vi.unstubAllGlobals())
let root: Root | undefined
let disconnect: (() => Promise<void>) | undefined
let local: ReturnType<typeof localBoard> | undefined
const releaseGates: (() => void)[] = []
const otherBoards: ReturnType<typeof localBoard>[] = []

afterEach(async () => {
  root?.unmount()
  root = undefined
  for (const release of releaseGates.splice(0)) release()
  await disconnect?.()
  for (const board of otherBoards.splice(0)) await board.close()
  vi.useRealTimers()
  disconnect = undefined
  await local?.close()
  local = undefined
  localStorage.clear()
  document.head.replaceChildren()
  document.body.replaceChildren()
})

// Only the browser-to-proxy transport is substituted. The inspector's handle, live feed,
// route components, and the local board processing their requests are real.
async function workbench(options: Parameters<typeof localBoard>[0] = {}) {
  const api = local = localBoard(options)
  const token = await personToken('u_reader', BOARD_URL)
  const as = (profile: ProfileOption = null, can?: string) => createBoardClient({
    url: BOARD_URL, token, profile,
    fetch: (input, init) => {
      const request = new Request(input, init)
      if (can) request.headers.set('x-board-can', can)
      return api.fetch(request)
    },
  })
  const page = new AbortController()
  const streamClosed = Promise.withResolvers<void>()
  let streaming = false
  disconnect = async () => {
    page.abort()
    if (streaming) await streamClosed.promise
  }
  return {
    api, as, client: as(),
    async open(path = '/', options: { profile?: string; can?: string; holdSchedules?: (profile: string | null) => Promise<void> | undefined;
      token?: string; transport?: (request: Request, send: () => Promise<Response>) => Promise<Response>
    } = {}) {
      browser.settings.enableImageFileLoading = false
      browser.setViewport({ width: 1280, height: 900 })
      browser.setURL(`http://inspector-${++visit}.test${path}`)
      const profile = options.profile ? { name: options.profile } : null
      const html = new DOMParser().parseFromString(shell({ token: 'inspector-test', base: '', profile }), 'text/html')
      document.head.replaceChildren(...html.head.querySelectorAll('meta, style'))
      document.body.innerHTML = '<div id="root"></div>'
      const proxy = `${location.origin}/board`
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.url !== proxy && !request.url.startsWith(`${proxy}/`)) return closed()
        const isStream = new URL(request.url).pathname === '/board/events'
        if (page.signal.aborted) {
          // A refusal stops the handle from reconnecting after this tab closes.
          if (isStream) streamClosed.resolve()
          return closed()
        }
        if (isStream) streaming = true
        const headers = new Headers(request.headers)
        headers.set('authorization', `Bearer ${options.token ?? token}`)
        if (options.can) headers.set('x-board-can', options.can)
        const forwarded = new Request(`${BOARD_URL}${request.url.slice(proxy.length)}`, {
          method: request.method, headers, signal: page.signal,
          ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }),
        })
        const send = () => api.fetch(forwarded)
        const response = options.transport ? options.transport(forwarded, send) : send()
        if (options.holdSchedules && request.method === 'GET' && new URL(request.url).pathname === '/board/schedules') {
          const result = await response
          await options.holdSchedules(headers.get('x-board-profile'))
          return result
        }
        return response
      })
      vi.resetModules()
      const { App } = await import('../src/inspect/app/App.tsx')
      const mounted = root = createRoot(document.getElementById('root')!)
      flushSync(() => mounted.render(<App />))
    },
  }
}

function link(text: string, inElement: ParentNode = document) {
  const el = [...inElement.querySelectorAll('a')].find((a) => a.textContent?.trim() === text)
  expect(el, `link: ${text}`).toBeDefined()
  return el!
}

function lane(title: string) {
  const box = [...document.querySelectorAll('main section')].find((section) => section.querySelector('h2')?.textContent === title)
  expect(box, `lane: ${title}`).toBeDefined()
  return box!
}

const mainText = () => document.querySelector('main')?.textContent

it('keeps a focused Handoff in its original lane when another reader claims it', async () => {
  const { api, as, open } = await workbench()
  const { task } = await api.tasks.create('work', { text: 'Review the release' })
  await open()
  const reading = await vi.waitFor(() => link('Review the release', lane('Runnable')))
  reading.focus()
  expect(document.activeElement).toBe(reading)

  await as('worker').tasks.claim(task.id)
  await vi.waitFor(() => {
    const row = link('Review the release', lane('Runnable')).closest('li')!
    expect(row.textContent).toContain('claimed')
    expect(row.textContent).toContain('Held by')
    expect(document.activeElement).toBe(reading)
  })

  link('Presidium').click()
  await vi.waitFor(() => expect(document.querySelector('main h1')?.textContent).toBe('PRESIDIUM'))
  link('Handoffs').click()
  await vi.waitFor(() => expect(link('Review the release', lane('In progress'))).toBeDefined())
})

it('shows a completed task and its result in the Delivered lane', async () => {
  const { api, open } = await workbench()
  const { task } = await api.tasks.create('work', { text: 'Publish the release notes' })
  await (await api.tasks.claim(task.id)).complete('Release notes are live')
  await open()
  await vi.waitFor(() => {
    const delivered = lane('Delivered')
    expect(link('Publish the release notes', delivered)).toBeDefined()
    expect(delivered.textContent).toContain('Delivery: Release notes are live')
  })
})

it('PRESIDIUM shows totals from all task pages', async () => {
  const { api, open } = await workbench()
  // The local protocol caps reads at 200 tasks, so these require three pages.
  for (let offset = 0; offset < 401; offset += 50) {
    await api.tasks.createMany('work', Array.from({ length: Math.min(50, 401 - offset) }, (_, i) => ({ text: `Review item ${offset + i}` })))
  }
  await open('/presidium')
  await vi.waitFor(() => {
    const counts = document.querySelector('main [aria-label="Task counts"]')
    expect(counts?.textContent).toContain('401 ready')
  }, { timeout: 3000 })
})

it('typing over Handoffs focuses the open thread reply', async () => {
  const { api, open } = await workbench()
  const { task } = await api.tasks.create('work', { text: 'Check the build' })
  await open(`/?thread=${task.id}`)
  const reply = await vi.waitFor(() => {
    const field = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="reply to thread…"]')
    expect(field).not.toBeNull()
    return field!
  })
  const overHandoffs = link('Check the build', lane('Runnable'))
  overHandoffs.focus()
  expect(document.activeElement).toBe(overHandoffs)
  overHandoffs.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))
  expect(document.activeElement).toBe(reply)
})

it('renders the author’s initial without loading their supplied avatar', async () => {
  const { as, open } = await workbench()
  const author = as({ name: 'Reviewer', avatar: 'https://images.example.test/avatar.png' })
  await author.post('work', 'The build is green')
  await open('/c/work')
  await vi.waitFor(() => {
    const row = [...document.querySelectorAll('main .message')].find((el) => el.textContent?.includes('The build is green'))
    expect(row?.querySelector('.avatar')?.textContent).toBe('R')
    expect(row?.querySelector('img')).toBeNull()
  })
})

it('renders markdown images as alt-text links, not automatic loads', async () => {
  const { client, open } = await workbench()
  await client.post('work', '![Build chart](https://images.example.test/chart.png)\n\n![Trace][trace]\n\n[![Dashboard icon](https://images.example.test/icon.png)](https://example.test/dashboard)\n\n[trace]: https://images.example.test/trace.png')
  await open('/c/work')
  await vi.waitFor(() => {
    const main = document.querySelector('main')!
    expect(link('Build chart', main).href).toBe('https://images.example.test/chart.png')
    expect(link('Trace', main).href).toBe('https://images.example.test/trace.png')
    expect(link('Dashboard icon', main).href).toBe('https://example.test/dashboard')
    expect(main.querySelector('img')).toBeNull()
  })
})

it('opens Schedules from Settings and cancels a scheduled post', async () => {
  const { client, open } = await workbench()
  await client.schedule('work', { text: 'Tomorrow’s recap', in: '1d' })
  await open('/settings/access')
  const schedules = await vi.waitFor(() => link('schedules'))
  schedules.click()
  const cancel = await vi.waitFor(() => {
    expect(mainText()).toContain('Tomorrow’s recap')
    const button = [...document.querySelectorAll<HTMLButtonElement>('main button')].find((el) => el.textContent === 'cancel')
    expect(button).toBeDefined()
    return button!
  })
  link('#work', cancel.parentElement!).focus()
  cancel.click()
  await vi.waitFor(() => expect(mainText()).toContain('nothing scheduled'))
  link('all').click()
  await vi.waitFor(() => {
    expect(mainText()).toContain('Tomorrow’s recap')
    expect(mainText()).toContain('canceled')
    expect([...document.querySelectorAll('main button')].some((el) => el.textContent === 'cancel')).toBe(false)
  })
})

async function switchProfile(name: string) {
  const trigger = () => document.querySelector<HTMLButtonElement>('button[title="post as"]')!
  trigger().click()
  const item = await vi.waitFor(() => {
    const match = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.trim() === name)
    expect(match).toBeDefined()
    return match!
  })
  item.click()
  await vi.waitFor(() => expect(trigger().textContent).toContain(`as ${name}`))
}

it('clears blind schedules on profile switch and ignores a late list', async () => {
  const { as, open } = await workbench()
  const codexReady = Promise.withResolvers<void>()
  const codex = Promise.withResolvers<void>()
  const grok = Promise.withResolvers<void>()
  // In work each profile can post but not read, so it lists only its own blind schedules.
  const can = '*=read;work=post'
  await as('claude', can).schedule('work', { text: 'Private Claude reminder', in: '1d' })
  await as('codex', can).schedule('work', { text: 'Private Codex reminder', in: '1d' })
  await as('grok', can).schedule('work', { text: 'Private Grok reminder', in: '1d' })
  await open('/settings/schedules', {
    profile: 'claude', can,
    holdSchedules: (profile) => {
      if (profile === 'codex') {
        codexReady.resolve()
        return codex.promise
      }
      if (profile === 'grok') return grok.promise
    },
  })
  try {
    await vi.waitFor(() => expect(mainText()).toContain('Private Claude reminder'))
    await switchProfile('codex')
    expect(mainText()).not.toContain('Private Claude reminder')
    expect(mainText()).toContain('loading…')

    await codexReady.promise
    await switchProfile('grok')
    await act(async () => codex.resolve())
    expect(mainText()).not.toContain('Private Codex reminder')
    expect(mainText()).toContain('loading…')

    grok.resolve()
    await vi.waitFor(() => {
      expect(mainText()).toContain('Private Grok reminder')
      expect(mainText()).not.toContain('Private Claude reminder')
      expect(mainText()).not.toContain('Private Codex reminder')
    })
  } finally {
    codex.resolve()
    grok.resolve()
  }
})

it('offers Cancel only to the schedule creator or a channel manager', async () => {
  const { as, open } = await workbench()
  const creator = as('claude')
  const thread = await creator.post('work', 'Release review')
  await creator.schedule({ re: thread.id }, { text: 'Review tomorrow', in: '1d' })
  await creator.schedule('managed', { text: 'Send status', in: '1d' })
  await creator.schedule('readonly', { text: 'Post results', in: '1d' })
  await open('/settings/schedules', { profile: 'codex', can: '*=read,post;managed=read,post,manage;readonly=read' })
  const cancel = (text: string) => {
    const row = [...document.querySelectorAll('main .sched-row')].find((el) => el.textContent?.includes(text))
    expect(row, text).toBeDefined()
    return row!.querySelector('button')?.textContent
  }
  await vi.waitFor(() => {
    expect(cancel('Review tomorrow')).toBeUndefined()
    expect(cancel('Send status')).toBe('cancel')
    expect(cancel('Post results')).toBeUndefined()
  })
  link('reply in #work').click()
  const threadCancel = () => {
    const scheduled = [...document.querySelectorAll('aside[aria-label="Thread"] dd')].find((el) => el.textContent?.includes('Review tomorrow'))
    expect(scheduled).toBeDefined()
    return scheduled!.querySelector('button')?.textContent?.trim()
  }
  await vi.waitFor(() => expect(threadCancel()).toBeUndefined())
  await switchProfile('claude')
  await vi.waitFor(() => {
    expect(cancel('Review tomorrow')).toBe('cancel')
    expect(cancel('Post results')).toBeUndefined()
    expect(threadCancel()).toBe('cancel')
  })
})

it('opens Sync from Settings and shows the selected inbox', async () => {
  const { adapter } = fakePlatform('slack')
  const { api, open } = await workbench({ sync: { alerts: slack({ adapter }, () => {}), support: slack({ adapter }, () => {}) } })
  const inbound = await api.fetch(new Request(`${BOARD_URL}/webhooks/support`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'Can someone check my invoice?', user: 'U_ADA' }),
  }))
  expect(inbound.ok).toBe(true)
  await open('/settings/access')
  const sync = await vi.waitFor(() => link('sync'))
  sync.click()
  const support = await vi.waitFor(() => link('support slack'))
  support.click()
  await vi.waitFor(() => expect(mainText()).toContain('Can someone check my invoice?'))
})

const responders = { work: ['vercel:user:u_reader'] }
const commit = 'a'.repeat(40)
const question = '<img src=x onerror=alert(1)>'
const staleWords = 'the attention request or its snapshot is no longer current'
const unsupportedWords = 'this board does not keep task attention requests'
const readOnlyWords = 'answering needs a person acting as themselves with post access'
const inboxLink = () => document.querySelector<HTMLAnchorElement>('a[href="/attention"]')!
const inboxCount = () => inboxLink().querySelector('.count')?.textContent
const attentionList = () => document.querySelector<HTMLElement>('[aria-label="attention requests"]')!
const decision = (id: string) => document.getElementById(`attention-${id}`)!
const choice = (id: string) => decision(id)?.querySelector<HTMLButtonElement>('button.attention-choice')
const selectedDecision = () => attentionList().querySelector('[aria-current="true"]')?.id
const attentionRead = (r: Request) => r.method === 'GET' && r.url.endsWith('/attention')
const answerWrite = (r: Request) => r.method === 'POST' && r.url.endsWith('/answer')
const isFeed = (r: Request) => {
  const url = new URL(r.url)
  return url.pathname.endsWith('/events') && Number(url.searchParams.get('wait')) > 0
}
const gate = () => {
  const g = Promise.withResolvers<void>()
  releaseGates.push(g.resolve)
  return g
}

async function hold(client: ReturnType<typeof createBoardClient>, text: string, question: string) {
  const { task } = await client.tasks.create('work', { text })
  const draft = {
    kind: 'awaiting_approval', question, context: 'The wording has been reviewed.',
    options: [
      { id: 'ship', label: 'Ship it', consequence: 'Publish the revised docs', next: 'resume' },
      { id: 'stop', label: 'Stop', consequence: 'Keep the current docs', next: 'fail' },
    ],
    evidence: [{ message: task.id, revision: task.revision }], revision: task.revision, commit,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as const
  const request = { ...draft, options: [...draft.options], evidence: [...draft.evidence] }
  const { attention } = await client.tasks.ask(task.id, request)
  return { id: task.id, attention, request }
}

function press(target: HTMLElement, key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  flushSync(() => target.dispatchEvent(event))
  return event.defaultPrevented
}

it('opens Attention from the sidebar, counts only holds, escapes questions, and applies each allowed read as it arrives', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  await client.tasks.create('work', { text: 'A ready task' })
  const a = await hold(client, 'First draft', question)
  const b = await hold(client, 'Second draft', 'Use the second draft?')
  const release = gate()
  const reads: string[] = []
  await open('/', { transport: async (r, send) => {
    const response = await send()
    if (attentionRead(r)) {
      reads.push(r.url)
      if (r.url.endsWith(`/${a.id}/attention`)) await release.promise
    }
    return response
  } })
  await vi.waitFor(() => expect(inboxCount()).toBe('2'))
  expect(reads).toEqual([])
  inboxLink().click()
  await vi.waitFor(() => expect(choice(b.id)?.disabled).toBe(false))
  expect(location.pathname).toBe('/attention')
  expect(inboxLink().getAttribute('aria-current')).toBe('page')
  expect(decision(a.id).textContent).toContain('reading request')
  expect([...attentionList().querySelectorAll('article')].map((row) => row.id)).toEqual([`attention-${a.id}`, `attention-${b.id}`])
  release.resolve()
  await vi.waitFor(() => expect(decision(a.id).querySelector('.attention-question')?.textContent).toBe(question))
  expect(decision(a.id).querySelector('img')).toBeNull()
  decision(a.id).querySelector('a')!.click()
  await vi.waitFor(() => expect(document.querySelector('aside[aria-label="Thread"]')?.textContent).toContain('First draft'))
  expect([...document.querySelectorAll('aside[aria-label="Thread"] button')].some((button) => button.textContent === 'unblock')).toBe(false)
  expect(reads).toHaveLength(2)
  link('Handoffs').click()
  const c = await hold(client, 'Third draft', 'Use the third draft?')
  await vi.waitFor(() => expect(inboxCount()).toBe('3'))
  expect(reads).toHaveLength(2)
  inboxLink().click()
  await vi.waitFor(() => expect(choice(c.id)?.disabled).toBe(false))
  const d = await hold(client, 'Fourth draft', 'Use the fourth draft?')
  await vi.waitFor(() => expect(choice(d.id)?.disabled).toBe(false))
})

it('lets j/k from the focused empty Attention list reach the open thread composer', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const { task } = await client.tasks.create('work', { text: 'Check the title' })
  await open(`/attention?thread=${task.id}`)
  const reply = await vi.waitFor(() => {
    const field = document.querySelector<HTMLTextAreaElement>('textarea[data-composer="thread"]')
    expect(field).not.toBeNull()
    return field!
  })
  expect(inboxCount()).toBeUndefined()
  for (const key of ['j', 'k']) {
    attentionList().focus()
    expect(press(attentionList(), key)).toBe(false)
    expect(document.activeElement).toBe(reply)
  }
})

it('consumes only real moves and enabled digits, and requires reselection after a replacement or removal', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use the first draft?')
  const b = await hold(client, 'Second draft', 'Use the second draft?')
  await open('/attention')
  await vi.waitFor(() => expect(choice(b.id)?.disabled).toBe(false))
  const list = attentionList()
  list.focus()
  expect(press(list, '1')).toBe(false)
  expect(press(list, 'j')).toBe(true)
  expect(selectedDecision()).toBe(`attention-${a.id}`)
  expect(press(list, 'k')).toBe(false)
  expect(press(list, 'j')).toBe(true)
  expect(selectedDecision()).toBe(`attention-${b.id}`)
  expect(press(list, '3')).toBe(false)
  choice(b.id)!.focus()
  expect(press(choice(b.id)!, '1')).toBe(false)
  expect(press(list, '1')).toBe(false)
  list.focus()
  await client.tasks.ask(b.id, { ...b.request, question: 'Use the replacement?', replaces: b.attention.id })
  await vi.waitFor(() => expect(decision(b.id).textContent).toContain('Use the replacement?'))
  expect(selectedDecision()).toBeUndefined()
  expect(press(list, '1')).toBe(false)
  expect(press(list, 'k')).toBe(true)
  expect(selectedDecision()).toBe(`attention-${b.id}`)
  expect(press(list, '2')).toBe(true)
  await vi.waitFor(() => expect(decision(b.id).textContent).toContain('answered · Stop'))
  expect((await client.tasks.attention(b.id)).attention).toMatchObject({ status: 'answered', receipt: { option: 'stop' } })
  expect(selectedDecision()).toBeUndefined()
  expect(press(list, '1')).toBe(false)
  expect(inboxCount()).toBe('1')
  expect(press(list, 'j')).toBe(true)
  await client.tasks.cancel(a.id, 'superseded')
  await vi.waitFor(() => expect(decision(a.id)).toBeNull())
  expect(selectedDecision()).toBeUndefined()
  expect(inboxCount()).toBeUndefined()
})

it.each(['profile', 'deployment', 'read only', 'no discovery'] as const)('explains why Attention is read only with %s', async (identity) => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  await open('/attention', {
    ...(identity === 'profile' ? { profile: 'reviewer' } : {}),
    ...(identity === 'deployment' ? { token: await deploymentToken('marketing', 'prj_marketing', 'production', { audience: BOARD_URL }) } : {}),
    ...(identity === 'read only' ? { can: '*=read' } : {}),
    transport: async (r, send) => {
      const response = await send()
      if (identity !== 'no discovery' || r.url.replace(/\/$/, '') !== BOARD_URL) return response
      const { task_attention: _, ...discovery } = await response.json()
      return Response.json(discovery)
    },
  })
  await vi.waitFor(() => expect(decision(a.id)?.textContent).toContain(`read only: ${identity === 'no discovery' ? unsupportedWords : readOnlyWords}`))
  expect(decision(a.id).textContent).toContain('Use this draft?')
  expect(choice(a.id)).toBeNull()
  attentionList().focus()
  expect(press(attentionList(), 'j')).toBe(true)
  expect(press(attentionList(), '1')).toBe(false)
})

it.each([403, 409] as const)('shows the board’s %i write refusal without an extra read', async (status) => {
  const { client, open } = await workbench({ attentionResponders: status === 403 ? { work: ['vercel:user:u_other'] } : responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  let reads = 0
  const answer = Promise.withResolvers<number>()
  await open('/attention', { transport: async (r, send) => {
    const response = await send()
    if (attentionRead(r)) reads++
    if (answerWrite(r)) answer.resolve(response.status)
    return response
  } })
  await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
  if (status === 409) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(a.attention.expiresAt) + 1)
  }
  choice(a.id)!.click()
  expect(await answer.promise).toBe(status)
  await vi.waitFor(() => expect(decision(a.id).textContent).toContain(status === 409 ? staleWords : 'only a configured responder acting as themselves with read and post access can answer task attention'))
  expect(decision(a.id).textContent).not.toContain('answering')
  expect(choice(a.id)?.disabled).toBe(true)
  expect(reads).toBe(1)
})

it.each(['read', 'write'] as const)('shows a real 501 on %s and offers no answer', async (operation) => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const unsupported = localBoard()
  otherBoards.push(unsupported)
  const a = await hold(client, 'First draft', 'Use this draft?')
  const refused = Promise.withResolvers<number>()
  await open('/attention', { transport: async (r, send) => {
    if (!(operation === 'read' ? attentionRead(r) : answerWrite(r))) return send()
    const response = await unsupported.fetch(r)
    refused.resolve(response.status)
    return response
  } })
  if (operation === 'write') {
    await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
    choice(a.id)!.click()
  }
  expect(await refused.promise).toBe(501)
  await vi.waitFor(() => expect(decision(a.id)?.textContent).toContain(unsupportedWords))
  expect(choice(a.id)).toBeNull()
})

it('flags an unseen 404 off-view, renders its words, then unlocks the same request on navigation refresh', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const empty = localBoard({ attentionResponders: responders })
  otherBoards.push(empty)
  const a = await hold(client, 'First draft', 'Use this draft?')
  const writing = Promise.withResolvers<number>()
  const releaseWrite = gate()
  const releaseRead = gate()
  let reads = 0
  await open('/attention', { transport: async (r, send) => {
    if (answerWrite(r)) {
      const response = await empty.fetch(r)
      writing.resolve(response.status)
      await releaseWrite.promise
      return response
    }
    const response = await send()
    if (attentionRead(r) && ++reads === 2) await releaseRead.promise
    return response
  } })
  await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
  choice(a.id)!.click()
  expect(await writing.promise).toBe(404)
  link('Handoffs').click()
  await vi.waitFor(() => expect(location.pathname).toBe('/'))
  releaseWrite.resolve()
  await vi.waitFor(() => expect(inboxLink().textContent).toContain('refused'))
  expect(reads).toBe(1)
  inboxLink().click()
  await vi.waitFor(() => expect(decision(a.id)?.textContent).toContain(`message not found: #${a.id}`))
  await vi.waitFor(() => expect(inboxLink().textContent).not.toContain('refused'))
  expect(choice(a.id)?.disabled).toBe(true)
  releaseRead.resolve()
  await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
  expect((await client.tasks.attention(a.id)).attention?.id).toBe(a.attention.id)
})

it.each(['feed', 'thread'] as const)('clears an unseen refusal for A when a newer %s root shows B, even if the attention read fails', async (source) => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const empty = localBoard({ attentionResponders: responders })
  otherBoards.push(empty)
  const a = await hold(client, 'Draft for review', 'Use A?')
  const beforeAnswer = gate()
  const feed = gate()
  const writing = Promise.withResolvers<number>()
  const refusedRead = Promise.withResolvers<string>()
  const listed = gate()
  let replace = false
  await open('/attention', { transport: async (r, send) => {
    if (source === 'thread' && isFeed(r)) await feed.promise
    if (answerWrite(r)) {
      await beforeAnswer.promise
      const response = await (source === 'feed' ? empty.fetch(r) : send())
      writing.resolve(response.status)
      return response
    }
    if (replace && attentionRead(r)) {
      const response = await empty.fetch(r)
      refusedRead.resolve((await response.clone().json()).error.message)
      return response
    }
    const response = await send()
    if (r.method === 'GET' && new URL(r.url).pathname.endsWith('/tasks') && new URL(r.url).searchParams.get('state') === 'all') listed.resolve()
    return response
  } })
  await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
  choice(a.id)!.click()
  link('Handoffs').click()
  const thread = await vi.waitFor(() => link('Draft for review', lane('Needs attention')))
  await listed.promise
  const replaceA = () => client.tasks.ask(a.id, { ...a.request, question: 'Use B?', replaces: a.attention.id })
  // Until an accepted root shows B, the refused write belongs to the A the page saw.
  if (source === 'thread') await replaceA()
  beforeAnswer.resolve()
  expect(await writing.promise).toBe(source === 'thread' ? 409 : 404)
  await vi.waitFor(() => expect(inboxLink().textContent).toContain('refused'))
  if (source === 'thread') thread.click()
  else await replaceA()
  await vi.waitFor(() => expect(inboxLink().textContent).not.toContain('refused'))
  replace = true
  inboxLink().click()
  const words = await refusedRead.promise
  await vi.waitFor(() => expect(decision(a.id)?.textContent).toContain(words))
  expect(decision(a.id).textContent).not.toContain(staleWords)
  expect(inboxLink().textContent).not.toContain('refused')
})

it.each(['before', 'after'] as const)('ignores a superseded read that arrives %s the newer response', async (order) => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  const pending = [0, 1].map(() => ({ captured: gate(), release: gate() }))
  let reads = 0
  await open('/attention', { transport: async (r, send) => {
    const response = await send()
    if (attentionRead(r)) {
      const read = pending[reads++]!
      read.captured.resolve()
      await read.release.promise
    }
    return response
  } })
  await pending[0]!.captured.promise
  link('Handoffs').click()
  await vi.waitFor(() => expect(location.pathname).toBe('/'))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse(a.attention.expiresAt) + 1)
  inboxLink().click()
  await pending[1]!.captured.promise
  if (order === 'before') {
    await act(async () => pending[0]!.release.resolve())
    expect(decision(a.id).textContent).toContain('reading request')
  }
  pending[1]!.release.resolve()
  await vi.waitFor(() => expect(decision(a.id).textContent).toContain('read only: the request is stale'))
  await act(async () => pending[0]!.release.resolve())
  expect(decision(a.id).textContent).toContain('read only: the request is stale')
})

it('keeps the answering overlay after HTTP success until the real feed confirms', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  const feed = gate()
  const answer = Promise.withResolvers<number>()
  await open('/attention', { transport: async (r, send) => {
    if (isFeed(r)) await feed.promise
    const response = await send()
    if (answerWrite(r)) answer.resolve(response.status)
    return response
  } })
  await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
  choice(a.id)!.click()
  expect(await answer.promise).toBe(200)
  expect((await client.tasks.attention(a.id)).attention?.status).toBe('answered')
  expect(decision(a.id).textContent).toContain('answering Ship it')
  expect(choice(a.id)?.disabled).toBe(true)
  expect(inboxCount()).toBe('1')
  feed.resolve()
  await vi.waitFor(() => expect(decision(a.id).textContent).toContain('answered · Ship it'))
  expect(inboxCount()).toBeUndefined()
})
