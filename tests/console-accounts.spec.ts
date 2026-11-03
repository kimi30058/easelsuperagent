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
import { runReal, Whoami, type RunCommand } from '../src/console/whoami.ts'
import { WechatCredentials } from '../src/console/wechat-credentials.ts'
import { AccountsApi } from '../src/console/accounts-api.ts'
import { createServer, type Server } from 'node:http'

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
  it('lists the seven fork platforms plus the wechat-oa-mp process key, and rejects anything else', () => {
    expect(PLATFORMS.map(p => p.platform)).toEqual(
      ['xiaohongshu', 'bilibili', 'douyin', 'wechat-oa', 'kuaishou', 'weixin-channels', 'zhihu'])
    expect(PROCESS_KEYS).toContain('wechat-oa-mp')
    expect(isPlatform('kuaishou')).toBe(true)           // web_publisher 族，spec 2026-11-03 接入
    expect(isPlatform('weixin-channels')).toBe(true)
    expect(isPlatform('zhihu')).toBe(true)
    expect(isPlatform('weibo')).toBe(false)             // 真未知平台（原 kuaishou 钉子反转，Review Focus 2）
    expect(isProcessKey('../../etc')).toBe(false)       // Review Focus 1
  })

  it('maps browser platforms to their global profile directory and leaves biliup/wechat-oa without one', () => {
    expect(profileDir('xiaohongshu')).toContain('XiaohongshuProfile')
    expect(profileDir('wechat-oa-mp')).toContain('WeixinMpProfile')
    expect(profileDir('kuaishou')).toContain('KuaishouProfile')
    expect(profileDir('weixin-channels')).toContain('ChannelsProfile')
    expect(profileDir('zhihu')).toContain('ZhihuProfile')
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
interface FakeHandle extends RunnerHandle { finish(code: number | null): void; signals: string[] }
const fakeHandle = (pid: number): FakeHandle => {
  let settle: (code: number | null) => void = () => undefined
  const exited = new Promise<number | null>(resolve => { settle = resolve })
  const handle: FakeHandle = { pid, exited, signals: [], finish: code => settle(code),
    kill: (signal?: string) => { handle.signals.push(signal ?? 'SIGTERM'); if (signal !== 'SIGKILL') return; settle(null) } }
  return handle
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

describe('python interpreter', () => {
  it('prefers EASEL_PYTHON, then the venv beside the skill library, then bare python3', async () => {
    const { pythonBin } = await import('../src/console/python.ts')
    const previous = process.env.EASEL_PYTHON
    try {
      process.env.EASEL_PYTHON = '/opt/custom/python'
      expect(pythonBin('/repo/skills/easel/shared/scripts')).toBe('/opt/custom/python')
      delete process.env.EASEL_PYTHON
      expect(pythonBin('/repo/skills/easel/shared/scripts')).toBe('python3')          // /repo/.venv 不存在
      const repo = await mkdtemp(join(tmpdir(), 'sp2-venv-'))
      const scripts = join(repo, 'skills', 'easel', 'shared', 'scripts')
      const venvPy = join(repo, '.venv', 'bin', 'python')
      await mkdir(join(venvPy, '..'), { recursive: true })
      await writeFile(venvPy, '', 'utf8')
      expect(pythonBin(scripts)).toBe(venvPy)
    } finally {
      if (previous === undefined) delete process.env.EASEL_PYTHON; else process.env.EASEL_PYTHON = previous
    }
  })
  it('runs the login with the resolved interpreter', () => {
    const deps = { root, scriptsDir: '/repo/skills/easel/shared/scripts', python: '/repo/.venv/bin/python' }
    expect(loginCommand(deps, 'xiaohongshu')[0]).toBe('/repo/.venv/bin/python')
  })
})

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

  it('runs the web_publisher family headless: login-qr with --platform, never sms or proxy flags', () => {
    const deps = { root, scriptsDir: '/repo/skills/easel/shared/scripts' }
    for (const key of ['kuaishou', 'weixin-channels', 'zhihu'] as const) {
      const argv = loginCommand(deps, key)
      expect(argv.some(part => part.endsWith('web_publisher.py'))).toBe(true)
      expect(argv).toContain('login-qr')               // login 是有头人工登录，runner 必须用 login-qr
      expect(argv).toContain('--platform')
      expect(argv[argv.indexOf('--platform') + 1]).toBe(key)   // key 即 --platform 参数值
      expect(argv).toContain(join(root, 'outputs', '_login', `${key}.png`))    // ADR-0007 显式传参
      expect(argv).toContain(join(root, 'outputs', '_login', `${key}.json`))
      expect(argv).not.toContain('--sms-code-file')    // 三家登录无短信墙，传了 unrecognized-argument（Review Focus 1）
      expect(argv).not.toContain('--no-proxy')         // 脚本内部 launch 已带 --no-proxy-server
    }
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
    const runners = new LoginRunners({ root, scriptsDir: '/s', spawnLogin: fake.spawnLogin, terminateWindowMs: 60 })
    await runners.start('xiaohongshu')
    await runners.start('xiaohongshu', true)
    expect(fake.commands.length).toBe(2)
    expect(fake.handles[0]!.exited).resolves.toBeNull()  // 第一个被 terminate（SIGTERM 不倒则 SIGKILL）
    expect(fake.handles[0]!.signals).toEqual(['SIGTERM', 'SIGKILL'])
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
    const runners = new LoginRunners({ root, scriptsDir: '/s', spawnLogin: fake.spawnLogin, terminateWindowMs: 60 })
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

describe('review fixes: real spawn path, cancel guard, kill escalation', () => {
  it('starts a real (non-injected) login on a fresh root: the _login dir exists before the runner opens its log', async () => {
    const scripts = await mkdtemp(join(tmpdir(), 'sp2-real-'))
    // 一个真的 python 假脚本：吃下与真实登录相同的显式参数并写出状态文件——覆盖生产 spawn 顺序。
    await writeFile(join(scripts, 'xhs_publish.py'), [
      'import json, sys',
      'args = sys.argv[1:]',
      'open(args[args.index("--status-file") + 1], "w").write(json.dumps({"state": "starting", "message": ""}))',
      'open(args[args.index("--qr-out") + 1], "wb").write(b"\\x89PNG")',
      '',
    ].join('\n'), 'utf8')
    const runners = new LoginRunners({ root, scriptsDir: scripts })
    try {
      const status = await runners.start('xiaohongshu')
      expect(status.state).toBe('starting')              // 真脚本写的状态文件被读回
      const paths = loginPaths(root, 'xiaohongshu')
      expect((await readFile(paths.pid, 'utf8')).trim()).toMatch(/^\d+$/)
    } finally { await runners.stopAll() }
  })

  it('cancel leaves a finished success login intact — no live runner, no live pid', async () => {
    const fake = fakeSpawn()
    const runners = new LoginRunners({ root, scriptsDir: '/s', spawnLogin: fake.spawnLogin })
    await runners.start('xiaohongshu')
    fake.handles[0]!.finish(0)                           // runner 正常退出
    await writeMarker(loginPaths(root, 'xiaohongshu'), 'success', '昵称')
    await runners.cancel('xiaohongshu')                  // 迟到的取消不得改写
    expect((await runners.status('xiaohongshu')).state).toBe('success')
  })

  it('escalates to SIGKILL on the process group when the terminate does not land in the window', async () => {
    const handle = fakeHandle(1)                         // SIGTERM 打不倒：只有 SIGKILL 结束它
    const spawnLogin: SpawnLogin = () => handle
    const runners = new LoginRunners({ root, scriptsDir: '/s', spawnLogin, terminateWindowMs: 60 })
    await runners.start('douyin')
    await runners.cancel('douyin')
    expect(handle.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect((await runners.status('douyin')).state).toBe('expired')
  })

  it('settles a runner whose binary never spawns (ENOENT) instead of wedging the key in-flight', async () => {
    const previousPath = process.env.PATH
    process.env.PATH = ''                                // 解析到的 python3 找不到：spawn 只发 error，不发 exit
    try {
      const runners = new LoginRunners({ root, scriptsDir: '/s', terminateWindowMs: 60 })
      await runners.start('xiaohongshu')
      expect(await runners.waitExit('xiaohongshu')).toBe(true)                        // exited 落定
      expect(runners.isRunning('xiaohongshu')).toBe(false)
      expect((await runners.status('xiaohongshu')).state).toBe('error')              // 合成异常退出并指向日志
      await expect(readFile(loginPaths(root, 'xiaohongshu').pid, 'utf8')).rejects.toThrow()  // 无 pid 可写就不写
    } finally { process.env.PATH = previousPath }
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

  it('verifies the web_publisher family via whoami --platform', async () => {
    const cmds: string[][] = []
    const run: RunCommand = async cmd => { cmds.push(cmd)
      return { code: 0, stdout: '{"loggedIn": true, "name": "知乎号", "avatar": ""}' } }
    const whoami = new Whoami({ root, scriptsDir: '/s', runners: runnersOf(), run })
    await whoami.check('zhihu')
    expect(cmds[0]!.join(' ')).toContain('web_publisher.py whoami --platform zhihu')
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

  it('never boards a force check onto a non-force flight that would settle from the cache', async () => {
    let started = 0
    const run: RunCommand = async () => { started++; return { code: 0, stdout: '{"loggedIn": false}' } }
    const whoami = new Whoami({ root, scriptsDir: '/s', runners: runnersOf(), run })
    await whoami.check('douyin')                                                  // 先填缓存
    expect(started).toBe(1)
    await Promise.all([whoami.check('douyin'), whoami.check('douyin', true)])     // 非 force 命中缓存，force 不得并船
    expect(started).toBe(2)
  })

  it('maps a spawn failure (ENOENT) onto a numeric exit code, not the error\'s string code', async () => {
    const finished = await runReal(['easel-test-no-such-binary'], { cwd: root, timeoutMs: 2000 })
    expect(finished).toEqual({ code: 1, stdout: '' })
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

  it('reads as unconfigured when python cannot answer the credentials read (missing or broken)', async () => {
    const run: RunCommand = async () => ({ code: 1, stdout: '' })   // 例：python3 缺失（ENOENT）
    const creds = new WechatCredentials({ scriptsDir: '/s', run })
    expect(await creds.get()).toEqual({ configured: false, appIdMasked: '', name: '', author: '' })
  })
})

describe('review fixes: scripts dir override', () => {
  it('honors EASEL_SKILLS_DIR over the repo-relative default', async () => {
    const { defaultScriptsDir } = await import('../src/console/accounts-api.ts')
    process.env.EASEL_SKILLS_DIR = '/custom/skills'
    try { expect(defaultScriptsDir()).toBe('/custom/skills') } finally { delete process.env.EASEL_SKILLS_DIR }
  })
})

/** An api mounted on a real HTTP server with a settings upstream naming our temp root (and its own home for profile deletes). */
async function mounted(over?: {
  settings?: object | 'dead' | (() => object | 'dead'); home?: string; spawnLogin?: SpawnLogin; run?: RunCommand; now?: () => number
}): Promise<{ base: string; close(): Promise<void> }> {
  const settings = createServer((req, res) => {
    const view = typeof over?.settings === 'function' ? over.settings() : over?.settings
    if (view === 'dead') { res.destroy(); return }
    // The real orchestrator refuses settings without the sidecar header (sameOrigin() in src/app/http.ts).
    if (req.headers['x-orchestrator-request'] !== '1') {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Same-origin management request required' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(view ?? { environment: { root, variables: [] } }))
  })
  await new Promise<void>(r => settings.listen(0, '127.0.0.1', r))
  const upstream = `http://127.0.0.1:${(settings.address() as { port: number }).port}`
  const api = new AccountsApi({ upstream, scriptsDir: '/s', home: over?.home ?? root,
    spawnLogin: over?.spawnLogin, run: over?.run, now: over?.now })
  const server = createServer((req, res) => {
    void api.handle(req, new URL(req.url ?? '/', 'http://127.0.0.1'), res).catch(() => res.destroy())
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { base, close: async () => {
    await api.stopAll()
    await new Promise<void>(r => server.close(() => r())); await new Promise<void>(r => settings.close(() => r()))
  } }
}
const post = (base: string, path: string, body?: unknown): Promise<Response> =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) })

describe('AccountsApi routes', () => {
  it('lists the seven cards with fast-path login state', async () => {
    const { base, close } = await mounted()
    try {
      const cards = await (await fetch(`${base}/api/accounts`)).json() as { platform: string; loggedIn: boolean }[]
      expect(cards.map(card => card.platform)).toEqual(
        ['xiaohongshu', 'bilibili', 'douyin', 'wechat-oa', 'kuaishou', 'weixin-channels', 'zhihu'])
      expect(cards[0]!.loggedIn).toBe(false)
    } finally { await close() }
  })

  it('answers unknown platforms and injected paths with 404, never a filesystem touch', async () => {
    const { base, close } = await mounted()
    try {
      expect((await fetch(`${base}/api/login/..%2f..%2fetc/status`)).status).toBe(404)   // Review Focus 1
      expect((await post(base, '/api/login/weibo')).status).toBe(404)                    // 真未知平台（原 kuaishou 哨兵）
      expect((await fetch(`${base}/api/accounts/tail/whoami`)).status).toBe(404)
    } finally { await close() }
  })

  it('returns 503 for every account route while the orchestrator is unreachable and no root is cached', async () => {
    const { base, close } = await mounted({ settings: 'dead' })                            // Review Focus 5
    try {
      expect((await fetch(`${base}/api/accounts`)).status).toBe(503)
      expect((await post(base, '/api/login/xiaohongshu')).status).toBe(503)
    } finally { await close() }
  })

  it('writes a valid sms code and rejects a malformed one with 400', async () => {
    const { base, close } = await mounted()
    try {
      expect((await post(base, '/api/login/douyin/sms', { code: '654321' })).status).toBe(200)
      expect(await readFile(loginPaths(root, 'douyin').code, 'utf8')).toBe('654321')
      expect((await post(base, '/api/login/douyin/sms', { code: '12' })).status).toBe(400)
    } finally { await close() }
  })

  it('serves the QR png with no-store once written', async () => {
    const paths = loginPaths(root, 'xiaohongshu')
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.status, JSON.stringify({ state: 'qr_ready', message: '', qr: '', ts: 1 }), 'utf8')
    await writeFile(paths.qr, Buffer.from([1, 2, 3]))
    const { base, close } = await mounted()
    try {
      const response = await fetch(`${base}/api/login/xiaohongshu/qr`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]))
    } finally { await close() }
  })

  it('logout removes the artifacts and the profile directory', async () => {
    const paths = loginPaths(root, 'xiaohongshu')
    await writeMarker(paths, 'success', 'n')
    const profile = join(root, '.easel-browser-profiles', 'XiaohongshuProfile')
    await mkdir(profile, { recursive: true })
    const { base, close } = await mounted()
    try {
      expect((await post(base, '/api/logout/xiaohongshu')).status).toBe(200)
      expect((await readStatus(paths)).state).toBe('unknown')
      const { stat } = await import('node:fs/promises')
      await expect(stat(profile)).rejects.toThrow()
    } finally { await close() }
  })

  it('logout of a web-family platform removes the artifacts and the profile directory', async () => {
    const paths = loginPaths(root, 'zhihu')
    await writeMarker(paths, 'success', 'n')
    const profile = join(root, '.easel-browser-profiles', 'ZhihuProfile')
    await mkdir(profile, { recursive: true })
    const { base, close } = await mounted()
    try {
      expect((await post(base, '/api/logout/zhihu')).status).toBe(200)
      expect((await readStatus(paths)).state).toBe('unknown')
      const { stat } = await import('node:fs/promises')
      await expect(stat(profile)).rejects.toThrow()
    } finally { await close() }
  })

  it('logout of wechat-oa clears both process keys and its credentials', async () => {
    for (const key of ['wechat-oa', 'wechat-oa-mp'] as const) {
      const paths = loginPaths(root, key)
      await mkdir(paths.dir, { recursive: true })
      await writeFile(paths.status, JSON.stringify({ state: 'success', message: '' }), 'utf8')
    }
    const runs: string[][] = []
    const run: RunCommand = async cmd => { runs.push(cmd); return { code: 0, stdout: '{}' } }
    const { base, close } = await mounted({ run })
    try {
      expect((await post(base, '/api/logout/wechat-oa')).status).toBe(200)
      expect((await readStatus(loginPaths(root, 'wechat-oa'))).state).toBe('unknown')
      expect((await readStatus(loginPaths(root, 'wechat-oa-mp'))).state).toBe('unknown')
      expect(runs.some(cmd => cmd.join(' ').includes("pop('web'"))).toBe(true)   // 凭证随登出清掉（CLEAR_PY）
    } finally { await close() }
  })

  it('refreshes the execution root once its TTL passes, so a migrated workspace needs no sidecar restart', async () => {
    let now = 1_000_000
    const migrated = await mkdtemp(join(tmpdir(), 'sp2-migrated-'))
    const settings = { environment: { root, variables: [] } }
    const { base, close } = await mounted({ settings: () => settings, now: () => now })
    try {
      const paths = loginPaths(migrated, 'xiaohongshu')                  // 二维码只放进迁移后的新根
      await mkdir(paths.dir, { recursive: true })
      await writeFile(paths.status, JSON.stringify({ state: 'qr_ready', message: '', qr: '', ts: 1 }), 'utf8')
      await writeFile(paths.qr, Buffer.from([9, 9, 9]))
      expect((await fetch(`${base}/api/login/xiaohongshu/qr`)).status).toBe(404)    // 旧根里还没有二维码
      settings.environment.root = migrated
      now += 31_000
      const response = await fetch(`${base}/api/login/xiaohongshu/qr`)
      expect(response.status).toBe(200)                                             // TTL 一过就读新根
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([9, 9, 9]))
    } finally { await close(); await rm(migrated, { recursive: true, force: true }) }
  })

  it('serves the cached root past the TTL when the refresh cannot reach the orchestrator', async () => {
    let now = 1_000_000
    let dead = false
    let hits = 0
    const settings = { environment: { root, variables: [] } }
    const { base, close } = await mounted({ settings: () => { hits++; return dead ? 'dead' : settings }, now: () => now })
    try {
      expect((await fetch(`${base}/api/accounts`)).status).toBe(200)               // 首次拿到根
      expect(hits).toBe(1)
      dead = true
      now += 31_000                                                                // TTL 到点但编排器断了
      expect((await fetch(`${base}/api/accounts`)).status).toBe(200)               // 旧根继续服务，不回 503
      expect((await fetch(`${base}/api/accounts`)).status).toBe(200)               // 失败按 TTL 退避：不再连发 4s 拉取
      expect(hits).toBe(2)
    } finally { await close() }
  })

  it('retires the old root\'s runners when the refreshed root moves the workspace', async () => {
    let now = 1_000_000
    const migrated = await mkdtemp(join(tmpdir(), 'sp2-migrated-'))
    const settings = { environment: { root, variables: [] } }
    let settle: (code: number | null) => void = () => undefined        // SIGTERM 一打就退的 runner
    const exited = new Promise<number | null>(resolve => { settle = resolve })
    const signals: string[] = []
    const spawnLogin: SpawnLogin = () => ({ pid: 31000, exited,
      kill: signal => { signals.push(signal ?? 'SIGTERM'); settle(null) } })
    const { base, close } = await mounted({ settings: () => settings, now: () => now, spawnLogin })
    try {
      expect((await post(base, '/api/login/xiaohongshu')).status).toBe(200)        // 旧根上起了 runner
      settings.environment.root = migrated
      now += 31_000
      await fetch(`${base}/api/accounts`)                                          // 任一请求触发换根重建
      expect(signals).toEqual(['SIGTERM'])                                         // 旧 runner 收编退场
      const retired = await readStatus(loginPaths(root, 'xiaohongshu'))
      expect(retired.state).toBe('expired')
      expect(retired.message).toContain('迁移')                                    // 文案说迁移，不说重启
    } finally { await close(); await rm(migrated, { recursive: true, force: true }) }
  })
})
