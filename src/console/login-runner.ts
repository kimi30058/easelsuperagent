/** Login runner processes: spawn per platform with every path explicit, pidfile reaping, per-key serialization, cancel, and shutdown. */
import { spawn as nodeSpawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  bilibiliCookiePath, clearArtifacts, isProcessKey, loginPaths, readStatus, writeMarker,
  type LoginStatus, type ProcessKey,
} from './login-protocol.ts'

/** The account domain's own error: the api layer maps `status` to the HTTP response (404 unknown platform, 409 busy, …). */
export class AccountError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502 | 503 | 504, message: string) { super(message) }
}

/** The argv that runs one platform's login with every artifact path explicit (ADR-0007); the scripts' own defaults are wrong in this fork. */
export function loginCommand({ root, scriptsDir }: { root: string; scriptsDir: string }, key: ProcessKey): string[] {
  const script = (name: string) => join(scriptsDir, name)
  const paths = loginPaths(root, key)
  const py = 'python3'
  const timeout = '180'
  switch (key) {
    case 'xiaohongshu':
      return [py, script('xhs_publish.py'), 'login', '--no-proxy', '--qr-out', paths.qr, '--status-file', paths.status, '--timeout', timeout]
    case 'bilibili':
      return [py, script('bili_login.py'), 'login', '--qr-out', paths.qr, '--status-file', paths.status,
        '--cookie', bilibiliCookiePath(root), '--timeout', timeout]
    case 'douyin':
      return [py, script('douyin_publish.py'), 'login', '--no-proxy', '--qr-out', paths.qr, '--status-file', paths.status,
        '--sms-code-file', paths.code, '--timeout', timeout]
    case 'wechat-oa-mp':
      return [py, script('weixin_mp_stats.py'), 'login', '--no-proxy', '--qr-out', paths.qr, '--status-file', paths.status, '--timeout', timeout]
    default:
      throw new AccountError(400, '微信公众号使用凭证表单，不扫码登录')
  }
}

/** A spawned runner as the orchestrating side sees it: its pid, a promise for its exit code, and a kill by signal. */
export interface RunnerHandle {
  readonly pid: number; readonly exited: Promise<number | null>
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void
}
export type SpawnLogin = (cmd: string[], options: { cwd: string; env: Record<string, string>; logFile: string }) => RunnerHandle

/** Exit codes observed so far, keyed by handle: the mutex and status synthesis read these. */
const runnerExitCode = new WeakMap<RunnerHandle, number>()

