/** The account domain's HTTP face: /api/* routes over the protocol, runners, whoami, and credentials, with the root self-configured. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  PLATFORMS, bilibiliCookiePath, clearArtifacts, isPlatform, isProcessKey, loggedInFast, loginPaths, profileDir,
  readQr, validSmsCode, writeSmsCode, type LoginPlatform, type ProcessKey,
} from './login-protocol.ts'
import { AccountError, LoginRunners, type SpawnLogin } from './login-runner.ts'
import { Whoami, type RunCommand } from './whoami.ts'
import { WechatCredentials } from './wechat-credentials.ts'
import { ExecutionRoot } from './execution-root.ts'

/** Read one JSON request body, refusing anything over 64KB — these forms are a handful of fields. */
export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new AccountError(400, '请求体过大')
    chunks.push(Buffer.from(chunk))
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw new AccountError(400, '请求体不是合法 JSON') }
}

/** The sidecar's account routes: everything under /api/*, answered in place (never proxied). */
export class AccountsApi {
  private readonly deps: { upstream: string; scriptsDir: string; home: string; spawnLogin?: SpawnLogin; run?: RunCommand; now: () => number }
  private readonly resolver: ExecutionRoot
  private domainRoot?: string
  private runners?: LoginRunners
  private whoami?: Whoami
  private credentials?: WechatCredentials
  constructor(deps?: { upstream?: string; scriptsDir?: string; spawnLogin?: SpawnLogin; run?: RunCommand; home?: string; now?: () => number; root?: ExecutionRoot }) {
    this.deps = { upstream: deps?.upstream ?? process.env.EASEL_SUPERAGENT_URL ?? 'http://127.0.0.1:3082',
      scriptsDir: deps?.scriptsDir ?? defaultScriptsDir(), home: deps?.home ?? homedir(),
      spawnLogin: deps?.spawnLogin, run: deps?.run, now: deps?.now ?? (() => Date.now()) }
    this.resolver = deps?.root ?? new ExecutionRoot({ upstream: this.deps.upstream, now: this.deps.now })
  }
  /** Claim and answer one request when it falls under /api/*; false lets the caller carry on. */
  async handle(req: IncomingMessage, url: URL, res: ServerResponse): Promise<boolean> {
    if (!url.pathname.startsWith('/api/')) return false
    try { await this.route(req, url, res) }
    catch (error) { this.fail(res, error) }
    return true
  }
  /** Terminate every live runner (the sidecar's close path). */
  async stopAll(): Promise<void> { await this.runners?.stopAll() }
  private async route(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const parts = url.pathname.slice('/api/'.length).split('/').map(decodeURIComponent)
    const [one, two, three] = parts
    const method = req.method ?? 'GET'
    if (method === 'GET' && one === 'accounts' && two === undefined && three === undefined)
      return reply(res, 200, await this.cards())
    if (one === 'login' && two !== undefined && three === undefined && isProcessKey(two)) {
      if (method === 'POST')
        return reply(res, 200, await (await this.domain()).runners.start(two, url.searchParams.get('restart') === '1'))
      if (method === 'DELETE') {
        await (await this.domain()).runners.cancel(two)
        return reply(res, 200, { ok: true })
      }
    }
    if (one === 'login' && two !== undefined && isProcessKey(two)) {
      if (method === 'GET' && three === 'status')
        return reply(res, 200, await (await this.domain()).runners.status(two))
      if (method === 'GET' && three === 'qr') return this.serveQr(res, two)
      if (method === 'POST' && three === 'sms') return this.submitSms(req, res, two)
    }
    if (one === 'accounts' && two === 'wechat-oa') {
      if (three === 'credentials' && method === 'GET')
        return reply(res, 200, await (await this.domain()).credentials.get())
      if (three === 'credentials' && method === 'POST') return this.saveCredentials(req, res)
      if (three === 'mp-login' && method === 'POST')
        return reply(res, 200, await (await this.domain()).runners.start('wechat-oa-mp'))
    }
    if (one === 'accounts' && two !== undefined && three === 'whoami' && method === 'GET' && isPlatform(two))
      return reply(res, 200, await (await this.domain()).whoami.check(two, url.searchParams.get('force') === '1'))
    if (one === 'logout' && two !== undefined && method === 'POST' && isPlatform(two)) {
      await this.logout(two)
      return reply(res, 200, { ok: true })
    }
    throw new AccountError(404, '未知平台或路径')
  }
  /** The card list: the fast path plus each platform's own words; wechat-oa also counts configured credentials. */
  private async cards(): Promise<unknown> {
    const { credentials, root } = await this.domain()
    return Promise.all(PLATFORMS.map(async spec => {
      const loginKey: ProcessKey = spec.platform === 'wechat-oa' ? 'wechat-oa-mp' : spec.platform
      let loggedIn = await loggedInFast(root, loginKey)
      if (spec.platform === 'wechat-oa') loggedIn = loggedIn || (await credentials.get()).configured
      return { platform: spec.platform, name: spec.name, backend: spec.backend, note: spec.note, loggedIn }
    }))
  }
  private async serveQr(res: ServerResponse, key: ProcessKey): Promise<void> {
    const root = await this.executionRoot()
    const png = await readQr(loginPaths(root, key))
    if (png === undefined) throw new AccountError(404, '二维码尚未就绪')
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(png)
  }
  private async submitSms(req: IncomingMessage, res: ServerResponse, key: ProcessKey): Promise<void> {
    const body = await readBody(req) as { code?: unknown }
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    if (!validSmsCode(code)) throw new AccountError(400, '验证码应为 4-8 位数字')
    const root = await this.executionRoot()
    await writeSmsCode(loginPaths(root, key), code)
    reply(res, 200, { ok: true })
  }
  private async saveCredentials(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req) as Record<string, unknown>
    const text = (name: string) => typeof body[name] === 'string' ? body[name] as string : ''
    const result = await (await this.domain()).credentials.save(text('appId'), text('appSecret'), text('name'), text('author'))
    reply(res, 200, result)
  }
  /** Logout: stop the runner(s), clear every artifact, remove the profile directory (and biliup's cookie, wechat's credentials). */
  private async logout(platform: LoginPlatform): Promise<void> {
    const { runners, credentials, root } = await this.domain()
    const keys: ProcessKey[] = platform === 'wechat-oa' ? ['wechat-oa', 'wechat-oa-mp'] : [platform]
    // 每键各自走一个 terminate 窗口，两键并行收尾：串行会把窗口叠着算进同一个 POST。
    await Promise.all(keys.map(async key => {
      await runners.cancel(key).catch(() => undefined)
      await clearArtifacts(loginPaths(root, key))
      const profile = profileDir(key, this.deps.home)
      if (profile !== undefined) await rm(profile, { recursive: true, force: true })
    }))
    if (platform === 'bilibili') await rm(bilibiliCookiePath(root), { force: true })
    if (platform === 'wechat-oa') await credentials.clear()
  }
  /** The execution root via the shared resolver; 503 until it is first known, then cached with a TTL. */
  private async executionRoot(): Promise<string> {
    return await this.resolver.get()
  }
  /** Build (once per root) and share the domain objects a request needs; a root change rebuilds them and retires
   *  the old root's runners, so no browser keeps writing into a workspace that has moved away. */
  private async domain(): Promise<{ root: string; runners: LoginRunners; whoami: Whoami; credentials: WechatCredentials }> {
    const root = await this.executionRoot()
    if (this.domainRoot !== root || this.runners === undefined || this.whoami === undefined || this.credentials === undefined) {
      const previous = this.runners
      const deps = { root, scriptsDir: this.deps.scriptsDir }
      this.runners = new LoginRunners({ ...deps, spawnLogin: this.deps.spawnLogin })
      this.credentials = new WechatCredentials({ scriptsDir: this.deps.scriptsDir, run: this.deps.run })
      this.whoami = new Whoami({ ...deps, runners: this.runners, run: this.deps.run,
        wechatConfigured: async () => (await this.credentials!.get()).configured })
      this.domainRoot = root
      // 旧根的 runner 随旧域退场——文案单列：操作者看到的是迁移，不是重启。
      // （还在飞的旧根 whoami 浏览器不在 runner 表里，收编不到；窗口 ≤60s 且 profile 锁会自我限制。）
      if (previous !== undefined) await previous.stopAll('工作区已迁移，请重新扫码登录')
    }
    return { root, runners: this.runners, whoami: this.whoami, credentials: this.credentials }
  }
  private fail(res: ServerResponse, error: unknown): void {
    if (error instanceof AccountError) return reply(res, error.status, { error: error.message })
    reply(res, 500, { error: '账号服务内部错误' })
  }
}
export const reply = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}
/** The skills' shared scripts: EASEL_SKILLS_DIR overrides the repo-relative default (non-standard installs). */
export const defaultScriptsDir = (): string =>
  process.env.EASEL_SKILLS_DIR ?? join(fileURLToPath(new URL('..', import.meta.url)), 'skills', 'easel', 'shared', 'scripts')
