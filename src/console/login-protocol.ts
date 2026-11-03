/** Platform-login file protocol: the platform table and every path and read/write under outputs/_login (ADR-0007). */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One target platform of the account domain: how it logs in and what its card says. */
export interface PlatformSpec {
  readonly platform: LoginPlatform
  readonly name: string
  readonly backend: 'xhs' | 'biliup' | 'douyin' | 'wechat-oa' | 'web'
  readonly note: string
}
export type LoginPlatform = 'xiaohongshu' | 'bilibili' | 'douyin' | 'wechat-oa' | 'kuaishou' | 'weixin-channels' | 'zhihu'
/** The keys that own a runner process and _login artifacts: the seven platforms plus the wechat-oa backend session. */
export const PROCESS_KEYS = ['xiaohongshu', 'bilibili', 'douyin', 'wechat-oa', 'wechat-oa-mp', 'kuaishou', 'weixin-channels', 'zhihu'] as const
export type ProcessKey = typeof PROCESS_KEYS[number]
export const PLATFORMS: readonly PlatformSpec[] = [
  { platform: 'xiaohongshu', name: '小红书', backend: 'xhs', note: 'Playwright 扫码登录' },
  { platform: 'bilibili', name: 'B站', backend: 'biliup', note: 'TV 端扫码，写 biliup cookie' },
  { platform: 'douyin', name: '抖音', backend: 'douyin', note: '扫码登录，可能要求短信验证' },
  { platform: 'wechat-oa', name: '微信公众号', backend: 'wechat-oa', note: 'AppID 凭证（发布）与后台扫码（取数）' },
  { platform: 'kuaishou', name: '快手', backend: 'web', note: '网页扫码登录' },
  { platform: 'weixin-channels', name: '微信视频号', backend: 'web', note: '网页扫码登录' },
  { platform: 'zhihu', name: '知乎', backend: 'web', note: '网页扫码登录' },
]
export const isPlatform = (value: string): value is LoginPlatform =>
  PLATFORMS.some(spec => spec.platform === value)
export const isProcessKey = (value: string): value is ProcessKey =>
  (PROCESS_KEYS as readonly string[]).includes(value)

/** The global Playwright profile each browser key persists in; biliup (no browser) and the credentials-only wechat-oa have none. */
const PROFILE_NAMES: Partial<Record<ProcessKey, string>> = {
  xiaohongshu: 'XiaohongshuProfile', douyin: 'DouyinProfile', 'wechat-oa-mp': 'WeixinMpProfile',
  kuaishou: 'KuaishouProfile', 'weixin-channels': 'ChannelsProfile', zhihu: 'ZhihuProfile',
}
/** The profile directory under `home` (injectable for tests; the real one lives in ~/.easel-browser-profiles). */
export const profileDir = (key: ProcessKey, home: string = homedir()): string | undefined =>
  PROFILE_NAMES[key] === undefined ? undefined : join(home, '.easel-browser-profiles', PROFILE_NAMES[key] as string)

/** Every _login artifact path for one key, all under <executionRoot>/outputs/_login (ADR-0007). */
export interface LoginPaths {
  readonly dir: string; readonly status: string; readonly qr: string
  readonly code: string; readonly log: string; readonly pid: string
}
export const loginDir = (root: string): string => join(root, 'outputs', '_login')
export const loginPaths = (root: string, key: ProcessKey): LoginPaths => {
  const dir = loginDir(root)
  return { dir, status: join(dir, `${key}.json`), qr: join(dir, `${key}.png`), code: join(dir, `${key}.code`),
    log: join(dir, `${key}.log`), pid: join(dir, `${key}.pid`) }
}
/** The biliup-format cookie the TV-QR login writes and SP3's worker will pass with -u (ADR-0007). */
export const bilibiliCookiePath = (root: string): string => join(loginDir(root), 'bilibili-cookies.json')

/** A login status as login_state.py writes it; `qrTs` present means the QR PNG is ready, and is the image's cache key. */
export interface LoginStatus { readonly state: string; readonly message: string; readonly qrTs?: number }
const QR_STATES = ['qr_ready', 'window_login']
const TERMINAL_STATES = ['success', 'expired', 'error']

/** Read a key's status; a torn or missing file reads as unknown, and a runner that died before any terminal state becomes an actionable error. */
export async function readStatus(paths: LoginPaths, abnormalExit?: number): Promise<LoginStatus> {
  let data: { state?: unknown; message?: unknown } = {}
  try { data = JSON.parse(await readFile(paths.status, 'utf8')) as typeof data } catch { /* missing or torn */ }
  const state = typeof data.state === 'string' ? data.state : 'unknown'
  const message = typeof data.message === 'string' ? data.message : ''
  if (!TERMINAL_STATES.includes(state) && abnormalExit !== undefined)
    return { state: 'error', message: `登录程序异常退出（退出码 ${abnormalExit}），请查看 ${paths.log}` }
  if (QR_STATES.includes(state)) {
    try { return { state, message, qrTs: Math.round((await stat(paths.qr)).mtimeMs) } } catch { /* qr not ready */ }
  }
  return { state, message }
}

/** Write a status marker in login_state.py's own format, atomically (cancel, shutdown, whoami write-back). */
export async function writeMarker(paths: LoginPaths, state: 'success' | 'expired', message: string): Promise<void> {
  await mkdir(paths.dir, { recursive: true })
  const temporary = `${paths.status}.tmp`
  await writeFile(temporary, JSON.stringify({ state, message, qr: '', ts: Math.floor(Date.now() / 1000) }), 'utf8')
  await rename(temporary, paths.status)
}

export const validSmsCode = (code: string): boolean => /^\d{4,8}$/.test(code)
/** Write the one-shot SMS code file the runner polls for and deletes after reading (login_state.read_sms_code). */
export async function writeSmsCode(paths: LoginPaths, code: string): Promise<void> {
  await mkdir(paths.dir, { recursive: true })
  await writeFile(paths.code, code, 'utf8')
}

export async function readQr(paths: LoginPaths): Promise<Buffer | undefined> {
  try { return await readFile(paths.qr) } catch { return undefined }
}

/** The fast path trusts only this flow's own last success: the marker for browser keys, the cookie file for biliup. */
export async function loggedInFast(root: string, key: ProcessKey): Promise<boolean> {
  if (key === 'bilibili') { try { await stat(bilibiliCookiePath(root)); return true } catch { return false } }
  return (await readStatus(loginPaths(root, key))).state === 'success'
}

/** Remove every _login artifact of a key (status, qr, code, log, pid); logout calls this before deleting the profile. */
export async function clearArtifacts(paths: LoginPaths): Promise<void> {
  await rm(paths.status, { force: true }); await rm(paths.qr, { force: true })
  await rm(paths.code, { force: true }); await rm(paths.log, { force: true }); await rm(paths.pid, { force: true })
}