const realSpawn: SpawnLogin = (cmd, options) => {
  const logFd = openSync(options.logFile, 'a')
  const child = nodeSpawn(cmd[0]!, cmd.slice(1), { cwd: options.cwd, env: options.env, detached: true,
    stdio: ['ignore', logFd, logFd] })
  const exited = new Promise<number | null>(resolve => {
    child.on('exit', (code, signal) => { try { closeSync(logFd) } catch { /* already closed */ }; resolve(signal ? null : code) })
  })
  // The runner is detached, so its pid names a process group: killing -pid takes the browser tree with it.
  const kill = (signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void => {
    try { process.kill(-child.pid!, signal) } catch { try { child.kill(signal) } catch { /* already gone */ } }
  }
  return { pid: child.pid!, exited, kill }
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
/** Wait up to the terminate window for a runner's exit; false means it is still going. */
const settled = async (runner: RunnerHandle, windowMs: number): Promise<boolean> =>
  await Promise.race([runner.exited.then(() => true), delay(windowMs).then(() => false)])
/** The runner's exit code when it has already exited, undefined while it is still running. */
const settledOrNull = async (runner: RunnerHandle): Promise<number | undefined> =>
  await Promise.race([runner.exited.then(code => code ?? -1), delay(0).then(() => undefined)])
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** The runners of one sidecar process: at most one live runner per key, orphan reaping from pidfiles, and a shutdown sweep. */
export class LoginRunners {
  private readonly runners = new Map<ProcessKey, RunnerHandle>()
  private readonly deps: { root: string; scriptsDir: string; spawnLogin: SpawnLogin; terminateWindowMs: number }
  constructor(deps: { root: string; scriptsDir: string; spawnLogin?: SpawnLogin; terminateWindowMs?: number }) {
    this.deps = { root: deps.root, scriptsDir: deps.scriptsDir, spawnLogin: deps.spawnLogin ?? realSpawn,
      terminateWindowMs: deps.terminateWindowMs ?? 8000 }
  }
  /** Start (or reuse) one key's login; `restart` terminates the in-flight runner first. */
  async start(key: ProcessKey, restart = false): Promise<LoginStatus> {
    const paths = loginPaths(this.deps.root, key)
    const existing = this.runners.get(key)
    const existingExit = existing === undefined ? undefined : await settledOrNull(existing)
    if (existing !== undefined && existingExit === undefined) {          // in-flight：立即判活，不等退出
      if (!restart) return this.startingIfUnknown(await this.status(key))
      await this.terminate(existing)
      // terminate 含 SIGKILL 升级，exit 事件通常即刻到达；200ms 仍无消息才是真的退不出去。
      if (!await settled(existing, 200)) throw new AccountError(409, '上一次登录仍在退出，请稍后重试')
      await clearArtifacts(paths)
    } else {
      if (existing === undefined) {
        const adopted = await this.reapPidfile(key)                     // 孤儿检查：活 pid 复用，僵尸清走
        if (adopted) return this.startingIfUnknown(await this.status(key))
      }
      await rm(paths.code, { force: true })                             // 旧验证码不跨登录（Easel 同款）
    }
    await this.launch(key)
    return this.startingIfUnknown(await this.status(key))
  }
  /** A live runner that has not written its status yet reads as unknown — show the operator "starting" instead. */
  private startingIfUnknown(status: LoginStatus): LoginStatus {
    return status.state === 'unknown' ? { state: 'starting', message: '正在启动浏览器并准备二维码…' } : status
  }
  /** The key's status; a runner that exited before any terminal state becomes an error naming its log. */
  async status(key: ProcessKey): Promise<LoginStatus> {
    if (!isProcessKey(key)) throw new AccountError(404, '未知平台')
    const runner = this.runners.get(key)
    const abnormalExit = runner === undefined ? undefined : await settledOrNull(runner)
    return readStatus(loginPaths(this.deps.root, key), abnormalExit)
  }
  /** Cancel an in-flight login. A login that already finished keeps its own terminal state — a late cancel rewrites nothing. */
  async cancel(key: ProcessKey): Promise<void> {
    const runner = this.runners.get(key)
    if (runner !== undefined && this.isRunning(key)) {
      await this.terminate(runner)
      await writeMarker(loginPaths(this.deps.root, key), 'expired', '已取消')
      return
    }
    const killedOrphan = await this.killPidfile(key)                    // 无句柄的活孤儿（sidecar 重启后）
    if (killedOrphan) await writeMarker(loginPaths(this.deps.root, key), 'expired', '已取消')
  }
  /** Shutdown sweep: every live runner is terminated and marked expired so the next start is clean. */
  async stopAll(): Promise<void> {
    for (const key of [...this.runners.keys()]) {
      const runner = this.runners.get(key)
      if (runner !== undefined && (await settledOrNull(runner)) === undefined) {  // alive now
        await this.terminate(runner)
        await writeMarker(loginPaths(this.deps.root, key), 'expired', '服务已重启，请重新扫码登录')
      }
    }
  }
  /** Terminate to the process group, escalating to SIGKILL when the window closes on a live runner. */
  private async terminate(runner: RunnerHandle): Promise<void> {
    runner.kill('SIGTERM')
    if (!await settled(runner, this.deps.terminateWindowMs)) runner.kill('SIGKILL')
  }
  /** The live runner's exit fact for whoami's mutex; undefined when no runner is known. */
  runnerExit(key: ProcessKey): number | undefined {
    const runner = this.runners.get(key)
    return runner === undefined ? undefined : runnerExitCode.get(runner)
  }
  /** Whether a runner of this key is alive right now (whoami's mutex asks before starting a browser). */
  isRunning(key: ProcessKey): boolean {
    const runner = this.runners.get(key)
    return runner !== undefined && runnerExitCode.get(runner) === undefined
  }
  /** Wait up to the terminate window for a runner's exit; true when it is gone (or was never there). */
  async waitExit(key: ProcessKey): Promise<boolean> {
    const runner = this.runners.get(key)
    return runner === undefined ? true : settled(runner, this.deps.terminateWindowMs)
  }
  private async launch(key: ProcessKey): Promise<void> {
    const paths = loginPaths(this.deps.root, key)
    await mkdir(paths.dir, { recursive: true })                         // runner 打开日志文件前目录必须已在
    await clearArtifacts(paths)                                        // 旧状态/二维码不得混进新一轮
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } as Record<string, string>
    const handle = this.deps.spawnLogin(loginCommand(this.deps, key), { cwd: this.deps.root, env, logFile: paths.log })
    this.runners.set(key, handle)
    void handle.exited.then(code => runnerExitCode.set(handle, code ?? -1))
    await writeFile(paths.pid, String(handle.pid), 'utf8').catch(() => undefined)
  }
  /** A live pid in the pidfile is adopted (its runner keeps writing status); a dead one is cleared away. */
  private async reapPidfile(key: ProcessKey): Promise<boolean> {
    const paths = loginPaths(this.deps.root, key)
    const pid = await this.readPid(paths)
    if (pid !== undefined && alive(pid)) return true
    await rm(paths.pid, { force: true })
    return false
  }
  /** SIGTERM a live orphan named by the pidfile; true when one was actually signalled. */
  private async killPidfile(key: ProcessKey): Promise<boolean> {
    const paths = loginPaths(this.deps.root, key)
    const pid = await this.readPid(paths)
    let killed = false
    if (pid !== undefined && alive(pid)) { try { process.kill(-pid, 'SIGTERM'); killed = true } catch { /* raced */ } }
    await rm(paths.pid, { force: true })
    return killed
  }
  private async readPid(paths: { pid: string }): Promise<number | undefined> {
    try { const value = Number.parseInt(await readFile(paths.pid, 'utf8'), 10); return Number.isInteger(value) && value > 1 ? value : undefined }
    catch { return undefined }
  }
}
