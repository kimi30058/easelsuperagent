/** The sidecar's execution-root resolver: the orchestrator's settings view says which workspace the console serves. */
import { AccountError } from './login-runner.ts'

/** How stale the cached execution root may be before one request re-reads the orchestrator's settings view:
 *  a workspace migration is picked up within this window, without restarting the sidecar. */
const ROOT_REFRESH_MS = 30_000

/** The execution root shared by every sidecar API domain (accounts, publish): cached with a TTL, 503 until first known. */
export class ExecutionRoot {
  private readonly deps: { upstream: string; now: () => number }
  private root?: string
  private refreshedAt = 0
  constructor(deps?: { upstream?: string; now?: () => number }) {
    this.deps = { upstream: deps?.upstream ?? process.env.EASEL_SUPERAGENT_URL ?? 'http://127.0.0.1:3082',
      now: deps?.now ?? (() => Date.now()) }
  }
  /** The execution root, cached no longer than ROOT_REFRESH_MS; 503 only while it has never been known — a failed
   *  refresh keeps serving the stale root instead of failing the panel. */
  async get(): Promise<string> {
    if (this.root !== undefined && this.deps.now() - this.refreshedAt < ROOT_REFRESH_MS) return this.root
    try {
      const root = await this.readSettingsRoot()
      this.root = root
      this.refreshedAt = this.deps.now()
      return root
    } catch (error) {
      // TTL 到点后的刷新失败不是断供：旧根继续服务；503 只属于从未拿到过根的 sidecar。
      // 失败也记时刻——否则编排器假死时每个请求都重挂一次 4s 的拉取（登录轮询 1s 一发，会堆积）。
      if (this.root === undefined) throw error
      this.refreshedAt = this.deps.now()
      return this.root
    }
  }
  /** One settings read; throws the 503 with its own words when the orchestrator is unreachable or the root is missing. */
  private async readSettingsRoot(): Promise<string> {
    let settings: { environment?: { root?: unknown } }
    try {
      // The sidecar header the orchestrator's sameOrigin() check demands, as the proxied paths send it (server.ts).
      const response = await fetch(`${this.deps.upstream}/orchestrator/api/settings`,
        { headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(4000) })
      if (!response.ok) throw new Error(`settings ${response.status}`)
      settings = await response.json() as typeof settings
    } catch { throw new AccountError(503, '编排器不可达，无法定位工作根目录') }
    const root = settings.environment?.root
    if (typeof root !== 'string' || !root) throw new AccountError(503, '编排器设置缺少工作根目录')
    return root
  }
}
