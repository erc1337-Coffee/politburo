import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { board as openBoard } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { RailwayClient } from '../src/railway.ts'
import { ATTENTION_LABEL, RailwayOperations } from '../src/railway-operations.ts'
import { OperationsMonitor } from '../src/operations.ts'
import { startOperationsServer } from '../src/operations-server.ts'
import { applicableActions, ThreadAssistant } from '../src/thread-assistant.ts'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const ENVIRONMENT = '22222222-2222-4222-8222-222222222222'
const SERVICE = '33333333-3333-4333-8333-333333333333'
const OTHER = '44444444-4444-4444-8444-444444444444'
const DEPLOYMENT = '55555555-5555-4555-8555-555555555555'

/** A Railway API stand-in: records each operation and answers from a small model of one service. */
function fakeRailway() {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = []
  const variables: Record<string, string> = { PORT: '8080', DATABASE_URL: 'postgres://x' }
  let active = [DEPLOYMENT]
  const fetcher = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    assert.equal(init.headers.authorization, 'Bearer railway-test-token')
    const { query, variables: input } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> }
    calls.push({ query, variables: input })
    const data = (value: unknown) => new Response(JSON.stringify({ data: value }), { status: 200, headers: { 'content-type': 'application/json' } })
    if (query.includes('projects(')) return data({ projects: { edges: [{ node: {
      id: PROJECT, name: 'shop', primaryEnvironmentId: ENVIRONMENT,
      environments: { edges: [{ node: { id: ENVIRONMENT, name: 'production' } }, { node: { id: OTHER, name: 'pr-4' } }] },
      services: { edges: [{ node: { id: SERVICE, name: 'api' } }] },
    } }] } })
    if (query.includes('latestDeployment')) return data({ serviceInstance: {
      serviceName: 'api', activeDeployments: active.map((id) => ({ id })),
      latestDeployment: { id: DEPLOYMENT, status: 'SUCCESS', createdAt: '2026-11-28T10:00:00Z', deploymentStopped: active.length === 0, staticUrl: 'api.up.railway.app', url: null, canRedeploy: true, canRollback: false, meta: { commitHash: 'abcdef1234' } },
      domains: { serviceDomains: [{ domain: 'api.up.railway.app' }], customDomains: [] },
    } })
    if (query.includes('deploymentLogs')) return data({ logs: [{ timestamp: '2026-11-28T10:00:01Z', severity: 'info', message: 'listening on 8080' }] })
    if (query.includes('deploymentStop')) { active = []; return data({ deploymentStop: true }) }
    if (query.includes('deploymentRestart')) return data({ deploymentRestart: true })
    if (query.includes('serviceInstanceDeployV2')) { active = [DEPLOYMENT]; return data({ id: '66666666-6666-4666-8666-666666666666' }) }
    if (query.includes('variableCollectionUpsert')) { Object.assign(variables, (input.input as { variables: Record<string, string> }).variables); return data({ variableCollectionUpsert: true }) }
    if (query.includes('variables(')) return data({ variables })
    if (query.includes('serviceCreate')) return data({ serviceCreate: { id: OTHER, name: (input.input as { name: string }).name } })
    return new Response(JSON.stringify({ errors: [{ message: `unexpected ${query.slice(0, 40)}` }] }), { status: 200 })
  }) as unknown as typeof fetch
  return { calls, variables, client: new RailwayClient({ token: 'railway-test-token', fetch: fetcher }) }
}

async function channelBoard(repository: string | null) {
  const team = openBoard({ backend: local({ memory: true }) })
  await team.post('work/shop', 'channel')
  await team.configureChannel('work/shop', {
    repository, routes: [],
    railway: { projectId: PROJECT, projectName: 'shop', environmentId: ENVIRONMENT, services: [{ id: SERVICE, name: 'api' }] },
  } as never)
  return team
}

