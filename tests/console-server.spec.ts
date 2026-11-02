/** Tests for the console sidecar server: loopback binding, page and bundle routes, and the same-origin proxy contract. */
import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConsoleServer } from '../src/console/server.ts'

/** Create a static directory holding a stub console bundle, as the Task 6 build will. */
async function mkdtempLite(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'console-static-'))
  await writeFile(join(dir, 'console.js'), 'export default 1')
  return dir
}

it('serves the page, proxies the API with the panel header and no Origin, and passes 502 through', async () => {
  let seen: Record<string, string | string[] | undefined> = {}
  let reply: [number, string] = [200, '{"ok":true}']
  const upstream = createServer((req, res) => {
    seen = req.headers
    res.writeHead(reply[0], { 'content-type': 'application/json' }); res.end(reply[1])
  })
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))
  const port = (upstream.address() as { port: number }).port
  const staticDir = await mkdtempLite()
  const server = await ConsoleServer.start({ port: 0, upstream: `http://127.0.0.1:${port}`, staticDir })
  const base = server.url
  expect((server.server.address() as { address: string }).address).toBe('127.0.0.1') // Review Focus 5
  expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true })
  expect((await fetch(`${base}/`)).headers.get('content-type')).toContain('text/html')
  const api = await fetch(`${base}/orchestrator/api/state`, { headers: { origin: 'http://127.0.0.1:3083' } })
  expect(seen['x-orchestrator-request']).toBe('1') // Review Focus 1: what the upstream received
  expect(seen.origin).toBeUndefined()
  expect(seen.host).toBe(`127.0.0.1:${port}`) // the proxy never forwards the browser's Host
  expect(await api.json()).toEqual({ ok: true })
  reply = [500, '{"error":"x"}']
  const failed = await fetch(`${base}/orchestrator/api/state`)
  expect(failed.status).toBe(500)
  expect(await failed.json()).toEqual({ error: 'x' }) // upstream error statuses pass through with their body
  // Close the upstream but keep the sidecar listening: proxied requests must answer 502, so the keep-alive
  // sockets the sidecar's fetch pool still holds are torn down instead of being served by the closing server.
  upstream.closeAllConnections()
  await new Promise(r => upstream.close(r))
  const unreachable = await fetch(`${base}/orchestrator/api/state`, { method: 'POST' })
  expect(unreachable.status).toBe(502) // 上游已关
  expect(await unreachable.json()).toEqual({ error: 'orchestrator unreachable' })
  await server.close()
})

it('serves the console bundle as javascript', async () => {
  const staticDir = await mkdtempLite()
  const server = await ConsoleServer.start({ port: 0, upstream: 'http://127.0.0.1:9', staticDir })
  const bundle = await fetch(`${server.url}/console.js`)
  expect(bundle.status).toBe(200)
  expect(bundle.headers.get('content-type')).toContain('application/javascript')
  expect(await bundle.text()).toBe('export default 1')
  await server.close()
})

it('forwards a POST with its body and content-type to the upstream', async () => {
  let received = { method: '', type: '', body: '' }
  const upstream = createServer((req, res) => void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    received = { method: req.method ?? '', type: String(req.headers['content-type']), body: Buffer.concat(chunks).toString('utf8') }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}')
  })())
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))
  const server = await ConsoleServer.start({ port: 0, upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    staticDir: await mkdtempLite() })
  const reply = await fetch(`${server.url}/orchestrator/api/console/threads`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{"text":"写一篇小红书帖子"}' })
  expect(reply.status).toBe(200)
  expect(await reply.json()).toEqual({ ok: true })
  expect(received.method).toBe('POST')
  expect(received.type).toBe('application/json')
  expect(received.body).toBe('{"text":"写一篇小红书帖子"}')
  upstream.closeAllConnections()
  await new Promise(r => upstream.close(r))
  await server.close()
})
