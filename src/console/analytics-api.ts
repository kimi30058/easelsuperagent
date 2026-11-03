/** The analytics domain's HTTP face: /api/analytics* — the aggregate read (login + state + spark + works) and the fetch enqueue. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AccountError } from './login-runner.ts'
import { loggedInFast, isPlatform, type LoginPlatform, type ProcessKey } from './login-protocol.ts'
import { reply, defaultScriptsDir } from './accounts-api.ts'
import {
  joinWorks, readCalendarRecords, readLatest, readSpark, type AnalyticsLatest, type Work,
} from './analytics-protocol.ts'
import { AnalyticsRunners, type SpawnAnalytics } from './analytics-runner.ts'
import { ExecutionRoot } from './execution-root.ts'

/** 七平台固定序（账号域 PLATFORMS 同序）。 */
const ANALYTIC_PLATFORMS: readonly LoginPlatform[] = ['xiaohongshu', 'bilibili', 'douyin', 'wechat-oa', 'kuaishou', 'weixin-channels', 'zhihu']
/** wechat-oa 的取数会话是 mp 后台（wechat-oa-mp 键），其余平台键即自身。 */
const PROCESS_KEY_OF = (platform: LoginPlatform): ProcessKey => platform === 'wechat-oa' ? 'wechat-oa-mp' : platform

/** The analytics routes the sidecar answers itself: the aggregate plus the manual fetch entry points. */
export class AnalyticsApi {
  private readonly deps: { root: ExecutionRoot; scriptsDir: string }
  private runners?: AnalyticsRunners
  private timer?: NodeJS.Timeout
  private readonly spawn?: SpawnAnalytics
  private readonly now?: () => number
  private readonly checkIntervalMs?: number
  constructor(deps?: { root?: ExecutionRoot; scriptsDir?: string; spawn?: SpawnAnalytics; now?: () => number; checkIntervalMs?: number }) {
    this.deps = { root: deps?.root ?? new ExecutionRoot(), scriptsDir: deps?.scriptsDir ?? defaultScriptsDir() }
    this.spawn = deps?.spawn; this.now = deps?.now; this.checkIntervalMs = deps?.checkIntervalMs
  }
  /** Claim and answer one request when it falls under /api/analytics*; false lets the caller carry on. */
  async handle(req: IncomingMessage, url: URL, res: ServerResponse): Promise<boolean> {
    // 畸形 %-序列是客户端错误：decode 的 URIError 在此就地 400，不放给 server.ts 的兜底毁连接（publish-api 同款）。
    let parts: string[]
    try { parts = url.pathname.slice('/api/'.length).split('/').map(decodeURIComponent) }
    catch { reply(res, 400, { error: '路径包含非法的百分号转义' }); return true }
    if (parts[0] !== 'analytics') return false
    try { await this.route(req, parts, res) }
    catch (error) { this.fail(res, error) }
    return true
  }
  private async route(req: IncomingMessage, parts: readonly string[], res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const [, platform] = parts
    if (platform === undefined) {
      if (method === 'GET') return reply(res, 200, await this.aggregate(await this.domainRoot()))
      if (method === 'POST') {
        const { runners } = await this.domain()
        return reply(res, 200, { ok: true, queued: await runners.enqueueLoggedIn() })
      }
      throw new AccountError(404, '未知平台或路径')
    }
    // 全量入队在平台守卫之前认领：'fetch' 落在 {platform} 槽里且不是平台名，先到先得不冲突。
    if (platform === 'fetch' && parts.length === 2 && method === 'POST') {
      const { runners } = await this.domain()
      return reply(res, 200, { ok: true, queued: await runners.enqueueLoggedIn() })
    }
    if (!isPlatform(platform)) throw new AccountError(404, '未知平台或路径')
    if (parts.length === 3 && parts[2] === 'fetch' && method === 'POST') {
      const { runners } = await this.domain()
      return reply(res, 200, { ok: true, queued: (await runners.enqueue(platform)) ? 1 : 0 })
    }
    throw new AccountError(404, '未知平台或路径')
  }
  /** The whole page in one read: per-platform login/state/latest/spark, the works join, and the batch progress. */
  private async aggregate(root: string): Promise<{ platforms: unknown[]; works: Work[]; progress: { done: number; total: number } }> {
    const { runners } = await this.domain()
    const platforms = []
    const latests: Partial<Record<LoginPlatform, AnalyticsLatest | undefined>> = {}
    for (const platform of ANALYTIC_PLATFORMS) {
      const latest = await readLatest(root, platform)
      latests[platform] = latest
      platforms.push({ platform,
        login: await loggedInFast(root, PROCESS_KEY_OF(platform)),
        state: runners.stateOf(platform),
        latest: latest === undefined ? undefined
          : { followers: latest.followers, likes: latest.likes, nickname: latest.nickname, fetchedAt: latest.fetchedAt,
            metrics: latest.metrics },   // 近 7 日指标要活着到页面（卡内展开消费的就是它）
        spark: await readSpark(root, platform) })
    }
    return { platforms, works: joinWorks(await readCalendarRecords(root), latests), progress: runners.progress() }
  }
  /** Start the timed 兜底: the hourly tick enqueues logged-in platforms whose latest is stale (spec §2).
   *  不做启动即采——那会在 sidecar 起服务的瞬间打一次编排器 settings，与「无请求不触上游」的既有契约为敌；
   *  启动后的首个整点 tick 即承担 catch-up（对 20h 过期阈值而言，≤1h 的延迟无感）。 */
  start(): void {
    this.timer = setInterval(() => void this.tick(), this.checkIntervalMs ?? 3600_000)
  }
  private async tick(): Promise<void> {
    try { const { runners } = await this.domain(); await runners.catchUp() }
    catch { /* 编排器不可达：下个整点再试（ExecutionRoot 失败航班由下次请求重试） */ }
  }
  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer)
    await this.runners?.stop()
  }
  /** The pinned domain (照 accounts-api 的 lazy domain): root resolved once, runners built on it. */
  private async domain(): Promise<{ runners: AnalyticsRunners }> {
    if (this.runners === undefined) {
      const root = await this.deps.root.get()
      this.runners = new AnalyticsRunners({ root, scriptsDir: this.deps.scriptsDir,
        spawn: this.spawn, now: this.now })
    }
    return { runners: this.runners }
  }
  private async domainRoot(): Promise<string> { await this.domain(); return this.deps.root.get() }
  private fail(res: ServerResponse, error: unknown): void {
    if (error instanceof AccountError) return reply(res, error.status, { error: error.message })
    reply(res, 500, { error: '数据服务内部错误' })
  }
}
