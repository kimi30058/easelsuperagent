/** The publish domain's HTTP face: /api/publish/* routes over the _publish protocol (ADR-0008 — the worker publishes; the sidecar reads state and fills codes, nothing more). */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, reply } from './accounts-api.ts'
import { AccountError } from './login-runner.ts'
import { isPlatform, validSmsCode, type LoginPlatform } from './login-protocol.ts'
import {
  aggregatePublish, isSmsPublishPlatform, publishPaths, readPublishState,
  TERMINAL_PUBLISH_STATES, touchResend, writePublishSmsCode,
} from './publish-protocol.ts'
import type { ExecutionRoot } from './execution-root.ts'

/** 码只在进行中的发布里接受：抖音状态机非终态才可写 .code，防止陈码留进下一场发布。 */
const assertPublishing = async (root: string, platform: LoginPlatform): Promise<void> => {
  if (!isSmsPublishPlatform(platform)) throw new AccountError(400, '该平台发布无需验证码')
  const state = await readPublishState(publishPaths(root, platform))
  if (state.state === 'unknown' || (TERMINAL_PUBLISH_STATES as readonly string[]).includes(state.state))
    throw new AccountError(400, '当前没有进行中的发布')
}

/** The publish routes the sidecar answers itself: the aggregate read and douyin's SMS wall. */
export class PublishApi {
  private readonly rootResolver: ExecutionRoot
  constructor(deps: { root: ExecutionRoot }) { this.rootResolver = deps.root }
  /** Claim and answer one request when it falls under /api/publish*; false lets the caller carry on. */
  async handle(req: IncomingMessage, url: URL, res: ServerResponse): Promise<boolean> {
    const parts = url.pathname.slice('/api/'.length).split('/').map(decodeURIComponent)
    if (parts[0] !== 'publish') return false
    try { await this.route(req, parts, res) }
    catch (error) { this.fail(res, error) }
    return true
  }
  private async route(req: IncomingMessage, parts: readonly string[], res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const [, platform, action] = parts
    if (platform === undefined) {
      if (method === 'GET') return reply(res, 200, await aggregatePublish(await this.rootResolver.get()))
      throw new AccountError(404, '未知平台或路径')
    }
    if (!isPlatform(platform)) throw new AccountError(404, '未知平台或路径')
    if (action === 'sms' && method === 'POST' && parts.length === 3) return this.submitSms(req, res, platform)
    if (action === 'resend' && method === 'POST' && parts.length === 3) {
      if (!isSmsPublishPlatform(platform)) throw new AccountError(400, '该平台发布无需验证码')
      await touchResend(publishPaths(await this.rootResolver.get(), platform))
      return reply(res, 200, { ok: true })
    }
    throw new AccountError(404, '未知平台或路径')
  }
  private async submitSms(req: IncomingMessage, res: ServerResponse, platform: LoginPlatform): Promise<void> {
    const body = await readBody(req) as { code?: unknown }
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    if (!validSmsCode(code)) throw new AccountError(400, '验证码应为 4-8 位数字')
    const root = await this.rootResolver.get()
    await assertPublishing(root, platform)
    await writePublishSmsCode(publishPaths(root, platform), code)
    reply(res, 200, { ok: true })
  }
  private fail(res: ServerResponse, error: unknown): void {
    if (error instanceof AccountError) return reply(res, error.status, { error: error.message })
    reply(res, 500, { error: '发布服务内部错误' })
  }
}
