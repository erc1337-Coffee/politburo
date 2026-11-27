// @vitest-environment happy-dom
import { act } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { createBoardClient, type ProfileOption } from '../src/client/client.ts'
import { shell } from '../src/inspect/shell.ts'
import { BOARD_URL, localBoard, personToken } from './harness.ts'
import { deploymentToken, localUserToken } from './tokens.ts'

let visit = 0
const browser = (window as unknown as import('happy-dom').Window).happyDOM
const closed = () => Response.json({ error: { code: 'closed', message: 'page closed' } }, { status: 403 })
const routePath = (request: Request) => new URL(request.url.slice(BOARD_URL.length), 'http://board.test').pathname
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
    async open(path = '/', options: {
      profile?: string; named?: boolean; can?: string; width?: number; token?: string
      holdSchedules?: (profile: string | null) => Promise<void> | undefined
      proxy?: (request: Request, forward: (request: Request) => Promise<Response>) => Promise<Response>
      transport?: (request: Request, send: () => Promise<Response>) => Promise<Response>
    } = {}) {
      browser.settings.enableImageFileLoading = false
      browser.setViewport({ width: options.width ?? 1280, height: 900 })
      browser.setURL(`http://inspector-${++visit}.test${path}`)
      const profile = options.profile ? { name: options.profile } : null
      const html = new DOMParser().parseFromString(shell({ token: 'inspector-test', base: '', profile, named: options.named ?? false }), 'text/html')
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
        const outbound = new Request(`${BOARD_URL}${request.url.slice(proxy.length)}`, {
          method: request.method, headers, signal: AbortSignal.any([page.signal, request.signal]),
          ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }),
        })
        const forward = (outbound: Request) => options.proxy ? options.proxy(outbound, api.fetch) : api.fetch(outbound)
        const response = options.transport ? options.transport(outbound, () => forward(outbound)) : forward(outbound)
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

const workRows = (inElement?: ParentNode) => [...(inElement ?? document.querySelector('main')!).querySelectorAll<HTMLElement>('li[data-work-row]')]
const workTitles = (inElement?: ParentNode) => workRows(inElement).map((row) => row.querySelector('a')?.textContent)

it('shows a scheduled reply time relatively with its local timestamp on hover', async () => {
  const { client, open } = await workbench()
  const { id } = await client.post('work', 'Scheduled discussion')
  const { next } = await client.schedule({ re: id }, { text: 'Check the thread later', in: '2h' })
  expect(next).not.toBeNull()
  vi.setSystemTime(Date.parse(next!) - 7_200_000)
  await open(`/c/work?thread=${id}`)
  await vi.waitFor(() => {
    const time = threadPane()?.querySelector(`.thread-facts time[datetime="${next}"]`)
    expect(time?.textContent).toBe('in 2h')
    expect(time?.getAttribute('title')).toBe(new Date(next!).toLocaleString())
  })
})

it('shortens head and commit labels with the full hashes on hover', async () => {
  const { client, open } = await workbench()
  const head = 'abcdef0123456789abcd'.repeat(2)
  const commit = '01234567'.repeat(8)
  await client.post('work', { text: 'Review the head', labels: { head, commit, other: head } })
  await open('/c/work')
  await vi.waitFor(() => {
    expect(mainText()).toContain('head=abcdef0')
    expect(mainText()).toContain('commit=0123456')
    expect(mainText()).toContain(`other=${head}`)
    expect(document.querySelector(`main [title="${head}"]`)?.textContent).toBe('abcdef0')
    expect(document.querySelector(`main [title="${commit}"]`)?.textContent).toBe('0123456')
  })
})

it('shows a grouped message time relatively with its local timestamp on hover', async () => {
  const { client, open } = await workbench()
  await client.post('work', 'First update')
  const grouped = await client.post('work', 'Second update')
  vi.setSystemTime(Date.parse(grouped.createdAt) + 75_000)
  await open('/c/work')
  const row = await vi.waitFor(() => {
    const message = [...document.querySelectorAll('main .message')].find((el) => el.textContent?.includes('Second update'))
    expect(message).toBeDefined()
    return message!
  })
  row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await vi.waitFor(() => {
    const time = row.querySelector('.gutter time')
    expect(time?.textContent).toBe('1m')
    expect(time?.getAttribute('datetime')).toBe(grouped.createdAt)
    expect(time?.getAttribute('title')).toBe(new Date(grouped.createdAt).toLocaleString())
  })
})

it('shows an older day divider relatively with the local timestamp on hover', async () => {
  const { client, open } = await workbench()
  const { createdAt } = await client.post('work', 'Earlier update')
  const now = new Date(createdAt)
  now.setDate(now.getDate() + 3)
  vi.setSystemTime(now)
  await open('/c/work', { token: await personToken('u_reader', BOARD_URL) })
  await vi.waitFor(() => {
    const divider = document.querySelector('main .divider')
    expect(divider?.textContent).toBe('3d ago')
    expect(divider?.getAttribute('title')).toBe(new Date(createdAt).toLocaleString())
  })
})

it('shows loading before the empty Inbox sentence on an empty board', async () => {
  const { open } = await workbench()
  const listed = Promise.withResolvers<void>()
  releaseGates.push(() => listed.resolve())
  await open('/', { transport: async (request, send) => {
    if (routePath(request) === '/tasks') await listed.promise
    return send()
  } })
  await vi.waitFor(() => {
    expect(document.querySelector('main h1')?.textContent).toBe('Inbox')
    expect(mainText()).toContain('loading…')
    expect(mainText()).not.toContain('nothing needs you')
  })
  listed.resolve()
  await vi.waitFor(() => expect(mainText()).toContain('nothing needs you'))
})

