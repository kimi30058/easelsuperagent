/** The sidecar's execution-root resolver: the orchestrator's settings view says which workspace the console serves. */
import { AccountError } from './login-runner.ts'

/** The execution root shared by every sidecar API domain (accounts, publish): resolved once and pinned for the
 *  sidecar's lifetime — a rebuilt or migrated workspace is picked up by restarting the sidecar, never by switching
 *  roots under live runners; 503 only while it has never been known. */
export class ExecutionRoot {
  private readonly deps: { upstream: string }
  private root?: string
  private flight?: Promise<string>
  constructor(deps?: { upstream?: string }) {
    this.deps = { upstream: deps?.upstream ?? process.env.EASEL_SUPERAGENT_URL ?? 'http://127.0.0.1:3082' }
  }
  /** The pinned execution root. The first resolution is single-flight — 登录/发布轮询 1s 一发，无 single-flight 时
   *  未解析窗口里每个请求各挂一次 4s 的拉取；失败的航班由下一个请求重试，成功即终身钉死。 */
  async get(): Promise<string> {
    if (this.root !== undefined) return this.root
    const flight = this.flight ??= this.readSettingsRoot()
    try {
      this.root = await flight
      return this.root
    } finally {
      if (this.flight === flight) this.flight = undefined
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
