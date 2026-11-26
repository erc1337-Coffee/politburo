// @vitest-environment happy-dom
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createBoardClient } from '../src/client/client.ts'
import { shell } from '../src/inspect/shell.ts'
import { BOARD_URL, localBoard, personToken } from './harness.ts'

const browser = (window as unknown as import('happy-dom').Window).happyDOM
let visit = 0
let root: Root | undefined
let close: (() => Promise<void>) | undefined
const releaseGates: (() => void)[] = []

afterEach(async () => {
  root?.unmount()
  for (const release of releaseGates.splice(0)) release()
  await close?.()
  root = undefined
  close = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.head.replaceChildren()
  document.body.replaceChildren()
})

// Substitute only the browser-to-proxy transport; reads, writes and live events use the local board.
async function threadBoard() {
  const api = localBoard()
  const page = new AbortController()
  const streamClosed = Promise.withResolvers<void>()
  let streaming = false
  close = async () => {
    page.abort()
    if (streaming) await streamClosed.promise
    await api.close()
  }
  const token = await personToken('u_reader', BOARD_URL)
  const clientFor = (token: string, profile: string | null = null) => createBoardClient({ url: BOARD_URL, token, profile, fetch: (input, init) => api.fetch(new Request(input, init)) })
  const client = clientFor(token)
  const writes: string[] = []
  return {
    writes,
    create: (workId: number | string, text: string, options: { claim?: boolean; priority?: 'urgent'; party?: string; needs?: string[] } = {}) => {
      const { party = 'blue', ...task } = options
      return client.tasks.create('work', { text, labels: { 'work.id': typeof workId === 'number' ? `wp-${workId}` : workId, party }, ...task })
    },
    client,
    clientFor,
    token,
    actor: async (id: string) => clientFor(await personToken(id, BOARD_URL)),
    async open(address = '', openTasksResponse?: () => Promise<Response>) {
      browser.setViewport({ width: 1280, height: 900 })
      browser.setURL(`http://faces-${++visit}.test${address.startsWith('/') ? address : `/c/${address}`}`)
      const html = new DOMParser().parseFromString(shell({ token: 'inspector-test', base: '', profile: null, named: false }), 'text/html')
      document.head.replaceChildren(...html.head.querySelectorAll('meta, style'))
      document.body.innerHTML = '<div id="root"></div>'
      const proxy = `${location.origin}/board`
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const isStream = request.url.startsWith(`${proxy}/events?`)
        if (page.signal.aborted || (request.url !== proxy && !request.url.startsWith(`${proxy}/`))) {
          if (isStream) streamClosed.resolve()
          return Response.json({ error: { code: 'closed', message: 'page closed' } }, { status: 403 })
        }
        if (isStream) streaming = true
        if (request.method !== 'GET' && request.method !== 'HEAD') writes.push(request.method)
        const url = new URL(request.url)
        if (openTasksResponse && request.method === 'GET' && `${url.origin}${url.pathname}` === `${proxy}/tasks` && url.searchParams.get('state') === 'open') {
          return openTasksResponse()
        }
        const headers = new Headers(request.headers)
        headers.set('authorization', `Bearer ${token}`)
        return api.fetch(new Request(`${BOARD_URL}${request.url.slice(proxy.length)}`, {
          method: request.method, headers, signal: AbortSignal.any([page.signal, request.signal]),
          ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }),
        }))
      })
      vi.resetModules()
      const { App } = await import('../src/inspect/app/App.tsx')
      const mounted = root = createRoot(document.getElementById('root')!)
      flushSync(() => mounted.render(<App />))
    },
  }
}


// What the orchestrator registers for its rounds.
const ACTIVITY = {
  name: 'worker_activity', version: 1, description: 'A worker round.',
  schema: { type: 'object', required: ['task', 'attempt', 'round', 'state', 'items'], properties: { items: { type: 'array' } } },
}
const round = (task: string) =>
  `\`\`\`json#worker_activity@1\n${JSON.stringify({ task, attempt: 1, round: 1, state: 'completed', items: [] })}\n\`\`\`\n\nDone.`

const faces = () => [...document.querySelectorAll('main .replies .faces .avatar')].map((el) => el.getAttribute('title'))

it('shows one face per person or service that answered a thread never opened: the worker apart from the orchestrator that posts its rounds', async () => {
  const { client, clientFor, token, open } = await threadBoard()
  await client.createSchema(ACTIVITY)
  const orchestrator = clientFor(token, 'orchestrator')
  const root = await client.post('dev', 'Read the port from PORT.')
  await orchestrator.reply(root.id, { text: 'attempt 1 started.', labels: { 'politburo.status': 'orchestrator' } })
  await orchestrator.reply(root.id, round(root.id))
  await client.reply(root.id, 'Thanks.')
  await open('dev')
  await vi.waitFor(() => expect(faces()).toEqual(['orchestrator via u_reader', 'Worker', expect.any(String)]))
  expect(document.querySelector('main .replies')?.textContent).toContain('3 replies')
})