it('renders Inbox questions and lapsed claims with thread links, and leaves ready work out', async () => {
  const { client, as, open } = await workbench({ attentionResponders: responders })
  const { id: decisionId } = await hold(client, 'Approve wording', 'Ship it?')
  const { task: lapsed } = await client.tasks.create('work', { text: 'Overdue urgent', priority: 'urgent' })
  const lease = await client.tasks.claim(lapsed.id, { lease: 30 })
  const worker = as('worker')
  const { task: stalled } = await client.tasks.create('work', { text: 'Overdue assigned', for: (await worker.me()).actor })
  const stalledLease = await worker.tasks.claim(stalled.id, { lease: 30 })
  await client.tasks.create('work', { text: 'Normal work' })
  await client.tasks.create('work', { text: 'High work', priority: 'high' })
  vi.setSystemTime(Math.max(Date.parse(lease.until), Date.parse(stalledLease.until)) + 12 * 60_000)
  await open()
  await vi.waitFor(() => {
    expect([...document.querySelectorAll('main section h2')].map((heading) => heading.textContent)).toEqual(['Questions', 'Repair or reconcile'])
    expect(decision(decisionId).querySelector('a')?.getAttribute('href')).toBe(`/?thread=${decisionId}`)
    const repair = lane('Repair or reconcile')
    expect(workTitles(repair)).toEqual(['Overdue urgent', 'Overdue assigned'])
    expect(link('Overdue assigned', repair).getAttribute('href')).toBe(`/?thread=${stalled.id}`)
    expect(link('Overdue urgent').closest('li')?.textContent).toContain('claim lapsed 12m ago')
  })
  expect(mainText()).not.toContain('Normal work')
  expect(mainText()).not.toContain('High work')
})

it('removes a revoked Inbox question after the list omits it', async () => {
  const { api, open } = await workbench({ attentionResponders: responders })
  const target = { kind: 'project' as const, project: 'prj_reader' }
  const token = await deploymentToken('dpl_reader', target.project, 'production')
  await api.revokeGrant('g2')
  const { grant } = await api.createGrant({ principals: [target], can: { work: 'all' } })
  await api.createGrant({ principals: [target], can: { keep: 'all' } })
  const viewer = createBoardClient({ url: BOARD_URL, token, profile: null, fetch: (input, init) => api.fetch(new Request(input, init)) })
  const { id } = await hold(viewer, 'Private queue', 'Continue?')
  await open('/', { token })
  await vi.waitFor(() => expect(decision(id)?.textContent).toContain('Private queue'))
  await api.revokeGrant(grant.id)
  await vi.waitFor(() => expect(viewer.thread(id)).rejects.toMatchObject({ status: 404 }))
  leaveInbox()
  await vi.waitFor(() => expect(location.pathname).toBe('/c/work'))
  inboxLink().click()
  await vi.waitFor(() => {
    expect(mainText()).toContain('nothing needs you')
    expect(mainText()).not.toContain('Private queue')
  })
})

const taskRead = { timeout: 5000 }

async function revocableTasks() {
  const bench = await workbench()
  const { api, client } = bench
  const admin = createBoardClient({ url: BOARD_URL, token: await localUserToken('julian', BOARD_URL), fetch: (input, init) => api.fetch(new Request(input, init)) })
  const { task: secret } = await admin.tasks.create('secret', { text: 'Private task' })
  const { task: publicTask } = await client.tasks.create('work', { text: 'Shared task' })
  await admin.createGrant({ principals: [{ kind: 'everyone' }], can: { secret: [] } })
  const { grant } = await admin.createGrant({ principals: [{ kind: 'user', userId: 'u_reader' }], can: { secret: ['read', 'react'] } })
  return { ...bench, admin, secret, publicTask, revoke: () => admin.revokeGrant(grant.id) }
}

it('keeps a live reply out of the pane until its own read accepts it, without interrupting a draft', async () => {
  const { client, open } = await workbench()
  const { task } = await client.tasks.create('work', { text: 'Discuss the release' })
  const reading = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  releaseGates.push(release.resolve)
  let hold = false
  await open(`/?thread=${task.id}`, { proxy: async (request, forward) => {
    const response = await forward(request)
    if (hold && routePath(request) === `/messages/${task.id}`) {
      reading.resolve()
      await release.promise
    }
    return response
  } })
  const { pane, draft } = await vi.waitFor(() => {
    const pane = document.querySelector('aside[aria-label="Thread"]')
    const draft = pane?.querySelector('textarea')
    expect(pane?.textContent).toContain('Discuss the release')
    expect(draft).toBeDefined()
    return { pane: pane!, draft: draft! }
  }, taskRead)
  draft.focus()
  await act(async () => typeInto(draft, 'A reply in progress'))
  hold = true
  await client.reply(task.id, 'A reply on the board')
  await reading.promise
  expect(pane.textContent).not.toContain('A reply on the board')
  release.resolve()
  await vi.waitFor(() => expect(pane.textContent).toContain('A reply on the board'), taskRead)
  expect(document.activeElement).toBe(draft)
  expect(draft.value).toBe('A reply in progress')
}, 30_000)

it('ignores a superseded thread success released after a newer real 404', async () => {
  const { open, secret, revoke } = await revocableTasks()
  const sampled = gate()
  const release = gate()
  const delivered = gate()
  let held = false
  await open(`/?thread=${secret.id}`, { transport: async (request, send) => {
    const response = await send()
    if (!held && routePath(request) === `/messages/${secret.id}`) {
      held = true
      expect(response.status).toBe(200)
      sampled.resolve()
      await release.promise
      delivered.resolve()
    }
    return response
  } })
  await sampled.promise
  await revoke()
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(threadPane()?.textContent).toContain('message not found'))
  await act(async () => { release.resolve(); await delivered.promise })
  expect(threadPane()?.textContent).toContain('message not found')
  expect(document.body.textContent).not.toContain('Private task')
})

