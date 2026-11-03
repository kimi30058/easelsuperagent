/** whoami true verification: a headless browser per platform, single-flight with a TTL cache, confident-or-502, and marker write-back. */
import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { AccountError, type LoginRunners } from './login-runner.ts'
import { pythonBin } from './python.ts'
import {
  bilibiliCookiePath, loggedInFast, loginPaths, writeMarker, type LoginPlatform, type ProcessKey,
} from './login-protocol.ts'

export interface WhoamiResult { loggedIn: boolean; name: string; avatar: string }
export type RunCommand = (cmd: string[], options: { cwd: string; timeoutMs: number }) => Promise<{ code: number; stdout: string }>

/** The real run: one python command with a timeout; a killed process reads as a timeout, a non-zero exit as a result. */
export const runReal: RunCommand = async (cmd, options) => {
  try {
    const { stdout } = await promisify(execFile)(cmd[0]!, cmd.slice(1), { cwd: options.cwd, timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024, encoding: 'utf8' })
    return { code: 0, stdout }
  } catch (error) {
    // execFile 把 OS 错误挂在 error.code 上：超时看 killed，非零退出是数字，spawn 不成（ENOENT）是字符串——
    // RunCommand 的契约只有 number，字符串一律归一为 1。
    const failure = error as { killed?: boolean; code?: number | string; stdout?: string }
    if (failure.killed) throw new Error('timed out')
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '' }
  }
}
/** Per-key whoami timeouts, Easel's own values: browsers are slow to come up. verify() 把 wechat-oa 并到
 *  wechat-oa-mp 的会话上再查表，所以 'wechat-oa' 键永远走不到这里。 */
const TIMEOUT_MS: Record<Exclude<ProcessKey, 'wechat-oa'>, number> = { xiaohongshu: 35_000, douyin: 40_000, 'wechat-oa-mp': 40_000, bilibili: 60_000, kuaishou: 40_000, 'weixin-channels': 40_000, zhihu: 40_000 }
const TTL_MS = 600_000

