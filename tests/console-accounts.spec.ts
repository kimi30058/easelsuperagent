/** Tests for the account domain's node side: the _login file protocol, runner lifecycle, whoami, and credentials. */
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { expect, it, describe, beforeEach, afterEach } from 'vitest'
import {
  PLATFORMS, PROCESS_KEYS, bilibiliCookiePath, clearArtifacts, isPlatform, isProcessKey,
  loggedInFast, loginDir, loginPaths, profileDir, readQr, readStatus, validSmsCode, writeMarker, writeSmsCode,
} from '../src/console/login-protocol.ts'
import { loginCommand, LoginRunners, type RunnerHandle, type SpawnLogin } from '../src/console/login-runner.ts'
import { Whoami, type RunCommand } from '../src/console/whoami.ts'
import { WechatCredentials } from '../src/console/wechat-credentials.ts'

/** A run() answering by script filename; the real one runs python with a timeout. */
const runFrom = (table: Record<string, { code: number; stdout: string } | Error>): RunCommand =>
  async cmd => {
    const key = cmd.map(String).join(' ').match(/(\w[\w-]*\.py)/)?.[1] ?? ''
    const hit = table[key]
    if (hit instanceof Error) throw hit
    return hit ?? { code: 0, stdout: '' }
  }

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sp2-protocol-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('platform table', () => {
  it('lists the four fork platforms plus the wechat-oa-mp process key, and rejects anything else', () => {
    expect(PLATFORMS.map(p => p.platform)).toEqual(['xiaohongshu', 'bilibili', 'douyin', 'wechat-oa'])
    expect(PROCESS_KEYS).toContain('wechat-oa-mp')
    expect(isPlatform('xiaohongshu')).toBe(true)
    expect(isPlatform('kuaishou')).toBe(false)          // fork 发布范围外的 Easel 平台
    expect(isProcessKey('../../etc')).toBe(false)       // Review Focus 1
  })

  it('maps browser platforms to their global profile directory and leaves biliup/wechat-oa without one', () => {
    expect(profileDir('xiaohongshu')).toContain('XiaohongshuProfile')
    expect(profileDir('wechat-oa-mp')).toContain('WeixinMpProfile')
    expect(profileDir('bilibili')).toBeUndefined()
    expect(profileDir('wechat-oa')).toBeUndefined()
  })
})

describe('login status files', () => {
  it('reads a written status and reports a ready qr by its mtime', async () => {
    const paths = loginPaths(root, 'xiaohongshu')
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.status, JSON.stringify({ state: 'qr_ready', message: '等扫码', qr: '', ts: 1 }), 'utf8')
    await writeFile(paths.qr, Buffer.from([137, 80, 78, 71]), 'utf8')  // PNG magic
    const status = await readStatus(paths)
    expect(status.state).toBe('qr_ready')
    expect(status.message).toBe('等扫码')
    expect(status.qrTs).toBeGreaterThan(0)
    expect(await readQr(paths)).toEqual(Buffer.from([137, 80, 78, 71]))
  })

  it('falls back to unknown on a missing or torn file instead of throwing', async () => {
    const paths = loginPaths(root, 'douyin')
    expect((await readStatus(paths)).state).toBe('unknown')
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.status, '{"state": "qr_re', 'utf8')  // Review Focus 2
    expect((await readStatus(paths)).state).toBe('unknown')
  })

  it('synthesizes an actionable error when the runner died before a terminal state', async () => {
    const paths = loginPaths(root, 'douyin')                       // Review Focus 3
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.status, JSON.stringify({ state: 'starting', message: '' }), 'utf8')
    const status = await readStatus(paths, 9)
    expect(status.state).toBe('error')
    expect(status.message).toContain('douyin.log')
    // 终态不合成：success 就是 success
    await writeFile(paths.status, JSON.stringify({ state: 'success', message: '' }), 'utf8')
    expect((await readStatus(paths, 9)).state).toBe('success')
  })
})