it('keeps unsent reply text and attachments through a 503 and recovery', async () => {
  const { client, open } = await workbench()
  const { task } = await client.tasks.create('work', { text: 'Thread with a draft' })
  let outage = false
  await open(`/?thread=${task.id}`, { transport: async (request, send) => {
    if (outage && routePath(request) === `/messages/${task.id}`)
      return Response.json({ error: { code: 'unavailable', message: 'temporary outage' } }, { status: 503 })
    return send()
  } })
  const draft = await vi.waitFor(() => {
    const textarea = threadPane()?.querySelector('textarea')
    expect(textarea).toBeDefined()
    return textarea!
  })
  draft.focus()
  await act(async () => {
    typeInto(draft, 'Draft text')
    const picker = threadPane()!.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(picker, 'files', { value: [new File(['draft contents'], 'notes.txt', { type: 'text/plain' })] })
    picker.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(threadPane()?.textContent).toContain('notes.txt')
  outage = true
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(threadPane()?.textContent).toContain('temporary outage'))
  expect(threadPane()?.querySelector('textarea')).toBe(draft)
  expect(draft.value).toBe('Draft text')
  expect(threadPane()?.textContent).toContain('notes.txt')
  outage = false
  await client.reply(task.id, 'New reply after recovery')
  await vi.waitFor(() => expect(threadPane()?.textContent).toContain('New reply after recovery'))
  expect(document.activeElement).toBe(draft)
  expect(draft.value).toBe('Draft text')
  expect(threadPane()?.textContent).toContain('notes.txt')
})

it('typing over the Inbox focuses the open thread reply', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const { id } = await hold(client, 'Check the build', 'Ship the build?')
  await open(`/?thread=${id}`)
  const reply = await vi.waitFor(() => {
    const field = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="reply to thread…"]')
    expect(field).not.toBeNull()
    return field!
  })
  const overInbox = await vi.waitFor(() => decision(id).querySelector<HTMLAnchorElement>('a')!)
  overInbox.focus()
  expect(document.activeElement).toBe(overInbox)
  overInbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))
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

function button(title: string) {
  const match = document.querySelector<HTMLButtonElement>(`button[title="${title}"]`)
  expect(match, `button: ${title}`).not.toBeNull()
  return match!
}

function menuItem(text: string) {
  const match = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.trim() === text)
  expect(match, `menu item: ${text}`).toBeDefined()
  return match!
}

function typeInto(field: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!
  set.call(field, text)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

async function switchProfile(name: string, fromRegistry = false) {
  const developer = document.querySelector<HTMLDetailsElement>('main details.developer-identity')!
  if (!developer.open) developer.querySelector('summary')!.click()
  button('post as').click()
  if (fromRegistry) (await vi.waitFor(() => menuItem(name))).click()
  else {
    const custom = await vi.waitFor(() => menuItem('another profile…'))
    custom.click()
    const field = await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>('input[placeholder="profile name"]')
      expect(input).not.toBeNull()
      return input!
    })
    await act(async () => typeInto(field, name))
    field.form!.querySelector('button')!.click()
  }
  await vi.waitFor(() => expect(document.querySelector('.whoami .as')!.textContent).toContain(name))
}

it('waits for a name in app-served mode and then shows that profile', async () => {
  const { open } = await workbench()
  await open('/', { named: true, profile: 'deployment' })
  const field = document.querySelector<HTMLInputElement>('input[name="profile"]')!
  expect(field).not.toBeNull()
  expect(document.querySelector('main')).toBeNull()
  typeInto(field, 'reviewer')
  field.form!.querySelector('button')!.click()
  await vi.waitFor(() => expect(document.querySelector('.whoami .as')!.textContent).toContain('reviewer'))
})

it('keeps the identity shown and the author of writes in sync when switching during named boot', async () => {
  const { client, open } = await workbench()
  await client.post('work', 'Ready for review')
  const reading = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await open('/settings/access', {
    named: true,
    proxy: async (request, forward) => {
      const response = await forward(request)
      if (routePath(request) === '/channels' && request.headers.get('x-board-profile') === 'reviewer') {
        reading.resolve()
        await release.promise
      }
      return response
    },
  })
  const field = document.querySelector<HTMLInputElement>('input[name="profile"]')!
  typeInto(field, 'reviewer')
  field.form!.querySelector('button')!.click()
  try {
    await reading.promise
    await switchProfile('editor')
    release.resolve()
    const channel = await vi.waitFor(() => {
      const item = document.querySelector<HTMLAnchorElement>('a[href="/c/work"]')
      expect(item).not.toBeNull()
      return item!
    })
    channel.click()
    await vi.waitFor(() => expect(document.querySelector('.live')?.textContent).toBe('live'))
    const composer = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="message #work…"]')!
    await act(async () => typeInto(composer, 'Edits ready'))
    document.querySelector<HTMLButtonElement>('main button.send')!.click()
    await vi.waitFor(async () => {
      const { messages } = await client.channel('work').messages()
      expect(messages.find((message) => message.text === 'Edits ready')?.by.profile).toBe('editor')
    })
    expect(document.querySelector('.whoami .as')?.textContent).toContain('editor')
  } finally {
    release.resolve()
  }
})

it('does not merge a delayed actors directory from the boot profile after switching', async () => {
  const { as, open } = await workbench()
  const post = await as('directory-only').post('work', 'Ready for review')
  const editor = await as('editor').post('work', 'Editor is ready')
  const reading = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await open('/settings/access', {
    profile: 'reviewer',
    proxy: async (request, forward) => {
      if (routePath(request) !== '/actors') return forward(request)
      if (request.headers.get('x-board-profile') === 'editor') {
        // The new handle's directory doesn't include the old entry.
        const url = new URL(request.url)
        url.searchParams.set('id', editor.by.actor)
        return forward(new Request(url, request))
      }
      const response = await forward(request)
      reading.resolve()
      await release.promise
      return response
    },
  })
  try {
    await reading.promise
    await switchProfile('editor')
    const page = await import('../src/inspect/app/board.ts')
    await vi.waitFor(() => expect(page.getState().actors[editor.by.actor]?.name).toBe('editor'))
    await act(async () => release.resolve())
    expect(page.getState().actors[post.by.actor]).toBeUndefined()
  } finally {
    release.resolve()
  }
})

