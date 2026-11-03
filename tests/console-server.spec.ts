/** Tests for the console sidecar server: loopback binding and Host checks, page and bundle routes, and the same-origin proxy contract. */
import { createServer, request } from 'node:http'
import { expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConsoleServer } from '../src/console/server.ts'

/** A real directory the settings view can name as the execution root. */
async function mkdtempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sp2-server-root-'))
}

/** Create a static directory holding a stub console bundle, as the Task 6 build will. */
async function mkdtempLite(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'console-static-'))
  await writeFile(join(dir, 'console.js'), 'export default 1')
  return dir
}

/** Ask the sidecar with chosen headers, as a rebinding page would; undici's fetch refuses to override Host. */
function ask(target: string, headers: Record<string, string>, method: 'GET' | 'POST' = 'GET',
  body?: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let done = false
    const req = request(target, { method, headers }, res => {
      const parts: Buffer[] = []
      res.on('data', part => parts.push(Buffer.from(part)))
      res.on('end', () => { done = true; resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8') }) })
    })
    req.on('error', error => { if (!done) reject(error) })
    req.end(body)
  })
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
  const sidecarPort = (server.server.address() as { port: number }).port
  const api = await fetch(`${base}/orchestrator/api/state`, { headers: { origin: `http://127.0.0.1:${sidecarPort}` } })
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

it('refuses a foreign Host or Origin and accepts the same request on the loopback origin', async () => {
  let hits = 0
  const upstream = createServer((req, res) => {
    hits++
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}')
  })
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))
  const server = await ConsoleServer.start({ port: 0, upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    staticDir: await mkdtempLite() })
  // A rebinding page presents its own domain as Host; the sidecar, like the panel's sameOrigin check, refuses it.
  const refused = await ask(`${server.url}/healthz`, { host: 'evil.example:3083' })
  expect(refused.status).toBe(403)
  expect(refused.body).toBe('{"error":"loopback host required"}')
  const foreignOrigin = await ask(`${server.url}/orchestrator/api/state`, { origin: 'http://evil.example' })
  expect(foreignOrigin.status).toBe(403)
  expect(foreignOrigin.body).toBe('{"error":"loopback host required"}')
  // The same request with the loopback Host passes, healthz included.
  const port = (server.server.address() as { port: number }).port
  expect(await ask(`${server.url}/healthz`, { host: `127.0.0.1:${port}` })).toMatchObject({ status: 200, body: '{"ok":true}' })
  expect(await ask(`${server.url}/healthz`, { host: `localhost:${port}` })).toMatchObject({ status: 200 })
  expect(hits).toBe(0) // no refused request reached the upstream
  upstream.closeAllConnections()
  await new Promise(r => upstream.close(r))
  await server.close()
})

it('answers a proxied body over one mebibyte with 413 and never forwards it', async () => {
  let hits = 0
  const upstream = createServer((req, res) => {
    hits++
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}')
  })
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))
  const server = await ConsoleServer.start({ port: 0, upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    staticDir: await mkdtempLite() })
  const reply = await ask(`${server.url}/orchestrator/api/console/threads`, { 'content-type': 'application/json' }, 'POST',
    Buffer.alloc(1024 * 1024 + 1, 0x61)) // one byte over the cap
  expect(reply.status).toBe(413)
  expect(reply.body).toBe('{"error":"request too large"}')
  await new Promise(r => setTimeout(r, 25)) // 上游若被触碰，此刻必然已计数
  expect(hits).toBe(0)
  upstream.closeAllConnections()
  await new Promise(r => upstream.close(r))
  await server.close()
})

it('answers /api/accounts through the mounted account domain, behind the Host check, and stops its runners on close', async () => {
  const executionRoot = await mkdtempRoot()
  const upstream = createServer((req, res) => {
    if (req.url === '/orchestrator/api/settings') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ environment: { root: executionRoot, variables: [] } }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}')
  })
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))
  const server = await ConsoleServer.start({ port: 0,
    upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, staticDir: await mkdtempLite() })
  try {
    const cards = await (await fetch(`${server.url}/api/accounts`)).json() as { platform: string }[]
    expect(cards.map(card => card.platform)).toEqual(['xiaohongshu', 'bilibili', 'douyin', 'wechat-oa'])
    // Host 校验先于一切路由：坏 Host 的 /api 请求同样被拒
    const refused = await ask(`${server.url}/api/accounts`, { host: 'evil.example:3083' })
    expect(refused.status).toBe(403)
  } finally {
    await server.close()   // close 现在也回收账号 runner——不崩即通过
    upstream.closeAllConnections()
    await new Promise<void>(r => upstream.close(() => r()))
  }
})