describe('sms codes, markers, and the fast path', () => {
  it('validates 4-8 digit codes and writes the one-shot code file', async () => {
    expect(validSmsCode('1234')).toBe(true)
    expect(validSmsCode('12345678')).toBe(true)
    expect(validSmsCode('12ab')).toBe(false)
    expect(validSmsCode('123')).toBe(false)
    const paths = loginPaths(root, 'douyin')
    await writeSmsCode(paths, '654321')
    expect(await readFile(paths.code, 'utf8')).toBe('654321')
  })

  it('writes atomic markers and clears every artifact of a key', async () => {
    const paths = loginPaths(root, 'xiaohongshu')
    await writeMarker(paths, 'expired', '已取消')
    expect((await readStatus(paths)).state).toBe('expired')
    await clearArtifacts(paths)
    expect((await readStatus(paths)).state).toBe('unknown')
  })

  it('judges the fast path from the marker and the biliup cookie file', async () => {
    expect(await loggedInFast(root, 'xiaohongshu')).toBe(false)
    await writeMarker(loginPaths(root, 'xiaohongshu'), 'success', '')
    expect(await loggedInFast(root, 'xiaohongshu')).toBe(true)
    expect(await loggedInFast(root, 'bilibili')).toBe(false)
    await mkdir(loginDir(root), { recursive: true })
    await writeFile(bilibiliCookiePath(root), '{}', 'utf8')
    expect(await loggedInFast(root, 'bilibili')).toBe(true)
  })
})

/** A fake handle whose exit promise the test settles by hand (kill() settles it as a terminate). */
interface FakeHandle extends RunnerHandle { finish(code: number | null): void }
const fakeHandle = (pid: number): FakeHandle => {
  let settle: (code: number | null) => void = () => undefined
  const exited = new Promise<number | null>(resolve => { settle = resolve })
  return { pid, exited, kill: () => settle(null), finish: code => settle(code) }
}
/** A fake spawn that records commands and hands out handles the test moves; it asserts the utf-8 env itself. */
function fakeSpawn(): { spawnLogin: SpawnLogin; commands: string[][]; handles: FakeHandle[] } {
  const commands: string[][] = []
  const handles: FakeHandle[] = []
  const spawnLogin: SpawnLogin = (cmd, options) => {
    commands.push(cmd)
    expect(options.env.PYTHONUTF8).toBe('1')
    expect(options.cwd).toBe(root)
    const handle = fakeHandle(24000 + commands.length)
    handles.push(handle)
    return handle
  }
  return { spawnLogin, commands, handles }
}

describe('login commands', () => {
  it('passes every path explicitly per platform (ADR-0007)', () => {
    const deps = { root, scriptsDir: '/repo/skills/easel/shared/scripts' }
    const xhs = loginCommand(deps, 'xiaohongshu')
    expect(xhs.some(part => part.endsWith('xhs_publish.py'))).toBe(true)
    expect(xhs).toContain('login'); expect(xhs).toContain('--no-proxy')
    expect(xhs).toContain(join(root, 'outputs', '_login', 'xiaohongshu.png'))
    expect(xhs.join(' ')).not.toContain('/skills/outputs')  // 默认路径错位不得出现
    const bili = loginCommand(deps, 'bilibili')
    expect(bili).toContain('--cookie'); expect(bili).toContain(bilibiliCookiePath(root))
    expect(bili.some(part => part.endsWith('bili_login.py'))).toBe(true)
    const douyin = loginCommand(deps, 'douyin')
    expect(douyin).toContain('--sms-code-file'); expect(douyin).toContain('--no-proxy')
    expect(douyin.some(part => part.endsWith('douyin_publish.py'))).toBe(true)
    expect(loginCommand(deps, 'wechat-oa-mp').some(part => part.endsWith('weixin_mp_stats.py'))).toBe(true)
    expect(() => loginCommand(deps, 'wechat-oa')).toThrow()
  })
})

