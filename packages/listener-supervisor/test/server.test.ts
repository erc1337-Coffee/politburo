import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { buildOutput, demultiplex, LABEL, parseAddresses, startSupervisor } from '../src/server.ts'

/** A Docker Engine stand-in on a Unix socket: one model of containers by name. */
function fakeDocker(socket: string) {
  const calls: Array<{ method: string; path: string; body: string }> = []
  const containers = new Map<string, { labels: Record<string, string>; running: boolean; config: any }>()
  containers.set('politburo-listener-foreign', { labels: {}, running: true, config: {} })
  const server = createServer(async (request: IncomingMessage, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const path = request.url!.replace(/^\/v1\.\d+/, '')
    calls.push({ method: request.method!, path, body: request.headers['content-type'] === 'application/json' ? body.toString() : `${body.length} bytes` })
    const send = (status: number, value?: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(value === undefined ? '' : JSON.stringify(value))
    const name = /^\/containers\/([^/?]+)/.exec(path)?.[1]
    if (path.startsWith('/build')) return response.writeHead(200).end('{"stream":"Step 1/2 : FROM node\n"}\n{"stream":"Successfully built\n"}\n')
    if (path.startsWith('/containers/create')) {
      const created = new URL(path, 'http://d').searchParams.get('name')!
      const config = JSON.parse(body.toString())
      containers.set(created, { labels: config.Labels, running: false, config })
      return send(201, { Id: created })
    }
    if (path.startsWith('/networks/create')) return send(201, { Id: 'network' })
    if (path.startsWith('/networks/')) return send(404, { message: 'no such network' })
    if (path.startsWith('/containers/json')) {
      const wanted = (JSON.parse(new URL(path, 'http://d').searchParams.get('filters')!) as { label: string[] }).label[0]!
      const [key, value] = wanted.split('=')
      return send(200, [...containers].filter(([, entry]) => key! in entry.labels && (value === undefined || entry.labels[key!] === value))
        .map(([containerName, entry]) => ({ Names: [`/${containerName}`], Labels: entry.labels })))
    }
    const container = name ? containers.get(name) : undefined
    if (!container) return send(404, { message: 'no such container' })
    if (path.endsWith('/json')) return send(200, {
      Config: { Labels: container.labels, Image: container.config.Image }, RestartCount: 0,
      State: { Status: container.running ? 'running' : 'exited', Running: container.running, StartedAt: '2026-11-28T00:00:00Z', FinishedAt: null, ExitCode: 0 },
      HostConfig: container.config.HostConfig ?? {},
    })
    if (path.includes('/start')) { container.running = true; return send(204) }
    if (path.includes('/stop')) { container.running = false; return send(204) }
    if (request.method === 'DELETE') { containers.delete(name!); return send(204) }
    if (path.includes('/logs')) {
      const line = Buffer.from('2026-11-28T00:00:01Z listening\n')
      const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(line.length, 4)
      return response.writeHead(200).end(Buffer.concat([header, line]))
    }
    send(404, { message: 'unknown' })
  })
  server.listen(socket)
  return { server, calls, containers }
}

describe('listener supervisor', () => {
  let directory: string
  let docker: ReturnType<typeof fakeDocker>
  let supervisor: Server
  let url: string
  before(async () => {
    directory = mkdtempSync(join(tmpdir(), 'listener-supervisor-'))
    docker = fakeDocker(join(directory, 'docker.sock'))
    supervisor = startSupervisor({ socket: join(directory, 'docker.sock'), addresses: { lan: '192.168.1.10', wireguard: '10.77.0.4' }, host: '127.0.0.1', port: 0, memoryBytes: 512 * 1024 * 1024, cpus: 1 })
    await new Promise((resolve) => supervisor.once('listening', resolve))
    url = `http://127.0.0.1:${(supervisor.address() as AddressInfo).port}`
  })
  after(() => {
    supervisor.close()
    docker.server.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${url}${path}`, init)
    return { status: response.status, body: await response.json() as any }
  }

  test('builds, runs on the chosen addresses only, stops, starts and reads logs', async () => {
    const built = await call('/listeners/shop-web/build?dockerfile=Dockerfile.politburo', { method: 'POST', body: Buffer.from('tar') })
    assert.equal(built.status, 200)
    assert.equal(built.body.image, 'politburo-listener-shop-web:latest')
    assert.match(docker.calls.find((entry) => entry.path.startsWith('/build'))!.path, /dockerfile=Dockerfile\.politburo/)
    const run = await call('/listeners/shop-web/run', { method: 'POST', body: JSON.stringify({ port: 8080, container_port: 3000, addresses: ['192.168.1.10'] }) })
    assert.equal(run.status, 200)
    assert.equal(run.body.running, true)
    assert.deepEqual(run.body.ports, [{ address: '192.168.1.10', port: 8080 }])
    const both = await call('/listeners/shop-web/run', { method: 'POST', body: JSON.stringify({ port: 8080, container_port: 3000, addresses: ['192.168.1.10', '10.77.0.4'] }) })
    assert.deepEqual(both.body.ports, [{ address: '192.168.1.10', port: 8080 }, { address: '10.77.0.4', port: 8080 }])
    const forwarder = docker.containers.get('politburo-listener-shop-web-forward-1')!.config
    assert.deepEqual(forwarder.Cmd, ['TCP-LISTEN:3000,fork,reuseaddr', 'TCP:politburo-listener-shop-web:3000'])
    assert.equal(forwarder.HostConfig.NetworkMode, 'politburo-listener-shop-web')
    assert.equal((await call('/listeners/shop-web/stop', { method: 'POST' })).status, 200)
    assert.equal(docker.containers.get('politburo-listener-shop-web-forward-1')!.running, false)
    const config = docker.containers.get('politburo-listener-shop-web')!.config
    assert.deepEqual(config.Env, ['PORT=3000'])
    assert.equal(config.HostConfig.Privileged, false)
    assert.deepEqual(config.HostConfig.Binds, [])
    assert.equal(config.HostConfig.Memory, 512 * 1024 * 1024)
    assert.equal((await call('/listeners/shop-web/stop', { method: 'POST' })).body.running, false)
    assert.equal((await call('/listeners/shop-web/start', { method: 'POST' })).body.running, true)
    assert.deepEqual((await call('/listeners/shop-web/logs?tail=5')).body.lines, ['2026-11-28T00:00:01Z listening'])
    assert.deepEqual((await call('/listeners')).body.listeners.map((entry: { id: string }) => entry.id), ['shop-web'])
  })

  test('refuses other addresses, bad ids, foreign containers and other routes', async () => {
    assert.equal((await call('/listeners/shop-web/run', { method: 'POST', body: JSON.stringify({ port: 8080, addresses: ['0.0.0.0'] }) })).status, 400)
    assert.equal((await call('/listeners/Shop!/start', { method: 'POST' })).status, 400)
    assert.equal((await call('/listeners/foreign/stop', { method: 'POST' })).status, 409)
    assert.equal((await call('/containers/json')).status, 404)
    assert.equal((await call('/listeners/shop-web', { method: 'DELETE' })).status, 405)
  })

  test('parses addresses and Docker streams', () => {
    assert.deepEqual(parseAddresses('lan=192.168.1.10, wireguard=10.77.0.4'), { lan: '192.168.1.10', wireguard: '10.77.0.4' })
    assert.throws(() => parseAddresses('lan=nowhere'))
    assert.deepEqual(buildOutput(Buffer.from('{"stream":"a\\n"}\n{"error":"x","errorDetail":{"message":"broken"}}\n')), { lines: ['a'], error: 'broken' })
    assert.equal(demultiplex(Buffer.from('plain text')), 'plain text')
  })
})