it('aborts the boot feed and discards an event already queued by the previous profile', async () => {
  const { client, open } = await workbench()
  await client.post('work', 'Ready for review')
  const oldSignals: AbortSignal[] = []
  let newFeed = false
  await open('/settings/access', {
    profile: 'reviewer',
    proxy: async (request, forward) => {
      if (routePath(request) === '/events') {
        if (request.headers.get('x-board-profile') === 'reviewer') oldSignals.push(request.signal)
        else if (request.headers.get('x-board-profile') === 'editor') newFeed = true
      }
      return forward(request)
    },
  })
  const page = await import('../src/inspect/app/board.ts')
  await vi.waitFor(() => expect(page.getState().live).toBe('live'))
  const frames: FrameRequestCallback[] = []
  const frame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((run) => frames.push(run))
  try {
    const stale = await client.post('work', 'Queued by the old feed')
    await vi.waitFor(() => expect(frames).not.toHaveLength(0))
    frame.mockRestore()
    await switchProfile('editor')
    await vi.waitFor(() => expect(newFeed).toBe(true))
    expect(oldSignals.length).toBeGreaterThan(0)
    expect(oldSignals.every((signal) => signal.aborted)).toBe(true)
    for (const flush of frames) flush(performance.now())
    expect(page.getState().messages[stale.id]).toBeUndefined()
    const fresh = await client.post('work', 'Read by the new feed')
    await vi.waitFor(() => expect(page.getState().messages[fresh.id]?.text).toBe(fresh.text))
  } finally {
    frame.mockRestore()
  }
})

it('drops a late status read after a profile switch', async () => {
  const { client, open } = await workbench()
  const sampled = Promise.withResolvers<void>()
  const releaseOld = Promise.withResolvers<void>()
  const releaseNew = Promise.withResolvers<void>()
  const releaseEvents = Promise.withResolvers<void>()
  let hold = false
  await open('/settings/access', {
    profile: 'reviewer',
    proxy: async (request, forward) => {
      const response = await forward(request)
      const profile = request.headers.get('x-board-profile')
      const path = routePath(request)
      if (path === '/events' && profile === 'reviewer' && hold) await releaseEvents.promise
      if (path === '/control' && hold) {
        if (profile === 'reviewer') {
          sampled.resolve()
          await releaseOld.promise
        } else await releaseNew.promise
      }
      return response
    },
  })
  const page = await import('../src/inspect/app/board.ts')
  await vi.waitFor(() => {
    expect(page.getState().live).toBe('live')
    expect(page.getState().status).toEqual({ paused: false, pauseEpoch: 0 })
  })
  try {
    hold = true
    await client.pause('old profile samples the pause')
    const reading = page.loadStatus()
    await sampled.promise
    await client.resume('before switching')
    await switchProfile('editor')
    releaseOld.resolve()
    await reading
    expect(page.getState().status).toEqual({ paused: false, pauseEpoch: 0 })
    releaseNew.resolve()
    await vi.waitFor(() => expect(page.getState().status).toEqual({ paused: false, pauseEpoch: 1 }))
  } finally {
    releaseOld.resolve()
    releaseNew.resolve()
    releaseEvents.resolve()
  }
})

it.each([
  { width: 390, profile: undefined },
  { width: 1280, profile: undefined },
  { width: 390, profile: 'reviewer' },
])('shows one acting-as label with the sidebar hidden or open ($width, $profile)', async ({ width, profile }) => {
  const { as, client, open } = await workbench()
  await client.post('work', 'Ready for review')
  await open('/c/work', { width, ...(profile ? { profile } : {}) })
  const identity = `acting as ${(await as(profile ?? null).me()).name}`
  const header = () => document.querySelector('main .header')?.textContent
  const rail = () => document.querySelector<HTMLElement>('.sidebar')!
  const openRail = () => {
    expect(getComputedStyle(rail()).display).not.toBe('none')
    expect(rail().hidden).toBe(false)
    // The rail shows who you are by picture and name only.
    expect(rail().querySelector('.whoami .as')?.textContent).toContain(identity.slice('acting as '.length))
    expect(rail().querySelector('.whoami')?.textContent).not.toContain('acting as')
    expect(header()).not.toContain('acting as')
  }
  if (width >= 1024) {
    await vi.waitFor(openRail)
    button('Hide sidebar').click()
  }
  await vi.waitFor(() => {
    expect(header()).toContain(identity)
    expect(rail().hidden || getComputedStyle(rail()).display === 'none').toBe(true)
  })
  button('Show sidebar').click()
  await vi.waitFor(openRail)
})

it('shows a pause that lands before the first channels cursor is captured', async () => {
  const { client, open } = await workbench()
  let earlyStatus: Promise<Response> | undefined
  let channelsStarted = false
  await open('/', {
    proxy: async (request, forward) => {
      const path = routePath(request)
      if (path === '/control' && !channelsStarted) return (earlyStatus = forward(request))
      if (path === '/channels' && !channelsStarted) {
        channelsStarted = true
        // If boot already read status, let the real board finish that snapshot first.
        await earlyStatus
        await client.pause('paused during boot')
      }
      return forward(request)
    },
  })
  await vi.waitFor(() => {
    expect(document.querySelector('.live')?.textContent).toBe('live')
    expect(document.querySelector('.pause-banner:not([hidden])')?.textContent).toBe('paused')
  })
  expect(await client.status()).toEqual({ paused: true, pauseEpoch: 1 })
})

