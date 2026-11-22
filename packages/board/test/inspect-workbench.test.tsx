// @vitest-environment happy-dom
import { act } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { createBoardClient, type ProfileOption } from '../src/client/client.ts'
import { shell } from '../src/inspect/shell.ts'
import { slack } from '../src/sync/slack.ts'
import { BOARD_URL, localBoard, personToken } from './harness.ts'
import { fakePlatform } from './sync-fixtures.ts'

let visit = 0
const browser = (window as unknown as import('happy-dom').Window).happyDOM
const closed = () => Response.json({ error: { code: 'closed', message: 'page closed' } }, { status: 403 })
const routePath = (request: Request) => new URL(request.url.slice(BOARD_URL.length), 'http://board.test').pathname
afterAll(() => vi.unstubAllGlobals())
let root: Root | undefined
let disconnect: (() => Promise<void>) | undefined
let local: ReturnType<typeof localBoard> | undefined

afterEach(async () => {
  root?.unmount()
  root = undefined
  await disconnect?.()
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
      profile?: string; named?: boolean; can?: string
      holdSchedules?: (profile: string | null) => Promise<void> | undefined
      proxy?: (request: Request, forward: (request: Request) => Promise<Response>) => Promise<Response>
    } = {}) {
      browser.settings.enableImageFileLoading = false
      browser.setViewport({ width: 1280, height: 900 })
      browser.setURL(`http://inspector-${++visit}.test${path}`)
      const profile = options.profile ? { name: options.profile } : null
      const html = new DOMParser().parseFromString(shell({ token: 'inspector-test', base: '', profile, named: options.named ?? false }), 'text/html')
      document.head.replaceChildren(...html.head.querySelectorAll('meta, style'))
      document.body.innerHTML = '<div id="root"></div>'
      const proxy = `${location.origin}/board`
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.url !== proxy && !request.url.startsWith(`${proxy}/`)) return closed()
        const isStream = request.headers.get('accept') === 'text/event-stream'
        if (page.signal.aborted) {
          // A refusal stops the handle from reconnecting after this tab closes.
          if (isStream) streamClosed.resolve()
          return closed()
        }
        if (isStream) streaming = true
        const headers = new Headers(request.headers)
        headers.set('authorization', `Bearer ${token}`)
        if (options.can) headers.set('x-board-can', options.can)
        const outbound = new Request(`${BOARD_URL}${request.url.slice(proxy.length)}`, {
          method: request.method, headers, signal: page.signal,
          ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }),
        })
        const response = options.proxy ? options.proxy(outbound, api.fetch) : api.fetch(outbound)
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
  await vi.waitFor(() => expect(document.querySelector('.sidebar-foot')!.textContent).toContain(`acting as ${name}`))
}

it('labels the signed-in person and lists only registered profiles in Settings', async () => {
  const { as, client, open } = await workbench({ agentOps: true })
  await client.post('work', 'Ready for review')
  await as('reviewer').agents.register({ channel: 'work', role: 'implementation-worker', harness: 'shell' })
  await open('/settings/access')
  const me = await client.me()
  await vi.waitFor(() => expect(document.querySelector('.sidebar-foot')!.textContent).toContain(`acting as ${me.name}`))
  expect(document.querySelector('.sidebar-foot button[title="post as"]')).toBeNull()
  await switchProfile('reviewer', true)
  button('post as').click()
  await vi.waitFor(() => expect(menuItem('another profile…')).toBeDefined())
  expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())).not.toContain('claude')
})

it('waits for a name in app-served mode and then shows that profile', async () => {
  const { open } = await workbench()
  await open('/', { named: true, profile: 'deployment' })
  const field = document.querySelector<HTMLInputElement>('input[name="profile"]')!
  expect(field).not.toBeNull()
  expect(document.querySelector('main')).toBeNull()
  typeInto(field, 'reviewer')
  field.form!.querySelector('button')!.click()
  await vi.waitFor(() => expect(document.querySelector('.sidebar-foot')!.textContent).toContain('acting as reviewer'))
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
    expect(document.querySelector('.sidebar-foot')?.textContent).toContain('acting as editor')
  } finally {
    release.resolve()
  }
})