describe('railway operations', () => {
  test('status, logs, stop and start of an attached service post status lines in the channel', async () => {
    const railway = fakeRailway()
    const team = await channelBoard('https://github.com/owner/shop')
    const posted: string[] = []
    const post = team.post.bind(team)
    team.post = ((path: string, input: { text: string }) => { posted.push(input.text); return post(path, input as never) }) as typeof team.post
    const operations = new RailwayOperations({ client: railway.client, board: team })
    const status = await operations.status('work/shop', SERVICE)
    assert.equal(status.latest?.status, 'SUCCESS')
    assert.deepEqual(status.domains, ['api.up.railway.app'])
    assert.equal((await operations.logs('work/shop', SERVICE, 'deploy', 50)).lines[0]!.message, 'listening on 8080')
    assert.equal(await operations.act('work/shop', SERVICE, 'stop', 'tester'), 'api stopped')
    assert.equal((await operations.status('work/shop', SERVICE, true)).active.length, 0)
    await assert.rejects(operations.act('work/shop', SERVICE, 'restart', 'tester'), /runs no deployment/)
    assert.match(await operations.act('work/shop', SERVICE, 'start', 'tester'), /^api deployment 66666666 started$/)
    assert.ok(posted.some((text) => text.includes('api stopped, on request of tester')))
    assert.ok(railway.calls.every((call) => !/delete|remove/i.test(call.query)))
  })

  test('a service that is not attached to the channel is refused', async () => {
    const railway = fakeRailway()
    const operations = new RailwayOperations({ client: railway.client, board: await channelBoard('https://github.com/owner/shop') })
    await assert.rejects(operations.act('work/shop', OTHER, 'stop', 'tester'), /not attached/)
    assert.equal(railway.calls.length, 0)
  })

  test('variables are set; a removal becomes a task that waits for a person', async () => {
    const railway = fakeRailway()
    const team = await channelBoard('https://github.com/owner/shop')
    const operations = new RailwayOperations({ client: railway.client, board: team })
    assert.equal((await operations.variables('work/shop', SERVICE)).PORT, '8080')
    const outcome = await operations.setVariables('work/shop', SERVICE, { set: { PORT: '9090' }, remove: ['DATABASE_URL'] }, 'tester')
    assert.deepEqual(outcome.set, ['PORT'])
    assert.equal(railway.variables.PORT, '9090')
    assert.equal(railway.variables.DATABASE_URL, 'postgres://x')
    const task = await team.thread(outcome.removal_task!)
    assert.equal(task.message.labels[ATTENTION_LABEL], 'orchestrator')
    assert.equal(task.message.task?.state, 'blocked')
    assert.match(task.message.text, /DATABASE_URL/)
  })

  test('a channel without a GitHub repository gets no service, only a task for a person', async () => {
    const railway = fakeRailway()
    const team = await channelBoard(null)
    const operations = new RailwayOperations({ client: railway.client, board: team })
    await assert.rejects(operations.createService('work/shop', { name: 'web' }, 'tester'), /links no GitHub repository/)
    assert.ok(railway.calls.every((call) => !call.query.includes('serviceCreate')))
    const tasks = (await team.tasks.list({})).tasks.map((summary) => summary.message).filter((message) => message.labels[ATTENTION_LABEL])
    assert.equal(tasks.length, 1)
    assert.match(tasks[0]!.text, /private repository/)
  })

  test('a channel with a GitHub repository gets a service from it', async () => {
    const railway = fakeRailway()
    const operations = new RailwayOperations({ client: railway.client, board: await channelBoard('https://github.com/owner/shop') })
    assert.deepEqual(await operations.createService('work/shop', { name: 'web' }, 'tester'), { id: OTHER, name: 'web' })
    const create = railway.calls.find((call) => call.query.includes('serviceCreate'))!
    assert.deepEqual(create.variables.input, { projectId: PROJECT, environmentId: ENVIRONMENT, name: 'web', source: { repo: 'owner/shop' } })
  })

  test('projects list the production environment only', async () => {
    const operations = new RailwayOperations({ client: fakeRailway().client, board: await channelBoard(null) })
    const [project] = await operations.projects()
    assert.deepEqual(project!.production, { id: ENVIRONMENT, name: 'production' })
  })

  test('the status server routes the Railway tab and refuses unknown routes', async () => {
    const railway = fakeRailway()
    const operations = new RailwayOperations({ client: railway.client, board: await channelBoard('https://github.com/owner/shop') })
    const server = await startOperationsServer({ monitor: new OperationsMonitor({ relayUrl: 'http://127.0.0.1:9' }), port: 0, snapshot: () => ({}) as never, railway: operations })
    try {
      const root = `${server.url.replace(/\/+$/, '')}/railway/channels/${encodeURIComponent('work/shop')}/services`
      const listed = await (await fetch(root)).json() as { services: Array<{ name: string }> }
      assert.equal(listed.services[0]!.name, 'api')
      const set = await fetch(`${root}/${SERVICE}/variables`, { method: 'PUT', body: JSON.stringify({ set: { A: '1' } }) })
      assert.equal(set.status, 200)
      assert.equal((await fetch(`${root}/${SERVICE}/delete`, { method: 'POST' })).status, 404)
      assert.equal((await fetch(`${root}/${SERVICE}/restart`)).status, 405)
    } finally {
      await server.close()
    }
  })

  test('the thread assistant offers Railway actions only in a channel with Railway services', () => {
    const none = applicableActions({ task: null, pull_request: null, worker: null, railway: null })
    assert.deepEqual(Object.keys(none), ['needs_attention'])
    const some = applicableActions({ task: null, pull_request: null, worker: null, railway: { project: 'shop', services: [{ name: 'api', status: 'SUCCESS', deployed_at: null, stopped: false, domains: [], log_tail: [] }] } })
    assert.ok(['railway_restart', 'railway_stop', 'railway_redeploy'].every((name) => name in some))
    assert.ok(!Object.keys(some).some((name) => /delete|remove/.test(name)))
    assert.ok(ThreadAssistant)
  })
})