it('asks for a reason to Pause, shows the board’s refusal, and lets the manager try again', async () => {
  const { client, open } = await workbench()
  let allow = false
  await open('/', {
    proxy: async (request, forward) => {
      // Simulate the write arriving with reduced authority after the page read /me.
      if (!allow && routePath(request) === '/control/pause') request.headers.set('x-board-can', '*=read')
      return forward(request)
    },
  })
  await vi.waitFor(() => button('Pause')).then((pause) => pause.click())
  await submitReason('reason', 'rotate workers')
  await vi.waitFor(() => expect(document.querySelector('.toasts')?.textContent).toContain('only a person with board-wide manage can change work control'))
  expect(await client.status()).toEqual({ paused: false, pauseEpoch: 0 })
  allow = true
  button('Pause').click()
  await submitReason('reason', 'rotate workers')
  await vi.waitFor(() => expect(document.querySelector('.pause-banner:not([hidden])')?.textContent).toContain('rotate workers'))
  expect(await client.status()).toEqual({ paused: true, pauseEpoch: 1 })
})

it('shows live pause detail on every view and lets the manager resume with a reason', async () => {
  const { client, open } = await workbench()
  await client.post('work', 'Release notes')
  await open()
  const banner = () => document.querySelector<HTMLElement>('.pause-banner')!
  await vi.waitFor(() => button('Pause'))
  await vi.waitFor(() => expect(document.querySelector('.live')?.textContent).toBe('live'))
  await client.pause('maintenance window')
  const me = await client.me()
  await vi.waitFor(() => expect(banner().textContent).toMatch(new RegExp(`^paused by ${me.name}, .+ ago: maintenance window$`)))
  for (const [path, title] of [['/c/work', '#work'], ['/operations', 'operations'], ['/settings/access', 'settings'], ['/', 'Inbox']]) {
    document.querySelector<HTMLAnchorElement>(`.sidebar a[href="${path}"]`)!.click()
    await vi.waitFor(() => expect(document.querySelector('main h1')?.textContent).toBe(title))
    expect(banner().hidden).toBe(false)
    expect(banner().textContent).toContain('maintenance window')
  }
  button('Resume').click()
  await submitReason('reason', 'maintenance ended')
  await vi.waitFor(() => {
    expect(banner().hidden).toBe(true)
    button('Pause')
  })
  const received = client.events({ all: true, last: 1 })
  try {
    expect((await received.next()).value).toMatchObject({ type: 'work.control', payload: { reason: 'maintenance ended', paused: false } })
  } finally {
    await received.return(undefined)
  }
})

it('keeps the message scroller in place through a live pause and resume', async () => {
  const { client, open } = await workbench()
  for (let i = 1; i <= 20; i++) await client.post('work', `Release log entry ${i}`)
  const thread = await client.post('work', 'Release review')
  await client.reply(thread.id, 'The review starts here')
  await open(`/c/work?thread=${thread.id}`)
  await vi.waitFor(() => {
    expect(document.querySelector('.live')?.textContent).toBe('live')
    expect(document.querySelectorAll('main .message')).toHaveLength(21)
    expect(document.querySelector('.pane .feed')?.textContent).toContain('The review starts here')
    button('Pause')
  })
  const scrollers = [...document.querySelectorAll<HTMLElement>('main .feed, .pane .feed, .sidebar-scroll')]
  expect(scrollers).toHaveLength(3)
  const banner = document.querySelector<HTMLElement>('.pause-banner')!
  // Happy DOM doesn't lay out the page. Supply the box measurement, not the style or scroll behavior.
  const height = 32
  banner.getBoundingClientRect = () => new DOMRect(0, 46, 1256, banner.hidden ? 0 : height)
  scrollers.forEach((el) => {
    Object.defineProperty(el, 'scrollHeight', { value: 1200 })
    el.scrollTop = 300
    el.dispatchEvent(new Event('scroll'))
  })

  await client.pause('waiting for the release window')
  await vi.waitFor(() => {
    expect(banner.hidden).toBe(false)
    expect(banner.textContent).toContain('waiting for the release window')
    expect(scrollers.map((el) => el.scrollTop)).toEqual([332, 332, 332])
  })
  expect(banner.parentElement).toBe(document.querySelector('.workspace'))
  expect(getComputedStyle(banner.parentElement!).display).toBe('grid')
  expect(['', 'static', 'relative']).toContain(getComputedStyle(banner).position)
  expect(getComputedStyle(banner).overflowY).toBe('auto')

  await client.resume('the release window opened')
  await vi.waitFor(() => {
    expect(banner.hidden).toBe(true)
    expect(scrollers.map((el) => el.scrollTop)).toEqual([300, 300, 300])
    button('Pause')
  })

  // A browser can clamp the pinned pane's old offset as soon as the banner goes away.
  const pane = document.querySelector<HTMLElement>('.pane .feed')!
  const bottom = () => pane.scrollHeight - pane.clientHeight
  let offset = 300
  Object.defineProperties(pane, {
    clientHeight: { get: () => 300 - (banner.hidden ? 0 : height) },
    scrollTop: { get: () => Math.min(offset, bottom()), set: (top: number) => { offset = Math.min(top, bottom()) } },
  })
  pane.scrollTop = bottom()
  pane.dispatchEvent(new Event('scroll'))
  await client.pause('waiting again')
  await vi.waitFor(() => {
    expect(banner.hidden).toBe(false)
    expect(pane.scrollTop).toBe(bottom())
  })
  await client.resume('finished')
  await vi.waitFor(() => {
    expect(banner.hidden).toBe(true)
    expect(pane.scrollTop).toBe(bottom())
  })
})

async function submitReason(placeholder: string, text: string) {
  const reason = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)
    expect(input).not.toBeNull()
    return input!
  })
  await act(async () => typeInto(reason, text))
  reason.form!.querySelector('button')!.click()
}

it('shows just paused to a reader who joined after the transition', async () => {
  const { client, open } = await workbench()
  await client.pause('an earlier pause')
  await open('/settings/access', { can: '*=read' })
  await vi.waitFor(() => expect(document.querySelector('.pause-banner')?.textContent).toBe('paused'))
  expect(document.querySelector('button[title="Resume"]')).toBeNull()
})

