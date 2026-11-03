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
  private readonly deps: { upstream: string; scriptsDir: string; home: string; spawnLogin?: SpawnLogin; run?: RunCommand }
  private root?: string
  private runners?: LoginRunners
  private whoami?: Whoami
  private credentials?: WechatCredentials
  constructor(deps?: { upstream?: string; scriptsDir?: string; spawnLogin?: SpawnLogin; run?: RunCommand; home?: string }) {
    this.deps = { upstream: deps?.upstream ?? process.env.EASEL_SUPERAGENT_URL ?? 'http://127.0.0.1:3082',
      scriptsDir: deps?.scriptsDir ?? defaultScriptsDir(), home: deps?.home ?? homedir(),
      spawnLogin: deps?.spawnLogin, run: deps?.run }
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
    const { credentials } = await this.domain()
    const root = this.root!
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
    const { runners, credentials } = await this.domain()
    const keys: ProcessKey[] = platform === 'wechat-oa' ? ['wechat-oa', 'wechat-oa-mp'] : [platform]
    for (const key of keys) {
      await runners.cancel(key).catch(() => undefined)
      await clearArtifacts(loginPaths(this.root!, key))
      const profile = profileDir(key, this.deps.home)
      if (profile !== undefined) await rm(profile, { recursive: true, force: true })
    }
    if (platform === 'bilibili') await rm(bilibiliCookiePath(this.root!), { force: true })
    if (platform === 'wechat-oa') await credentials.clear()
  }
  /** The cached execution root from the orchestrator's settings view; 503 until it is known. */
  private async executionRoot(): Promise<string> {
    if (this.root !== undefined) return this.root
    let settings: { environment?: { root?: unknown } }
    try {
      const response = await fetch(`${this.deps.upstream}/orchestrator/api/settings`, { signal: AbortSignal.timeout(4000) })
      if (!response.ok) throw new Error(`settings ${response.status}`)
      settings = await response.json() as typeof settings
    } catch { throw new AccountError(503, '编排器不可达，无法定位工作根目录') }
    const root = settings.environment?.root
    if (typeof root !== 'string' || !root) throw new AccountError(503, '编排器设置缺少工作根目录')
    this.root = root
    return root
  }
  /** Build (once per root) and share the domain objects a request needs. */
  private async domain(): Promise<{ runners: LoginRunners; whoami: Whoami; credentials: WechatCredentials }> {
    const root = await this.executionRoot()
    if (this.runners === undefined || this.whoami === undefined || this.credentials === undefined) {
      const deps = { root, scriptsDir: this.deps.scriptsDir }
      this.runners = new LoginRunners({ ...deps, spawnLogin: this.deps.spawnLogin })
      this.credentials = new WechatCredentials({ scriptsDir: this.deps.scriptsDir, run: this.deps.run })
      this.whoami = new Whoami({ ...deps, runners: this.runners, run: this.deps.run,
        wechatConfigured: async () => (await this.credentials!.get()).configured })
    }
    return { runners: this.runners, whoami: this.whoami, credentials: this.credentials }
  }
  private fail(res: ServerResponse, error: unknown): void {
    if (error instanceof AccountError) return reply(res, error.status, { error: error.message })
    reply(res, 500, { error: '账号服务内部错误' })
  }
}
const reply = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}
/** The skills' shared scripts live in the repo beside the built lib directory running this sidecar. */
const defaultScriptsDir = (): string =>
  join(fileURLToPath(new URL('..', import.meta.url)), 'skills', 'easel', 'shared', 'scripts')
