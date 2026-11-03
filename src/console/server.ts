import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AccountsApi } from './accounts-api.ts'
import { ExecutionRoot } from './execution-root.ts'
import { PublishApi } from './publish-api.ts'
import INDEX from './index.html?raw'

export interface ConsoleServerOptions { port?: number; host?: string; upstream?: string; staticDir?: string }
/** Buffered proxied request bodies stop at this size; the orchestrator's own smaller cap fires only after buffering. */
const MAX_BODY_BYTES = 1024 * 1024
/** Loopback sidecar serving the console page and proxying the orchestrator API server-side, so the panel's same-origin contract holds unchanged. */
export class ConsoleServer {
  private constructor(readonly server: Server, readonly url: string, private readonly accounts: AccountsApi) {}
  static async start(options: ConsoleServerOptions = {}): Promise<ConsoleServer> {
    // The bind host is the loopback constant, never a caller's `options.host`: the console serves one operator on this machine.
    const config: Required<ConsoleServerOptions> = { port: options.port ?? Number(process.env.CONSOLE_PORT ?? 3083), host: '127.0.0.1',
      upstream: options.upstream ?? process.env.EASEL_SUPERAGENT_URL ?? 'http://127.0.0.1:3082',
      staticDir: options.staticDir ?? join(dirname(fileURLToPath(import.meta.url)), 'console') }
    // The execution root is one resolver shared by every sidecar API domain, so they always speak of one workspace.
    const root = new ExecutionRoot({ upstream: config.upstream })
    const accounts = new AccountsApi({ upstream: config.upstream, root })
    const publishes = new PublishApi({ root })
    // Requests only arrive after listening replaces `bound` with the resolved port (ephemeral when 0 was requested),
    // which is the port every Host check below compares against.
    let bound: Bound = { ...config, accounts, publishes }
    // A request that fails (a client aborting mid-body, an unparseable URL) destroys its socket instead of rejecting
    // an unhandled promise and taking the process down.
    const server = createServer((req, res) => void handle(bound, req, res).catch(() => res.destroy()))
    await new Promise<void>(resolve => server.listen(config.port, config.host, resolve))
    bound = { ...bound, port: (server.address() as { port: number }).port }
    return new ConsoleServer(server, `http://127.0.0.1:${bound.port}`, accounts)
  }
  async close(): Promise<void> {
    // The account domain's login runners die with the sidecar, marked expired so the next start is clean.
    await this.accounts.stopAll()
    this.server.closeAllConnections()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }
}
type Bound = Required<ConsoleServerOptions> & { accounts: AccountsApi; publishes: PublishApi }
async function handle(config: Bound, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  // The Host check is the sidecar's DNS-rebinding defense, mirroring sameOrigin() in src/app/http.ts: a page whose domain
  // rebinds to 127.0.0.1 presents its own Host (or Origin) and is refused before any route, healthz included.
  const host = req.headers.host
  const loopback = host === `127.0.0.1:${config.port}` || host === `localhost:${config.port}`
  if (!loopback || (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`))
    return send(res, 403, 'application/json', '{"error":"loopback host required"}')
  if (url.pathname === '/healthz') return send(res, 200, 'application/json', '{"ok":true}')
  if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, 'text/html; charset=utf-8', INDEX, 'no-cache')
  if (url.pathname === '/console.js') {
    try { return send(res, 200, 'application/javascript', await readFile(join(config.staticDir, 'console.js'), 'utf8'), 'no-cache') }
    catch { return send(res, 404, 'application/json', '{"error":"console bundle not built"}') }
  }
  if (url.pathname.startsWith('/api/')) {
    // The console's own domains live in this sidecar (SP1's shape: SP2+ adds routes here, never proxied); each
    // claims its prefix, and each answers a malformed escape 400 itself, so the order between them carries no weight.
    if (await config.publishes.handle(req, url, res)) return
    await config.accounts.handle(req, url, res)
    return
  }
  if (url.pathname.startsWith('/orchestrator/api/')) {
    const headers: Record<string, string> = { 'x-orchestrator-request': '1' } // 不透传 Origin/Host：服务端请求无浏览器origin
    if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type'])
    try {
      // The body is buffered inside the guard: a client aborting mid-body rejects the iterator here, not at the process level.
      // Over the cap nothing is buffered or forwarded; the rest is drained so the client always reads the 413 instead of a reset.
      const chunks: Buffer[] = []; let size = 0; let over = false
      for await (const chunk of req) {
        if (over) continue
        size += chunk.length
        if (size > MAX_BODY_BYTES) { over = true; send(res, 413, 'application/json', '{"error":"request too large"}'); continue }
        chunks.push(Buffer.from(chunk))
      }
      if (over) return
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
  void ConsoleServer.start().then(server => {
    console.log(`console at ${server.url}`)
    // A managed stop (the service script restarts the sidecar) terminates login runners so none outlives the sidecar.
    const shutdown = (): void => { void server.close().finally(() => process.exit(0)) }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  })
