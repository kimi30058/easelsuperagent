/** The publish file protocol: every path and read/write under outputs/_publish, the sidecar's window into worker-run publishes (ADR-0008). */
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PLATFORMS, type LoginPlatform } from './login-protocol.ts'

/** 与 publish-view.ts 的客户端 TERMINAL 同义（客户端不能 import 本文件——node:fs）；新增终态须两边同改。 */
export const TERMINAL_PUBLISH_STATES = ['success', 'error'] as const
/** 抖音发布中途可能要求短信验证码（唯一带 --sms-code-file 的 publish 子命令），其余平台无此环节。 */
export const SMS_PUBLISH_PLATFORMS: readonly LoginPlatform[] = ['douyin']
export const isSmsPublishPlatform = (value: string): value is LoginPlatform =>
  (SMS_PUBLISH_PLATFORMS as readonly string[]).includes(value)

export const publishDir = (root: string): string => join(root, 'outputs', '_publish')
/** Every _publish artifact path for one platform, all under <executionRoot>/outputs/_publish. */
export interface PublishPaths {
  readonly dir: string; readonly status: string
  readonly code: string; readonly resend: string; readonly log: string
}
export const publishPaths = (root: string, platform: LoginPlatform): PublishPaths => {
  const dir = publishDir(root)
  return { dir, status: join(dir, `${platform}.json`), code: join(dir, `${platform}.code`),
    resend: join(dir, `${platform}.code.resend`), log: join(dir, `${platform}.log`) }
}

export interface PublishStateView { readonly state: string; readonly message: string; readonly ts?: number }
/** 抖音 publish 原生写的 login_state 同格式状态机；缺失或撕裂读作 unknown，不抛（页面照常渲染）。 */
export async function readPublishState(paths: PublishPaths): Promise<PublishStateView> {
  try {
    const data = JSON.parse(await readFile(paths.status, 'utf8')) as { state?: unknown; message?: unknown; ts?: unknown }
    return { state: typeof data.state === 'string' ? data.state : 'unknown',
      message: typeof data.message === 'string' ? data.message : '',
      ts: typeof data.ts === 'number' ? data.ts : undefined }
  } catch { return { state: 'unknown', message: '' } }
}

export interface LogView { readonly tail: string; readonly mtime: number }
/** The publish log's last 2KB and its mtime（新鲜度键）——只读尾部，日志再大也不整文件进内存；缺失返回 undefined。 */
export async function readLogTail(paths: PublishPaths): Promise<LogView | undefined> {
  let handle
  try { handle = await open(paths.log, 'r') } catch { return undefined }
  try {
    const { mtimeMs, size } = await handle.stat()
    const length = Math.min(size, 2048)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    // 2KB 按字节切界可能落在多字节序列中间：跳过头部的 UTF-8 续字节（0b10xxxxxx，至多 3 个），
    // 把被切断的整字符丢掉，否则日志头会带一两个乱码符。
    let start = 0
    while (start < 3 && start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++
    return { tail: buffer.subarray(start).toString('utf8'), mtime: Math.round(mtimeMs) }
  } finally { await handle.close() }
}

/** 写一次性验证码文件（页面提交、发布 runner 轮询读后即删——login_state.read_sms_code 同协议）。 */
export async function writePublishSmsCode(paths: PublishPaths, code: string): Promise<void> {
  await mkdir(paths.dir, { recursive: true })
  await writeFile(paths.code, code, 'utf8')
}
/** touch 重发信号文件：抖音发布 runner 看到它就在平台侧点「重新发送」（.resend 旁车协议）。 */
export async function touchResend(paths: PublishPaths): Promise<void> {
  await mkdir(paths.dir, { recursive: true })
  await writeFile(paths.resend, '', 'utf8')
}

export interface PlatformPublishView {
  readonly platform: LoginPlatform; readonly state: string; readonly message: string; readonly ts?: number
  readonly logTail: string; readonly logMtime?: number
}
/** Aggregate all four platforms' _publish artifacts for GET /api/publish; json/log 缺失时 state 为 unknown、logTail 为空串。 */
export async function aggregatePublish(root: string): Promise<PlatformPublishView[]> {
  return Promise.all(PLATFORMS.map(async ({ platform }) => {
    const paths = publishPaths(root, platform)
    const state = await readPublishState(paths)
    const log = await readLogTail(paths)
    return { platform, state: state.state, message: state.message, ts: state.ts,
      logTail: log?.tail ?? '', logMtime: log?.mtime }
  }))
}