it('drops a registry answer from the previous profile at the data boundary', async () => {
  const { as, client, open } = await workbench({ agentOps: true })
  await client.post('work', 'Ready for review')
  await as('reviewer').agents.register({ channel: 'work', role: 'implementation-worker', harness: 'shell' })
  const reading = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await open('/settings/access', {
    profile: 'editor',
    proxy: async (request, forward) => {
      const response = await forward(request)
      if (routePath(request) === '/ops/agents' && request.headers.get('x-board-profile') === 'editor') {
        reading.resolve()
        await release.promise
      }
      return response
    },
  })
  // Test at the data boundary so effect cleanup cannot hide a stale result.
  const page = await import('../src/inspect/app/board.ts')
  const stale = page.listProfiles('work')
  try {
    await reading.promise
    await switchProfile('writer')
    release.resolve()
    expect(await stale).toBeUndefined()
    expect(await page.listProfiles('work')).toEqual(['reviewer'])
  } finally {
    release.resolve()
    await stale
  }
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
  await open()
  const banner = () => document.querySelector<HTMLElement>('.pause-banner')!
  await vi.waitFor(() => button('Pause'))
  await vi.waitFor(() => expect(document.querySelector('.live')?.textContent).toBe('live'))
  await client.pause('maintenance window')
  const me = await client.me()
  await vi.waitFor(() => expect(banner().textContent).toMatch(new RegExp(`^paused by ${me.name}, .+ ago: maintenance window$`)))
  link('Presidium').click()
  await vi.waitFor(() => expect(document.querySelector('main h1')?.textContent).toBe('PRESIDIUM'))
  expect(banner().textContent).toContain('maintenance window')
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
  await open('/c/work')
  await vi.waitFor(() => {
    expect(document.querySelector('.live')?.textContent).toBe('live')
    expect(document.querySelectorAll('main .message')).toHaveLength(20)
    button('Pause')
  })
  const scroller = document.querySelector<HTMLElement>('main .feed')!
  const banner = document.querySelector<HTMLElement>('.pause-banner')!
  const workspace = scroller.closest('.workspace')!
  scroller.scrollTop = 300
  expect(scroller.scrollTop).toBe(300)

  // Happy DOM has no layout. Check the rendered structure that preserves the feed's geometry:
  // the banner is out of flow and neither the scroller nor its ancestors acquire an inset.
  const flow = () => {
    const chain = []
    for (let el: HTMLElement | null = scroller; el; el = el.parentElement) {
      const style = getComputedStyle(el)
      chain.push([el, style.height, style.minHeight, style.paddingTop, style.marginTop])
    }
    return chain
  }
  const before = flow()
  const stillReading = () => {
    expect(document.querySelector('main .feed')).toBe(scroller)
    expect(scroller.scrollTop).toBe(300)
    expect(flow()).toEqual(before)
  }

  await client.pause('waiting for the release window')
  await vi.waitFor(() => {
    expect(banner.hidden).toBe(false)
    expect(banner.textContent).toContain('waiting for the release window')
  })
  expect(banner.parentElement).toBe(workspace)
  expect(getComputedStyle(workspace).position).toBe('relative')
  expect(getComputedStyle(banner).position).toBe('absolute')
  stillReading()

  await client.resume('the release window opened')
  await vi.waitFor(() => {
    expect(banner.hidden).toBe(true)
    button('Pause')
  })
  stillReading()
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

it('lets a person park and unpark an unheld ready task without offering to claim it', async () => {
  const { api, open } = await workbench()
  const { task } = await api.tasks.create('work', { text: 'Check the release' })
  await open(`/?thread=${task.id}`)
  await vi.waitFor(() => expect(document.querySelector('.task-card .task-state')?.textContent).toBe('ready'))
  await vi.waitFor(() => button('more')).then((more) => more.click())
  const park = await vi.waitFor(() => menuItem('park…'))
  expect([...document.querySelectorAll('.task-card button, [role="menuitem"]')].map((item) => item.textContent?.trim()).join(' ')).not.toMatch(/\b(renew|release|complete|claim)\b/i)
  park.click()
  await submitReason('why it should wait', 'waiting for the release window')
  const unpark = await vi.waitFor(() => {
    expect(document.querySelector('.task-card')?.textContent).toContain('waiting for the release window')
    return [...document.querySelectorAll<HTMLButtonElement>('.task-card button')].find((item) => item.textContent === 'unpark…')!
  })
  expect(unpark).toBeDefined()
  unpark.click()
  await submitReason('why it can go ahead', 'the window opened')
  await vi.waitFor(() => expect(document.querySelector('.task-card .task-state')?.textContent).toBe('ready'))
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