describe('LoginRunners lifecycle', () => {
  it('spawns with a utf-8 env, writes the pidfile, and reuses an in-flight runner', async () => {
    const fake = fakeSpawn()
    const runners = new LoginRunners({ root, scriptsDir: '/s', spawnLogin: fake.spawnLogin })
    const first = await runners.start('xiaohongshu')
    expect(first.state).toBe('starting')
    expect(fake.commands.length).toBe(1)
    expect(await readFile(loginPaths(root, 'xiaohongshu').pid, 'utf8')).toBe(String(fake.handles[0]!.pid))
    const second = await runners.start('xiaohongshu')   // 不带 restart：复用
    expect(fake.commands.length).toBe(1)
    expect(second.state).toBe('starting')
  })

  it('restart terminates the in-flight runner and spawns a fresh one', async () => {
    const fake = fakeSpawn()
    const runners = new LoginRunners({ root, scriptsDir: '/s', spawnLogin: fake.spawnLogin })
    await runners.start('xiaohongshu')
    await runners.start('xiaohongshu', true)
    expect(fake.commands.length).toBe(2)
    expect(fake.handles[0]!.exited).resolves.toBeNull()  // 第一个被 terminate
  })

  it('reaps a live orphan from the pidfile instead of spawning a second browser, and kills a dead one', async () => {
    const sleeper = spawn('sleep', ['30'])              // 真 pid：孤儿复用路径 (Review Focus 4)
    try {
      const paths = loginPaths(root, 'xiaohongshu')
      await mkdir(paths.dir, { recursive: true })
      await writeFile(paths.pid, String(sleeper.pid!), 'utf8')
      const fake = fakeSpawn()
      const runners = new LoginRunners({ root, scriptsDir: '/s', spawnLogin: fake.spawnLogin })
      const status = await runners.start('xiaohongshu')
      expect(fake.commands.length).toBe(0)              // 活 pid：不 spawn，状态照读
      expect(status.state).toBe('starting')             // 状态文件未写也不显示歧义的 unknown
    } finally { sleeper.kill() }
    const paths = loginPaths(root, 'bilibili')          // 死 pid：清掉再 spawn
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.pid, '999999', 'utf8')
    const fake = fakeSpawn()
    const runners = new LoginRunners({ root, scriptsDir: '/s', spawnLogin: fake.spawnLogin })
    await runners.start('bilibili')
    expect(fake.commands.length).toBe(1)
  })

  it('cancel terminates and marks expired; stopAll clears every runner for shutdown', async () => {
    const fake = fakeSpawn()
    const runners = new LoginRunners({ root, scriptsDir: '/s', spawnLogin: fake.spawnLogin })
    await runners.start('douyin')
    await runners.cancel('douyin')
    expect((await runners.status('douyin')).state).toBe('expired')
    await runners.start('xiaohongshu')
    await runners.stopAll()
    expect((await runners.status('xiaohongshu')).state).toBe('expired')
  })

  it('status turns a runner that exited without a terminal state into an error naming the log', async () => {
    const handle = fakeHandle(1)
    const spawnLogin: SpawnLogin = () => handle
    const runners = new LoginRunners({ root, scriptsDir: '/s', spawnLogin })
    await runners.start('douyin')
    handle.finish(9)                                     // Review Focus 3
    const status = await runners.status('douyin')
    expect(status.state).toBe('error')
    expect(status.message).toContain('douyin.log')
  })

  it('waits for a just-succeeded login runner instead of racing the profile lock', async () => {
    const fake = fakeSpawn()
    const runners = new LoginRunners({ root, scriptsDir: '/s', spawnLogin: fake.spawnLogin })
    await runners.start('xiaohongshu')                  // handle 活着
    await writeMarker(loginPaths(root, 'xiaohongshu'), 'success', '')  // runner 报了 success 但浏览器还在保存
    let ran = false
    const run: import('../src/console/whoami.ts').RunCommand = async () => {
      ran = true; return { code: 0, stdout: '{"loggedIn": true}' }
    }
    const { Whoami } = await import('../src/console/whoami.ts')
    const whoami = new Whoami({ root, scriptsDir: '/s', runners, run })
    const checking = whoami.check('xiaohongshu')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ran).toBe(false)                              // 等 runner 退出，不起第二个浏览器
    fake.handles[0]!.finish(0)
    expect(await checking).toEqual({ loggedIn: true, name: '', avatar: '' })
    expect(ran).toBe(true)
  })
})