it('lets a person claim, park, and unpark an unheld ready task', async () => {
  const { api, open } = await workbench()
  const { task } = await api.tasks.create('work', { text: 'Check the release' })
  await open(`/?thread=${task.id}`)
  await vi.waitFor(() => expect(document.querySelector('.task-card .task-state')?.textContent).toBe('ready'))
  await vi.waitFor(() => button('more')).then((more) => more.click())
  const park = await vi.waitFor(() => menuItem('park…'))
  const actions = [...document.querySelectorAll('.task-card button, [role="menuitem"]')].map((item) => item.textContent?.trim()).join(' ')
  expect(actions).toContain('claim')
  expect(actions).toContain('park')
  expect(actions).not.toMatch(/\b(renew|release|complete)\b/i)
  park.click()
  await submitReason('why it should wait', 'waiting for the release window')
  const unpark = await vi.waitFor(() => {
    expect(document.querySelector('.task-card')?.textContent).toContain('waiting for the release window')
    const button = [...document.querySelectorAll<HTMLButtonElement>('.task-card button')].find((item) => item.textContent === 'unpark…')
    // The feed can render the parked task before the park write has settled.
    expect(button?.disabled).toBe(false)
    return button!
  })
  unpark.click()
  await submitReason('why it can go ahead', 'the window opened')
  await vi.waitFor(() => expect(document.querySelector('.task-card .task-state')?.textContent).toBe('ready'))
})

it('offers Priority, Park and Cancel but no lease actions on another actor’s claimed task; Answer follows a hold', async () => {
  const { as, client, open } = await workbench({ attentionResponders: { work: ['vercel:user:u_reader'] } })
  const { task } = await client.tasks.create('work', { text: 'Review the release' })
  const worker = as('worker')
  const { token, epoch } = await worker.tasks.claim(task.id)
  await open(`/?thread=${task.id}`)
  await vi.waitFor(() => {
    expect(document.querySelector('.task-card .task-state')?.textContent).toBe('claimed')
    expect(document.querySelector('.task-card .task-head')?.textContent).toContain('by worker')
  })
  button('more').click()
  await vi.waitFor(() => {
    for (const action of ['change priority…', 'park…', 'cancel the task…']) menuItem(action)
    const controls = [...document.querySelectorAll('.task-card button, [role="menuitem"]')]
    const names = controls.flatMap((el) => [el.textContent, el.getAttribute('title'), el.getAttribute('aria-label')])
    expect(names.join(' ')).not.toMatch(/\b(claim|renew|release|complete|answer)\b/i)
  })
  // A structured attention request ends the claim; only then can a person be offered Answer.
  await worker.tasks.ask(task.id, {
    claim: { token, epoch }, kind: 'awaiting_approval', question: 'Release this commit?', context: 'Checks passed.',
    options: [
      { id: 'proceed', label: 'Proceed', consequence: 'Resume work', next: 'resume' },
      { id: 'revise', label: 'Revise', consequence: 'Make changes first', next: 'resume' },
    ],
    revision: task.revision, evidence: [{ message: task.id, revision: task.revision }],
    expiresAt: new Date(Date.now() + 60_000).toISOString(), commit: 'a'.repeat(40),
  })
  await vi.waitFor(() => {
    expect(document.querySelector('.task-card .task-state')?.textContent).toBe('blocked')
    expect([...document.querySelectorAll('.task-card button')].map((el) => el.textContent)).toContain('answer…')
  })
})

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

const responders = { work: ['vercel:user:u_reader'] }
const commit = 'a'.repeat(40)
const question = '<img src=x onerror=alert(1)>'
const staleWords = 'the attention request or its snapshot is no longer current'
const unsupportedWords = 'this board does not keep task attention requests'
const readOnlyWords = 'answering needs a person acting as themselves with post access'
const inboxLink = () => document.querySelector<HTMLAnchorElement>('.sidebar-scroll a[href="/"]')!
/** Leave the Inbox for a view that reads no attention: the `work` channel. */
const leaveInbox = () => document.querySelector<HTMLAnchorElement>('.sidebar a[href="/c/work"]')!.click()
const inboxCount = () => inboxLink().querySelector('.count')?.textContent
const attentionList = () => document.querySelector<HTMLElement>('[aria-label="attention requests"]')!
const decision = (id: string) => document.getElementById(`attention-${id}`)!
const choice = (id: string) => decision(id)?.querySelector<HTMLButtonElement>('button.attention-choice')
const selectedDecision = () => attentionList().querySelector('[aria-current="true"]')?.id
const threadPane = () => document.querySelector('aside[aria-label="Thread"]')
const unblockButton = () => [...(threadPane()?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'unblock')
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

it.each([
  ['upcoming', -45_000, '45s left'],
  ['past', 45_000, '45s ago'],
] as const)('shows the %s attention deadline relatively with its local timestamp on hover', async (_status, offset, expected) => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const { id, attention: { expiresAt } } = await hold(client, 'Draft for review', 'Ship the draft?')
  vi.setSystemTime(Date.parse(expiresAt) + offset)
  await open('/')
  await vi.waitFor(() => {
    const time = decision(id)?.querySelector(`time[datetime="${expiresAt}"]`)
    expect(time?.textContent).toBe(expected)
    expect(time?.getAttribute('title')).toBe(new Date(expiresAt).toLocaleString())
  })
})

function press(target: HTMLElement, key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  flushSync(() => target.dispatchEvent(event))
  return event.defaultPrevented
}

