/** Analytics fetch runners: one serial queue over the three script backends, timeout with group-kill escalation, and the stale catch-up. */
import { spawn as nodeSpawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pythonBin } from './python.ts'
import { bilibiliCookiePath, loggedInFast, type LoginPlatform, type ProcessKey } from './login-protocol.ts'
import { appendSnapshot, lastJsonObject, latestPath, writeLatest } from './analytics-protocol.ts'

/** The three fetch backends' timeouts: browsers are slow, mp's web session slowest (原版 web 口径). */
export const ANALYTICS_TIMEOUT_MS: Record<LoginPlatform, number> = {
  xiaohongshu: 90_000, douyin: 90_000, kuaishou: 90_000, 'weixin-channels': 90_000, zhihu: 90_000,
  bilibili: 90_000, 'wechat-oa': 180_000,
}

/** One platform's fetch argv with every path explicit (ADR-0007); account_stats 的五家共用 --platform <key>。 */
export function analyticsCommand({ root, scriptsDir, python }: { root: string; scriptsDir: string; python?: string }, platform: LoginPlatform): string[] {
  const script = (name: string) => join(scriptsDir, name)
  const py = python ?? pythonBin(scriptsDir)
  switch (platform) {
    case 'bilibili': return [py, script('bili_login.py'), 'stats', '--cookie', bilibiliCookiePath(root)]
    case 'wechat-oa': return [py, script('weixin_mp_stats.py'), 'stats', '--count', '20']
    default: return [py, script('account_stats.py'), 'fetch', '--platform', platform]
  }
}

/** A spawned fetch as the queue sees it: pid, exit fact, the collected stdout, and a kill by signal. */
export interface FetchHandle {
  readonly pid: number; readonly exited: Promise<number | null>; readonly stdout: Promise<string>
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void
}
export type SpawnAnalytics = (cmd: string[], options: { cwd: string; env: Record<string, string> }) => FetchHandle

