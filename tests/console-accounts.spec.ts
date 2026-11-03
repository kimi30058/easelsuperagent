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
})