describe('Whoami', () => {
  const runnersOf = (): LoginRunners => new LoginRunners({ root, scriptsDir: '/s' })

  it('parses the last JSON line, caches 600s, and refreshes a logged-in entry missing its name sooner', async () => {
    let calls = 0
    let now = 1_000_000
    const run: RunCommand = async cmd => {
      calls++; expect(cmd.join(' ')).toContain('xhs_publish.py')
      return { code: 0, stdout: 'noise\n{"loggedIn": true, "name": "小红书昵称", "avatar": ""}' }
    }
    const whoami = new Whoami({ root, scriptsDir: '/s', runners: runnersOf(), run, now: () => now })
    const first = await whoami.check('xiaohongshu')
    expect(first).toEqual({ loggedIn: true, name: '小红书昵称', avatar: '' })
    now += 30_000; await whoami.check('xiaohongshu'); expect(calls).toBe(1)   // 60s 窗口内命中缓存
    now += 31_000; await whoami.check('xiaohongshu'); expect(calls).toBe(2)   // 缺 avatar → 60s 后重抓
  })

  it('force skips the cache and a single flight dedupes concurrent checks', async () => {
    let started = 0
    const run: RunCommand = async () => {
      started++; await new Promise(r => setTimeout(r, 20))
      return { code: 0, stdout: '{"loggedIn": false}' }
    }
    const whoami = new Whoami({ root, scriptsDir: '/s', runners: runnersOf(), run })
    await Promise.all([whoami.check('douyin'), whoami.check('douyin')])
    expect(started).toBe(1)
    await whoami.check('douyin', true); expect(started).toBe(2)
  })

  it('treats an unconfident answer as 502, never a false negative, and writes no marker for it', async () => {
    const run: RunCommand = async cmd => cmd.join(' ').includes('douyin_publish.py')
      ? { code: 1, stdout: '{"loggedIn": false}' }                    // 非零退出：不可信
      : { code: 0, stdout: '{"loggedIn": true, "name": "b", "avatar": "c", "error": "boom"}' }  // 带 error：不可信
    const whoami = new Whoami({ root, scriptsDir: '/s', runners: runnersOf(), run })
    await expect(whoami.check('douyin')).rejects.toMatchObject({ status: 502 })
    await expect(whoami.check('xiaohongshu')).rejects.toMatchObject({ status: 502 })
    await expect(readFile(loginPaths(root, 'xiaohongshu').status, 'utf8')).rejects.toThrow()
  })

  it('confirms logged-in and writes the marker; confirms logged-out by deleting it', async () => {
    const run: RunCommand = async () => ({ code: 0, stdout: '{"loggedIn": true, "name": "n", "avatar": "a"}' })
    const whoami = new Whoami({ root, scriptsDir: '/s', runners: runnersOf(), run })
    await whoami.check('xiaohongshu')
    expect(await loggedInFast(root, 'xiaohongshu')).toBe(true)
    const runOut: RunCommand = async () => ({ code: 0, stdout: '{"loggedIn": false}' })
    const out = new Whoami({ root, scriptsDir: '/s', runners: runnersOf(), run: runOut })
    await out.check('xiaohongshu')
    expect(await loggedInFast(root, 'xiaohongshu')).toBe(false)
  })

  it('maps a timeout to 504 and lets wechat-oa fall back to credentials when the mp session is absent', async () => {
    const timeout: RunCommand = async () => { throw new Error('timed out') }
    const whoami = new Whoami({ root, scriptsDir: '/s', runners: runnersOf(), run: timeout })
    await expect(whoami.check('bilibili')).rejects.toMatchObject({ status: 504 })
    const run: RunCommand = async () => ({ code: 0, stdout: '{"loggedIn": false}' })
    const wechat = new Whoami({ root, scriptsDir: '/s', runners: runnersOf(), run,
      wechatConfigured: async () => true })
    expect(await wechat.check('wechat-oa')).toEqual({ loggedIn: true, name: '微信公众号', avatar: '' })
  })
})

describe('WechatCredentials', () => {
  it('reads through python, masks the AppID, and never returns the secret', async () => {
    const run: RunCommand = async cmd => {
      expect(cmd[0]).toBe('python3'); expect(cmd[1]).toBe('-c')
      expect(String(cmd[3])).toContain('wechat-publisher.yaml')
      return { code: 0, stdout: JSON.stringify({ app_id: 'wx1234567890ab', app_secret: 'SECRET', name: '我的号', author: '我' }) }
    }
    const creds = new WechatCredentials({ scriptsDir: '/repo/skills/easel/shared/scripts', run })
    const view = await creds.get()
    expect(view).toEqual({ configured: true, appIdMasked: 'wx1234***90ab', name: '我的号', author: '我' })
    expect(JSON.stringify(view)).not.toContain('SECRET')
  })

  it('saves by merging accounts.web and verifying the token, explaining 40164', async () => {
    const seen: string[] = []
    const run: RunCommand = async cmd => {
      seen.push(String(cmd[2]))
      return { code: 0, stdout: JSON.stringify({ ok: false, message: 'errcode=40164 invalid ip' }) }
    }
    const creds = new WechatCredentials({ scriptsDir: '/s', run })
    const result = await creds.save('wx1', 'sec', '名', '作')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('IP 白名单')
    expect(seen.length).toBe(2)                        // 写、验证（无需先读：表单带回 name/author，写入自带 merge）
    expect(seen[0]).toContain('accounts')              // 写入 merge accounts.web
    expect(seen[1]).toContain('cgi-bin/token')         // 验证真调微信
  })

  it('rejects empty fields with 400', async () => {
    const creds = new WechatCredentials({ scriptsDir: '/s', run: runFrom({}) })
    await expect(creds.save('', 'x', '', '')).rejects.toMatchObject({ status: 400 })
    await expect(creds.save('x', '', '', '')).rejects.toMatchObject({ status: 400 })
  })
})
