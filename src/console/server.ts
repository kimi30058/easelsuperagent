import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import INDEX from './index.html?raw'

export interface ConsoleServerOptions { port?: number; host?: string; upstream?: string; staticDir?: string }
/** Loopback sidecar serving the console page and proxying the orchestrator API server-side, so the panel's same-origin contract holds unchanged. */
export class ConsoleServer {
  private constructor(readonly server: Server, readonly url: string) {}
  static async start(options: ConsoleServerOptions = {}): Promise<ConsoleServer> {
    // The bind host is the loopback constant, never a caller's `options.host`: the console serves one operator on this machine.
    const config: Required<ConsoleServerOptions> = { port: options.port ?? Number(process.env.CONSOLE_PORT ?? 3083), host: '127.0.0.1',
      upstream: options.upstream ?? process.env.EASEL_SUPERAGENT_URL ?? 'http://127.0.0.1:3082',
      staticDir: options.staticDir ?? join(dirname(fileURLToPath(import.meta.url)), 'console') }
    const server = createServer((req, res) => void handle(config, req, res))
    await new Promise<void>(resolve => server.listen(config.port, config.host, resolve))
    return new ConsoleServer(server, `http://127.0.0.1:${(server.address() as { port: number }).port}`)
  }
  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }
}
async function handle(config: Required<ConsoleServerOptions>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/healthz') return send(res, 200, 'application/json', '{"ok":true}')
  if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, 'text/html; charset=utf-8', INDEX, 'no-cache')
  if (url.pathname === '/console.js') {
    try { return send(res, 200, 'application/javascript', await readFile(join(config.staticDir, 'console.js'), 'utf8'), 'no-cache') }
    catch { return send(res, 404, 'application/json', '{"error":"console bundle not built"}') }
  }
  if (url.pathname.startsWith('/orchestrator/api/')) {
    const headers: Record<string, string> = { 'x-orchestrator-request': '1' } // 不透传 Origin/Host：服务端请求无浏览器origin
    if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type'])
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    try {
      const upstream = await fetch(config.upstream + url.pathname + url.search,
        { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined })
      return send(res, upstream.status, 'application/json; charset=utf-8', await upstream.text(), 'no-store')
    } catch { return send(res, 502, 'application/json', '{"error":"orchestrator unreachable"}') }
  }
  return send(res, 404, 'application/json', '{"error":"not found"}')
}
function send(res: ServerResponse, status: number, type: string, body: string, cache = 'no-store'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff' }); res.end(body)
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, '')))
  void ConsoleServer.start().then(server => console.log(`console at ${server.url}`))