it('opens the Inbox from the sidebar, counts only holds, escapes questions, and applies each allowed read as it arrives', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  await client.tasks.create('work', { text: 'A ready task' })
  const a = await hold(client, 'First draft', question)
  const b = await hold(client, 'Second draft', 'Use the second draft?')
  const release = gate()
  const reads: string[] = []
  await open('/c/work', { transport: async (r, send) => {
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
  expect(location.pathname).toBe('/')
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
  leaveInbox()
  const c = await hold(client, 'Third draft', 'Use the third draft?')
  await vi.waitFor(() => expect(inboxCount()).toBe('3'))
  expect(reads).toHaveLength(2)
  inboxLink().click()
  await vi.waitFor(() => expect(choice(c.id)?.disabled).toBe(false))
  const d = await hold(client, 'Fourth draft', 'Use the fourth draft?')
  await vi.waitFor(() => expect(choice(d.id)?.disabled).toBe(false))
})

it('ignores an Attention refusal that arrives after switching to a responder', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const unsupported = localBoard()
  otherBoards.push(unsupported)
  const a = await hold(client, 'First draft', 'Use this draft?')
  const captured = gate()
  const release = gate()
  await open('/', { profile: 'reviewer', transport: async (r, send) => {
    if (!attentionRead(r) || r.headers.get('x-board-profile') !== 'reviewer') return send()
    const refused = await unsupported.fetch(r)
    expect(refused.status).toBe(501)
    captured.resolve()
    await release.promise
    return refused
  } })
  await captured.promise
  link('settings').click()
  const developer = await vi.waitFor(() => {
    const details = document.querySelector<HTMLDetailsElement>('details.developer-identity')
    expect(details).not.toBeNull()
    return details!
  })
  developer.querySelector('summary')!.click()
  button('post as').click()
  const yourself = await vi.waitFor(() => menuItem('act as yourself'))
  yourself.click()
  const me = await client.me()
  await vi.waitFor(() => expect(document.querySelector('.whoami .as')?.textContent).toContain(me.name))
  inboxLink().click()
  await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
  await act(async () => release.resolve())
  expect(choice(a.id)?.disabled).toBe(false)
})

it('consumes only real moves and enabled digits, and requires reselection after a replacement or removal', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use the first draft?')
  const b = await hold(client, 'Second draft', 'Use the second draft?')
  await open('/')
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
  await open('/', {
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
  await open('/', { transport: async (r, send) => {
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
  await open('/', { transport: async (r, send) => {
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
  await open('/', { transport: async (r, send) => {
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
  leaveInbox()
  await vi.waitFor(() => expect(location.pathname).toBe('/c/work'))
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
  let replace = false
  await open('/', { transport: async (r, send) => {
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
    return send()
  } })
  await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
  choice(a.id)!.click()
  leaveInbox()
  await vi.waitFor(() => expect(location.pathname).toBe('/c/work'))
  const replaceA = () => client.tasks.ask(a.id, { ...a.request, question: 'Use B?', replaces: a.attention.id })
  // Until an accepted root shows B, the refused write belongs to the A the page saw.
  if (source === 'thread') await replaceA()
  beforeAnswer.resolve()
  expect(await writing.promise).toBe(source === 'thread' ? 409 : 404)
  await vi.waitFor(() => expect(inboxLink().textContent).toContain('refused'))
  if (source === 'thread') {
    history.pushState(null, '', `/c/work?thread=${a.id}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  } else await replaceA()
  await vi.waitFor(() => expect(inboxLink().textContent).not.toContain('refused'))
  replace = true
  inboxLink().click()
  await refusedRead.promise
  // The Inbox treats a missing request as a missing task: the question leaves, and no stale words stay.
  await vi.waitFor(() => expect(decision(a.id)).toBeNull())
  expect(mainText()).not.toContain(staleWords)
  expect(inboxLink().textContent).not.toContain('refused')
})

it.each(['before', 'after'] as const)('ignores a superseded read that arrives %s the newer response', async (order) => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  const pending = [0, 1].map(() => ({ captured: gate(), release: gate() }))
  let reads = 0
  await open('/', { transport: async (r, send) => {
    const response = await send()
    if (attentionRead(r)) {
      const read = pending[reads++]!
      read.captured.resolve()
      await read.release.promise
    }
    return response
  } })
  await pending[0]!.captured.promise
  leaveInbox()
  await vi.waitFor(() => expect(location.pathname).toBe('/c/work'))
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

it('settles Ship it from the feed without rolling back a newer thread hold', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  const feed = gate()
  const answer = Promise.withResolvers<number>()
  await open('/', { transport: async (r, send) => {
    if (isFeed(r)) await feed.promise
    const response = await send()
    if (answerWrite(r)) answer.resolve(response.status)
    return response
  } })
  await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
  choice(a.id)!.click()
  expect(await answer.promise).toBe(200)
  await client.tasks.block(a.id, 'Wait for translation')
  decision(a.id).querySelector('a')!.click()
  await vi.waitFor(() => expect(threadPane()?.textContent).toContain('Wait for translation'))
  expect(decision(a.id).textContent).toContain('answering Ship it')
  feed.resolve()
  await vi.waitFor(() => expect(decision(a.id)?.textContent).toContain('answered · Ship it'))
  expect(decision(a.id).textContent).not.toContain('answering')
  expect(threadPane()?.textContent).toContain('Wait for translation')
  expect(inboxCount()).toBeUndefined()
})

it.each(['same request', 'replacement'] as const)('scopes a late competing 409 to its receipt: %s', async (scenario) => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  const sendAnswer = gate()
  const releaseRefusal = gate()
  const refused = Promise.withResolvers<number>()
  await open('/', { transport: async (r, send) => {
    if (!answerWrite(r)) return send()
    await sendAnswer.promise
    const response = await send()
    refused.resolve(response.status)
    await releaseRefusal.promise
    return response
  } })
  await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
  choice(a.id)!.click()
  await client.tasks.answer(a.id, a.attention.id, { option: 'stop', commit })
  await vi.waitFor(() => expect(decision(a.id).textContent).toContain('answered · Stop'))
  sendAnswer.resolve()
  expect(await refused.promise).toBe(409)
  if (scenario === 'replacement') {
    await client.tasks.reopen(a.id)
    await client.tasks.ask(a.id, { ...a.request, question: 'Use the replacement?' })
    await vi.waitFor(() => expect(decision(a.id).textContent).toContain('Use the replacement?'))
  }
  await act(async () => releaseRefusal.resolve())
  if (scenario === 'same request') {
    await vi.waitFor(() => expect(decision(a.id).textContent).toContain(staleWords))
    expect(decision(a.id).textContent).toContain('answered · Stop')
    expect(choice(a.id)).toBeNull()
  } else {
    expect(decision(a.id).textContent).not.toContain(staleWords)
    expect(inboxLink().textContent).not.toContain('refused')
    expect(choice(a.id)?.disabled).toBe(false)
  }
})

it('offers a working unblock for a plain hold after an answered request', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  await client.tasks.answer(a.id, a.attention.id, { option: 'ship', commit })
  const root = await client.tasks.block(a.id, 'Wait for translation')
  expect(root.task?.attentionId).toBe(a.attention.id)
  await open(`/?thread=${a.id}`)
  await vi.waitFor(() => expect(threadPane()?.textContent).toContain('Wait for translation'))
  expect(unblockButton()).toBeDefined()
  unblockButton()!.click()
  await vi.waitFor(() => expect(threadPane()?.textContent).not.toContain('Wait for translation'))
  expect((await client.tasks.list({ state: 'ready' })).tasks.map(({ message }) => message.id)).toContain(a.id)
})

it('keeps a stale request read-only without offering an unblock the board refuses', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse(a.attention.expiresAt) + 1)
  await expect(client.tasks.unblock(a.id)).rejects.toMatchObject({ status: 409, code: 'attention_required' })
  await open(`/?thread=${a.id}`)
  await vi.waitFor(() => expect(decision(a.id)?.textContent).toContain('read only: the request is stale'))
  await vi.waitFor(() => expect(threadPane()?.textContent).toContain('Use this draft?'))
  expect(unblockButton()).toBeUndefined()
  expect(choice(a.id)).toBeNull()
})

it.each(['read', 'write'] as const)('hides all answer buttons on a 501 with a different code from %s', async (operation) => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  const b = await hold(client, 'Second draft', 'Use the second draft?')
  const release = gate()
  const words = 'this deployment has not enabled attention'
  await open('/', { transport: async (r, send) => {
    const refused = operation === 'read' ? attentionRead(r) && r.url.endsWith(`/${a.id}/attention`) : answerWrite(r)
    if (!refused) return send()
    await release.promise
    // Model a backend with a different 501 code; all other traffic goes to the local board.
    return Response.json({ error: { code: 'not_implemented', message: words } }, { status: 501 })
  } })
  await vi.waitFor(() => expect(choice(b.id)?.disabled).toBe(false))
  if (operation === 'write') {
    await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
    choice(a.id)!.click()
  }
  release.resolve()
  await vi.waitFor(() => expect(decision(a.id).textContent).toContain(words))
  expect(choice(a.id)).toBeNull()
  expect(choice(b.id)).toBeNull()
})

it('keeps the answering overlay after HTTP success until the real feed confirms', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  const feed = gate()
  const answer = Promise.withResolvers<number>()
  await open('/', { transport: async (r, send) => {
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

it('opens the channel above the open one when it is hidden, or the one below when it is the first', async () => {
  const { client, open } = await workbench()
  for (const channel of ['alpha', 'beta', 'gamma']) await client.post(channel, `In ${channel}`)
  const row = (channel: string) => document.querySelector<HTMLAnchorElement>(`.sidebar a.item[title="${channel}"]`)
  const hide = (channel: string) => row(channel)!.querySelector<HTMLElement>('.eye')!.click()
  const listed = () => [...document.querySelectorAll<HTMLAnchorElement>('.sidebar section a.item')].map((a) => a.title)
  const opened = () => document.querySelector('.sidebar section a.item[aria-current="page"]')?.getAttribute('title')

  await open('/c/beta')
  await vi.waitFor(() => expect(opened()).toBe('beta'))
  hide('beta')
  await vi.waitFor(() => expect([opened(), location.pathname.endsWith('/c/alpha')]).toEqual(['alpha', true]))
  expect(listed()).toEqual(['alpha', 'gamma'])
  hide('alpha')
  await vi.waitFor(() => expect(opened()).toBe('gamma'))
  expect(listed()).toEqual(['gamma'])
  // Hiding a channel that is not open opens nothing else.
  await client.post('delta', 'In delta')
  await vi.waitFor(() => expect(row('delta')).not.toBeNull())
  hide('delta')
  await vi.waitFor(() => expect(listed()).toEqual(['gamma']))
  expect(opened()).toBe('gamma')
})

it('switches dark mode from the sidebar and keeps the pick for the next visit', async () => {
  localStorage.removeItem('board.theme')
  delete document.documentElement.dataset.theme
  const { open } = await workbench()
  await open('/c/work')
  const box = () => document.querySelector<HTMLInputElement>('.sidebar-foot .theme-toggle input')!
  await vi.waitFor(() => expect(box()).not.toBeNull())
  // Before a pick, the page follows the system and sets no theme of its own.
  expect(document.documentElement.dataset.theme).toBeUndefined()
  const wasDark = box().checked
  box().click()
  await vi.waitFor(() => expect(box().checked).toBe(!wasDark))
  const picked = wasDark ? 'light' : 'dark'
  expect([document.documentElement.dataset.theme, localStorage.getItem('board.theme')]).toEqual([picked, picked])
  box().click()
  await vi.waitFor(() => expect(box().checked).toBe(wasDark))
  expect([document.documentElement.dataset.theme, localStorage.getItem('board.theme')]).toEqual([wasDark ? 'dark' : 'light', wasDark ? 'dark' : 'light'])
  localStorage.removeItem('board.theme')
  delete document.documentElement.dataset.theme
})