const realSpawnAnalytics: SpawnAnalytics = (cmd, options) => {
  // detached + 负 pid = 进程组：超时杀组，Playwright 的浏览器树一并退（login-runner 同款纪律）。
  const child = nodeSpawn(cmd[0]!, cmd.slice(1), { cwd: options.cwd, env: options.env, detached: true,
    stdio: ['ignore', 'pipe', 'ignore'] })
  const exited = new Promise<number | null>(resolve => {
    // ENOENT 只发 error 不发 exit：不接住会悬空 + 未捕获异常带崩 sidecar（login-runner 同款教训）。
    child.on('error', () => resolve(null))
    child.on('exit', (code, signal) => resolve(signal ? null : code))
  })
  const stdout = new Promise<string>(resolve => {
    let text = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { text += chunk })
    child.stdout.on('end', () => resolve(text))
    child.stdout.on('error', () => resolve(text))
  })
  const kill = (signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void => {
    try { process.kill(-child.pid!, signal) } catch { try { child.kill(signal) } catch { /* already gone */ } }
  }
  return { pid: child.pid ?? 0, exited, stdout, kill }
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
/** wechat-oa 的取数会话是 mp 后台（wechat-oa-mp 键），其余平台键即自身。 */
const processKeyOf = (platform: LoginPlatform): ProcessKey => platform === 'wechat-oa' ? 'wechat-oa-mp' : platform

export type FetchState = 'idle' | 'queued' | 'fetching' | 'failed'

/** The analytics fetches of one sidecar process: a serial queue (one Playwright profile is never concurrent), inflight
 *  idempotence, timeout escalation, batch progress, and a stale catch-up the api's hourly tick drives. */
export class AnalyticsRunners {
  private readonly queued: LoginPlatform[] = []
  private running?: { readonly platform: LoginPlatform; readonly handle: FetchHandle }
  private readonly states = new Map<LoginPlatform, FetchState>()
  private batch = { done: 0, total: 0 }
  private readonly deps: { root: string; scriptsDir: string; python: string; spawn: SpawnAnalytics; now: () => number;
    staleMs: number; terminateWindowMs: number; timeouts: Record<LoginPlatform, number> }
  constructor(deps: { root: string; scriptsDir: string; python?: string; spawn?: SpawnAnalytics; now?: () => number;
    staleMs?: number; terminateWindowMs?: number; timeouts?: Record<LoginPlatform, number> }) {
    this.deps = { root: deps.root, scriptsDir: deps.scriptsDir, python: deps.python ?? pythonBin(deps.scriptsDir),
      spawn: deps.spawn ?? realSpawnAnalytics, now: deps.now ?? (() => Date.now()), staleMs: deps.staleMs ?? 20 * 3600_000,
      terminateWindowMs: deps.terminateWindowMs ?? 8000, timeouts: deps.timeouts ?? ANALYTICS_TIMEOUT_MS }
  }
  /** Enqueue one platform; false when it is already queued or fetching (幂等，spec §3). */
  async enqueue(platform: LoginPlatform): Promise<boolean> {
    const state = this.stateOf(platform)
    if (state === 'queued' || state === 'fetching') return false
    this.states.set(platform, 'queued')
    this.queued.push(platform)
    this.batch.total += 1
    this.pump()
    return true
  }
  /** Enqueue every logged-in platform; returns how many actually entered the queue. */
  async enqueueLoggedIn(): Promise<number> {
    let count = 0
    for (const platform of Object.keys(this.deps.timeouts) as LoginPlatform[])
      if (await loggedInFast(this.deps.root, processKeyOf(platform))) count += await this.enqueue(platform) ? 1 : 0
    return count
  }
  /** Enqueue logged-in platforms whose latest result is older than staleMs (or missing) — the timed 兜底. */
  async catchUp(): Promise<number> {
    let count = 0
    for (const platform of Object.keys(this.deps.timeouts) as LoginPlatform[]) {
      if (!(await loggedInFast(this.deps.root, processKeyOf(platform)))) continue
      let fresh = true
      try { fresh = this.deps.now() - (await stat(latestPath(this.deps.root, platform))).mtimeMs < this.deps.staleMs }
      catch { fresh = false }   // 从未采集过：视为过期
      if (!fresh) count += await this.enqueue(platform) ? 1 : 0
    }
    return count
  }
  stateOf(platform: LoginPlatform): FetchState { return this.states.get(platform) ?? 'idle' }
  progress(): { done: number; total: number } { return { ...this.batch } }
  /** Shutdown sweep: kill the live fetch (group kill, escalating like terminate) and drop the queued rest (spec §5 边界：丢一次可重拉). */
  async stop(): Promise<void> {
    this.queued.length = 0
    this.batch = { done: 0, total: 0 }
    const running = this.running
    if (running !== undefined) await this.terminate(running.handle)
  }
  private pump(): void {
    if (this.running !== undefined || this.queued.length === 0) return
    const platform = this.queued.shift()!
    this.states.set(platform, 'fetching')
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } as Record<string, string>
    const handle = this.deps.spawn(analyticsCommand(this.deps, platform), { cwd: this.deps.root, env })
    this.running = { platform, handle }
    void this.finish(platform, handle)
  }
  private async finish(platform: LoginPlatform, handle: FetchHandle): Promise<void> {
    const timer = setTimeout(() => { void this.terminate(handle) }, this.deps.timeouts[platform])
    const code = await handle.exited
    clearTimeout(timer)
    let ok = false
    if (code === 0) {
      // exit 后 stdout 的 end 事件必达（kill 路径进程已死，管道随关）；拒绝（spawn 失败）读作空串。
      const text = await handle.stdout.catch(() => '')
      const parsed = lastJsonObject(text)
      if (parsed !== undefined) {
        await writeLatest(this.deps.root, platform, parsed).catch(() => undefined)
        // 执行根的 jsonl 全权归 sidecar：account_stats 的 jsonl 落它自解析的错位根（ADR-0007，无 CLI 覆盖），
        // bili/mp 根本不写——七平台的趋势快照统一由这里代记，sparkline 才有形。
        await appendSnapshot(this.deps.root, platform, parsed, this.deps.now()).catch(() => undefined)
        ok = true
      }
    }
    this.states.set(platform, ok ? 'idle' : 'failed')
    this.batch.done += 1
    if (this.queued.length === 0 && this.batch.done >= this.batch.total) this.batch = { done: 0, total: 0 }
    this.running = undefined
    this.pump()
  }
  /** Terminate to the process group, escalating to SIGKILL when the window closes on a live fetch (login-runner 同款). */
  private async terminate(handle: FetchHandle): Promise<void> {
    handle.kill('SIGTERM')
    if (!await this.settle(handle)) handle.kill('SIGKILL')
  }
  private async settle(handle: FetchHandle): Promise<boolean> {
    return await Promise.race([handle.exited.then(() => true), delay(this.deps.terminateWindowMs).then(() => false)])
  }
}