/** Whoami verification over the skills' own whoami subcommands; results heal the fast path and never report a false negative. */
export class Whoami {
  private readonly cache = new Map<LoginPlatform, { at: number; value: WhoamiResult }>()
  private readonly inflight = new Map<LoginPlatform, { task: Promise<WhoamiResult>; forced: boolean }>()
  private readonly deps: { root: string; scriptsDir: string; python: string; runners: LoginRunners; run: RunCommand; wechatConfigured: () => Promise<boolean>; now: () => number }
  constructor(deps: { root: string; scriptsDir: string; python?: string; runners: LoginRunners; run?: RunCommand; wechatConfigured?: () => Promise<boolean>; now?: () => number }) {
    this.deps = { root: deps.root, scriptsDir: deps.scriptsDir, python: deps.python ?? pythonBin(deps.scriptsDir), runners: deps.runners, run: deps.run ?? runReal,
      wechatConfigured: deps.wechatConfigured ?? (async () => false), now: deps.now ?? (() => Date.now()) }
  }
  /** Verify one platform; `force` skips the cache. Concurrent checks share a single flight — except that a
   *  force request never boards a non-force flight: that flight may settle straight from the cache force exists to skip. */
  async check(platform: LoginPlatform, force = false): Promise<WhoamiResult> {
    const running = this.inflight.get(platform)
    if (running !== undefined && (!force || running.forced)) return running.task
    // 等面前的非 force 航班落地后再新起一班，且入列在先：后到的请求（含 force）都并上这一班，不会再起浏览器。
    const gate: Promise<void> = running === undefined ? Promise.resolve() : running.task.then(() => undefined, () => undefined)
    const task = gate.then(() => this.verify(platform, force))
    const tracked = task.finally(() => { if (this.inflight.get(platform)?.task === tracked) this.inflight.delete(platform) })
    this.inflight.set(platform, { task: tracked, forced: force })
    return tracked
  }
  private async verify(platform: LoginPlatform, force: boolean): Promise<WhoamiResult> {
    const key: ProcessKey = platform === 'wechat-oa' ? 'wechat-oa-mp' : platform
    // 公众号：mp 后台会话才是真登录；没有它时退回凭证判定（发布走 AppID/Secret）。
    if (platform === 'wechat-oa' && (await loggedInFast(this.deps.root, key)) !== true)
      return (await this.deps.wechatConfigured()) ? { loggedIn: true, name: '微信公众号', avatar: '' }
        : { loggedIn: false, name: '', avatar: '' }
    // 互斥：登录 runner 还活着就不另起浏览器——刚报 success 的等它保存完（≤8s，等不到 409），中途的返回快速路径。
    if (this.deps.runners.isRunning(key)) {
      const status = await this.deps.runners.status(key)
      if (status.state === 'success') {
        if (!await this.deps.runners.waitExit(key))
          throw new AccountError(409, '登录已确认，浏览器仍在保存账号，请稍后重试校验')
      } else {
        const hit = this.cache.get(platform)
        return hit !== undefined ? hit.value
          : { loggedIn: await loggedInFast(this.deps.root, key), name: '', avatar: '' }
      }
    }
    const hit = this.cache.get(platform)
    if (!force && hit !== undefined && this.deps.now() - hit.at < ttlFor(hit.value)) return hit.value
    let finished: { code: number; stdout: string }
    try { finished = await this.deps.run(this.command(key), { cwd: this.deps.root, timeoutMs: TIMEOUT_MS[key] }) }
    catch { throw new AccountError(504, '校验超时（浏览器起不来或网络慢）') }
    const parsed = lastJson(finished.stdout)
    // 快手 login_probe 探针把「外壳登录仍在、发布鉴权失效」折叠成 loggedIn:false + reason（web_publisher.py whoami），
    // 且探针对瞬时风控 403 亦会误报，两次校验间可摇摆——按 not-confident 处理：不删登录标记（止振），提示重新登录。
    if (parsed?.reason === 'publish_auth_expired')
      throw new AccountError(502, '发布鉴权探针未通过（登录外壳仍在，多为发布 token 过期或瞬时风控）；请重新扫码登录以刷新发布授权')
    const confident = parsed !== undefined && finished.code === 0 && typeof parsed.loggedIn === 'boolean' && parsed.error === undefined
    if (!confident) throw new AccountError(502, '未能确认当前账号身份，请稍后重试校验；原登录状态和账号资料保持不变')
    const value: WhoamiResult = { loggedIn: parsed.loggedIn === true,
      name: typeof parsed.name === 'string' ? parsed.name : '', avatar: typeof parsed.avatar === 'string' ? parsed.avatar : '' }
    this.cache.set(platform, { at: this.deps.now(), value })
    // 回写自愈：确认已登录 → 快速路径从此为真；确认未登录 → 删标记防假阳性。biliup 以 cookie 文件判定，不写标记。
    if (platform !== 'bilibili') {
      if (value.loggedIn) await writeMarker(loginPaths(this.deps.root, key), 'success', value.name)
      else await rm(loginPaths(this.deps.root, key).status, { force: true })
    }
    return value
  }
  private command(key: ProcessKey): string[] {
    const script = (name: string) => join(this.deps.scriptsDir, name)
    const py = this.deps.python
    switch (key) {
      case 'xiaohongshu': return [py, script('xhs_publish.py'), 'whoami', '--no-proxy']
      case 'douyin': return [py, script('douyin_publish.py'), 'whoami', '--no-proxy']
      case 'bilibili': return [py, script('bili_login.py'), 'whoami', '--cookie', bilibiliCookiePath(this.deps.root)]
      case 'kuaishou': case 'weixin-channels': case 'zhihu':
        return [py, script('web_publisher.py'), 'whoami', '--platform', key]
      default: return [py, script('weixin_mp_stats.py'), 'whoami', '--no-proxy']
    }
  }
}
/** A logged-in entry missing its name or avatar refreshes sooner, so the card fills in by itself. */
const ttlFor = (value: WhoamiResult): number =>
  value.loggedIn && (!value.name || !value.avatar) ? 60_000 : TTL_MS
type JsonLine = { loggedIn?: unknown; name?: unknown; avatar?: unknown; error?: unknown; reason?: unknown }
const lastJson = (stdout: string): JsonLine | undefined => {
  for (const line of [...stdout.split('\n')].reverse()) {
    const trimmed = line.trim()
    if (trimmed.startsWith('{')) { try { return JSON.parse(trimmed) as JsonLine } catch { /* keep walking */ } }
  }
  return undefined
}
