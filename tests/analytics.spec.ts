/** Tests for the analytics domain's node side: the _analytics file protocol, the works join, and (later tasks) the runner and routes. */
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { expect, it, describe, beforeEach, afterEach } from 'vitest'
import { ExecutionRoot } from '../src/console/execution-root.ts'
import { AnalyticsApi } from '../src/console/analytics-api.ts'
import {
  CALENDAR_NAME, joinWorks, jsonlPath, lastJsonObject, latestPath,
  readCalendarRecords, readLatest, readSpark, writeLatest,
} from '../src/console/analytics-protocol.ts'
import { AnalyticsRunners, analyticsCommand, ANALYTICS_TIMEOUT_MS, type FetchHandle } from '../src/console/analytics-runner.ts'
import { loginPaths, writeMarker } from '../src/console/login-protocol.ts'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sp4-protocol-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('analytics file protocol', () => {
  it('round-trips the latest result atomically; a torn file reads as undefined', async () => {
    await writeLatest(root, 'douyin', { followers: 789, likes: 12000, nickname: '晚风' })
    expect(await readLatest(root, 'douyin')).toMatchObject({ followers: 789, likes: 12000, nickname: '晚风' })
    expect(await readLatest(root, 'xiaohongshu')).toBeUndefined()
    await writeFile(latestPath(root, 'douyin'), '{"followers": 12', 'utf8')   // 撕裂写（Review Focus 1）
    expect(await readLatest(root, 'douyin')).toBeUndefined()
  })

  it('reads the jsonl tail for the sparkline, skipping torn or bad lines', async () => {
    const lines = [
      JSON.stringify({ ts: 1, followers: 100, likes: 1, posts: 1 }),
      '{"ts": 2, "followers": 11',                                              // 半行（Review Focus 2）
      'not json at all',
      JSON.stringify({ ts: 3, followers: 300, likes: 3, posts: 3 }),
    ]
    await mkdir(join(root, 'outputs', '_analytics'), { recursive: true })
    await writeFile(jsonlPath(root, 'xiaohongshu'), `${lines.join('\n')}\n`, 'utf8')
    expect(await readSpark(root, 'xiaohongshu')).toEqual([
      { ts: 1, followers: 100 }, { ts: 3, followers: 300 },
    ])
  })

  it('caps the sparkline at the newest 90 points', async () => {
    await mkdir(join(root, 'outputs', '_analytics'), { recursive: true })
    const all = Array.from({ length: 95 }, (_, i) => JSON.stringify({ ts: i, followers: i }))
    await writeFile(jsonlPath(root, 'zhihu'), `${all.join('\n')}\n`, 'utf8')
    const spark = await readSpark(root, 'zhihu')
    expect(spark).toHaveLength(90)
    expect(spark[0]).toEqual({ ts: 5, followers: 5 })
  })

  it('reads calendar records, treating a missing or torn _schedule.json as none', async () => {
    expect(await readCalendarRecords(root)).toEqual([])
    await mkdir(join(root, 'outputs'), { recursive: true })
    await writeFile(join(root, 'outputs', '_schedule.json'), JSON.stringify({ entries: [
      { platform: '小红书', title: '秋天的第一杯', date: '2026-11-01', status: 'published', url: 'https://x/x1' },
      { platform: '小红书', title: '还是草稿', date: '2026-11-02', status: 'draft' },
    ] }), 'utf8')
    expect((await readCalendarRecords(root)).map(record => record.title)).toEqual(['秋天的第一杯', '还是草稿'])   // status 过滤归 joinWorks，读取只做形状收敛
    await writeFile(join(root, 'outputs', '_schedule.json'), '{"entries": [ tor', 'utf8')
    expect(await readCalendarRecords(root)).toEqual([])
  })

  it('picks the last JSON object line off a script stdout', () => {
    expect(lastJsonObject('noise\n{"a": 1}\nmore noise\n{"b": 2}')).toEqual({ b: 2 })
    expect(lastJsonObject('no json here')).toBeUndefined()
  })
})

describe('works join', () => {
  const now = new Date('2026-11-03T12:00:00Z').getTime()
  const published = (over: Partial<Record<string, unknown>>): Record<string, unknown> => ({
    platform: '小红书', title: '秋天的第一杯奶茶', date: '2026-11-01', status: 'published', url: 'https://x/x1', ...over,
  })
  const notes = (platform: string, list: Record<string, unknown>[]): Record<string, unknown> => ({
    [platform]: { notes: list },
  })

  it('joins a published record to its note by exact URL', () => {
    const latests = notes('xiaohongshu', [{ title: '秋天的第一杯奶茶', url: 'https://x/x1', stat: '赞 23 评 4' }])
    const works = joinWorks([published({})] as never, latests as never, now)
    expect(works).toEqual([{ title: '秋天的第一杯奶茶', platform: 'xiaohongshu', date: '2026-11-01', stat: '赞 23 评 4', url: 'https://x/x1' }])
  })

  it('falls back to a 12-char title prefix when the record has no url', () => {
    const latests = notes('xiaohongshu', [{ title: '秋天的第一杯奶茶（改）', url: 'https://x/other', stat: '赞 9' }])
    const works = joinWorks([published({ url: undefined })] as never, latests as never, now)
    expect(works[0]).toMatchObject({ stat: '赞 9', url: 'https://x/other' })
  })

  it('lists an unmatched or out-of-window work with an empty stat, never crashes on unknown platforms', () => {
    const works = joinWorks([
      published({ title: '很旧的作品', date: '2026-09-01' }),                                  // 超出 30 天窗
      published({ platform: '神秘平台', title: '手写记录' }),                                    // 映射不到（Review Focus 3）
      published({ title: '没对上的新作' }),
    ] as never, {} as never, now)
    expect(works.map(work => work.title)).toEqual(['没对上的新作'])   // 旧作出窗不列；映射不到的记录跳过（Review Focus 3）
    expect(works.every(work => work.stat === '')).toBe(true)
  })
})

/** 等队列的微任务链与 writeLatest 的 fs 落盘走完再断言（exit 只点亮 Promise，finish 链在其后）。 */
const settle = (ms = 15): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('analytics command', () => {
  it('runs the three backends with explicit paths (ADR-0007)', () => {
    const deps = { root, scriptsDir: '/skills/easel/shared/scripts', python: '/py' }
    expect(analyticsCommand(deps, 'kuaishou')).toEqual([
      '/py', '/skills/easel/shared/scripts/account_stats.py', 'fetch', '--platform', 'kuaishou'])
    expect(analyticsCommand(deps, 'bilibili')).toEqual([
      '/py', '/skills/easel/shared/scripts/bili_login.py', 'stats',
      '--cookie', join(root, 'outputs', '_login', 'bilibili-cookies.json')])
    expect(analyticsCommand(deps, 'wechat-oa')).toEqual([
      '/py', '/skills/easel/shared/scripts/weixin_mp_stats.py', 'stats', '--count', '20'])
  })
})

describe('AnalyticsRunners queue', () => {
  /** 手柄工厂：exit() 由测试控，kill 只记录——队列推进只认 exited。 */
  const manual = (stdout = '{"followers": 10}'): { handle: FetchHandle; exit: (code: number | null) => void; kills: string[] } => {
    let resolveExit: (code: number | null) => void = () => {}
    const exited = new Promise<number | null>(code => { resolveExit = code })
    const kills: string[] = []
    const handle: FetchHandle = { pid: 4321, exited, stdout: Promise.resolve(stdout),
      kill: signal => { kills.push(signal ?? 'SIGTERM') } }
    return { handle, exit: resolveExit, kills }
  }
  const make = (spawn: () => FetchHandle): AnalyticsRunners =>
    new AnalyticsRunners({ root, scriptsDir: '/skills', spawn: () => spawn() })

  it('runs platforms serially, persists the last JSON line, and keeps the batch progress', async () => {
    const first = manual('{"followers": 100}'); const second = manual('{"followers": 200}')
    let spawns = 0
    const runners = make(() => { spawns++; return spawns === 1 ? first.handle : second.handle })
    await runners.enqueue('xiaohongshu'); await runners.enqueue('douyin')
    expect(runners.stateOf('douyin')).toBe('queued')
    expect(runners.progress()).toEqual({ done: 0, total: 2 })
    await first.exit(0); await settle()
    expect(await readLatest(root, 'xiaohongshu')).toMatchObject({ followers: 100 })   // stdout 末行已落盘
    expect(runners.progress()).toEqual({ done: 1, total: 2 })
    await second.exit(1); await settle()                                               // 非零退出 → failed，不写 latest
    expect(runners.stateOf('douyin')).toBe('failed')
    expect(await readLatest(root, 'douyin')).toBeUndefined()
    expect(spawns).toBe(2)                                                             // 串行：第二个在第一个退出后才起
    expect(runners.progress()).toEqual({ done: 0, total: 0 })                         // 批次收清
  })

  it('escalates a hung fetch to SIGKILL and the queue moves on (Review Focus 4)', async () => {
    const hung = manual(); const next = manual()
    let spawns = 0
    const quick = new AnalyticsRunners({ root, scriptsDir: '/skills',
      timeouts: { ...ANALYTICS_TIMEOUT_MS, xiaohongshu: 20, douyin: 20 },   // Record 全键型：铺满表再覆写用例键
      terminateWindowMs: 10, spawn: () => { spawns++; return spawns === 1 ? hung.handle : next.handle } })
    await quick.enqueue('xiaohongshu'); await quick.enqueue('douyin')
    await settle(80)                                                                   // 超时 20ms + 升级窗 10ms 内已 kill
    expect(hung.kills).toContain('SIGTERM'); expect(hung.kills).toContain('SIGKILL')
    await hung.exit(null); await settle()                                              // SIGKILL 后 exit 到达（signal → null）
    expect(quick.stateOf('xiaohongshu')).toBe('failed')                                // 超时 → failed
    await next.exit(0); await settle()
    expect(quick.stateOf('douyin')).toBe('idle')                                       // 队列照常推进
  })

  it('marks a spawn failure (no pid) failed and keeps the queue going (Review Focus 5)', async () => {
    const good = manual()
    let first = true
    const runners = make(() => {
      if (first) { first = false; return { pid: 0, exited: Promise.resolve(null),
        stdout: Promise.resolve(''), kill: () => undefined } }   // 真实 spawn 失败：exited=null，stdout 永不 reject 只给空串
      return good.handle
    })
    await runners.enqueue('zhihu'); await runners.enqueue('kuaishou')
    await good.exit(0); await settle()
    expect(runners.stateOf('zhihu')).toBe('failed')
    expect(runners.stateOf('kuaishou')).toBe('idle')
  })

  it('enqueue is idempotent while queued or fetching', async () => {
    const only = manual()
    const runners = make(() => only.handle)
    expect(await runners.enqueue('xiaohongshu')).toBe(true)
    expect(await runners.enqueue('xiaohongshu')).toBe(false)                           // 采集中重复请求不重起
    await only.exit(0); await settle()                                                 // 等 writeLatest 落完，别让 afterEach 的 rm 撞上
  })

  it('enqueueLoggedIn and catchUp only touch logged-in, stale platforms', async () => {
    await writeMarker(loginPaths(root, 'xiaohongshu'), 'success', '已登录')             // 已登录
    await writeLatest(root, 'xiaohongshu', { followers: 1 })                           // 且刚采过（新鲜）
    await writeMarker(loginPaths(root, 'douyin'), 'success', '已登录')                 // 已登录但从未采集 → 过期
    const flights: ReturnType<typeof manual>[] = []
    const runners = new AnalyticsRunners({ root, scriptsDir: '/skills', staleMs: 20 * 3600_000,
      spawn: () => { const flight = manual(); flights.push(flight); return flight.handle } })
    expect(await runners.enqueueLoggedIn()).toBe(2)                                    // xhs + douyin（其余未登录）
    for (const flight of flights.slice()) await flight.exit(0)
    await settle()
    // catchUp：把 xhs 的 latest 拨回 21h 前 → 下次 catchUp 只补它（douyin 刚采过仍新鲜）
    const back = new Date(Date.now() - 21 * 3600_000)
    await utimes(latestPath(root, 'xiaohongshu'), back, back)
    expect(await runners.catchUp()).toBe(1)
    for (const flight of flights.slice()) await flight.exit(0)                         // 收尾：catchUp 起的航班也落停
  })

  it('snapshots bili/mp fetches itself — account_stats platforms stay the script\'s to write', async () => {
    const before = Math.floor(Date.now() / 1000)
    const bili = manual('{"platform":"bilibili","followers":456,"likes":78,"posts":2}')
    const oa = manual('{"platform":"wechat-oa","followers":10,"likes":20,"posts":3}')
    const xhs = manual('{"platform":"xiaohongshu","followers":1,"likes":2,"posts":3}')
    const order = [bili, oa, xhs]
    let index = 0
    const queue = new AnalyticsRunners({ root, scriptsDir: '/skills', now: () => (before + 60) * 1000,   // 秒级 ts 可断言
      spawn: () => order[index++]!.handle })
    await queue.enqueue('bilibili'); await queue.enqueue('wechat-oa'); await queue.enqueue('xiaohongshu')
    for (const flight of order) await flight.exit(0)
    await settle(60)                                                                  // 三条 writeLatest+appendSnapshot 的 fs 链
    const biliLine = (await readFile(jsonlPath(root, 'bilibili'), 'utf8').catch(() => '')).trim()
    expect(JSON.parse(biliLine)).toMatchObject({ followers: 456, likes: 78, posts: 2, ts: before + 60 })
    const oaLine = (await readFile(jsonlPath(root, 'wechat-oa'), 'utf8').catch(() => '')).trim()
    expect(JSON.parse(oaLine)).toMatchObject({ followers: 10, ts: before + 60 })
    await expect(readFile(jsonlPath(root, 'xiaohongshu'), 'utf8')).rejects.toThrow()   // account_stats 族：sidecar 不写
  })
})

describe('AnalyticsApi routes', () => {
  let settings: Server; let upstream: string; let server: Server; let base: string
  let apiRoot: string
  const manual = (): { handle: FetchHandle; exit: (code: number | null) => void } => {
    let resolveExit: (code: number | null) => void = () => {}
    const exited = new Promise<number | null>(code => { resolveExit = code })
    const handle: FetchHandle = { pid: 8100, exited, stdout: Promise.resolve('{"followers": 42}'), kill: () => undefined }
    return { handle, exit: resolveExit }
  }
  let spawned: { handle: FetchHandle; exit: (code: number | null) => void } | undefined

  beforeEach(async () => {
    apiRoot = await mkdtemp(join(tmpdir(), 'sp4-api-'))
    settings = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ environment: { root: apiRoot } }))
    })
    await new Promise<void>(resolve => settings.listen(0, '127.0.0.1', resolve))
    upstream = `http://127.0.0.1:${(settings.address() as { port: number }).port}`
    spawned = undefined
    const analytics = new AnalyticsApi({ root: new ExecutionRoot({ upstream }), spawn: () => { spawned = manual(); return spawned.handle } })
    server = createServer((req, res) => {
      void analytics.handle(req, new URL(req.url ?? '/', 'http://127.0.0.1'), res)
        .then(claimed => { if (!claimed) { res.writeHead(404); res.end('{}') } })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => settings.close(() => resolve()))
    await rm(apiRoot, { recursive: true, force: true })
  })

  it('aggregates login, state, spark, works and progress over GET /api/analytics', async () => {
    await writeMarker(loginPaths(apiRoot, 'xiaohongshu'), 'success', '已登录')
    await writeLatest(apiRoot, 'xiaohongshu', { followers: 1234, likes: 12300, nickname: '晚风',
      notes: [{ title: '秋天的第一杯奶茶', url: 'https://x/x1', stat: '赞 23' }] })
    await mkdir(join(apiRoot, 'outputs', '_analytics'), { recursive: true })
    await writeFile(jsonlPath(apiRoot, 'xiaohongshu'),
      `${JSON.stringify({ ts: 1, followers: 1200 })}\n${JSON.stringify({ ts: 2, followers: 1234 })}\n`, 'utf8')
    await mkdir(join(apiRoot, 'outputs'), { recursive: true })
    await writeFile(join(apiRoot, 'outputs', '_schedule.json'), JSON.stringify({ entries: [
      { platform: '小红书', title: '秋天的第一杯奶茶', date: '2026-11-01', status: 'published', url: 'https://x/x1' },
    ] }), 'utf8')
    const response = await fetch(`${base}/api/analytics`)
    expect(response.status).toBe(200)
    const json = await response.json() as { platforms: { platform: string; login: boolean; state: string; spark: unknown[] }[]
      works: { title: string; stat: string }[]; progress: { done: number; total: number } }
    expect(json.platforms.map(view => view.platform)).toEqual(
      ['xiaohongshu', 'bilibili', 'douyin', 'wechat-oa', 'kuaishou', 'weixin-channels', 'zhihu'])
    const xhs = json.platforms[0]!
    expect(xhs.login).toBe(true)
    expect(xhs.spark).toEqual([{ ts: 1, followers: 1200 }, { ts: 2, followers: 1234 }])
    expect(json.works).toEqual([{ title: '秋天的第一杯奶茶', platform: 'xiaohongshu', date: '2026-11-01', stat: '赞 23', url: 'https://x/x1' }])
    expect(json.progress).toEqual({ done: 0, total: 0 })
  })

  it('enqueues one platform idempotently and all logged-in platforms over POST', async () => {
    await writeMarker(loginPaths(apiRoot, 'douyin'), 'success', '已登录')
    const first = await fetch(`${base}/api/analytics/douyin/fetch`, { method: 'POST' })
    expect(first.status).toBe(200)
    const again = await fetch(`${base}/api/analytics/douyin/fetch`, { method: 'POST' })
    expect(again.status).toBe(200)
    expect((await again.json() as { queued: number }).queued).toBe(0)                 // 幂等：不重复入队
    const all = await fetch(`${base}/api/analytics/fetch`, { method: 'POST' })
    expect((await all.json() as { queued: number }).queued).toBe(0)                   // douyin 已在采，其余未登录
    expect(spawned).toBeDefined()
    spawned!.exit(0)                                                                   // 收尾：别把句柄留给 afterEach
  })

  it('404s an unknown platform and 503s while the orchestrator has never named a root', async () => {
    const unknown = await fetch(`${base}/api/analytics/nope/fetch`, { method: 'POST' })
    expect(unknown.status).toBe(404)
    const dead = createServer((req, res) => { res.destroy() })
    await new Promise<void>(resolve => dead.listen(0, '127.0.0.1', resolve))
    const deadUpstream = `http://127.0.0.1:${(dead.address() as { port: number }).port}`
    const analytics = new AnalyticsApi({ root: new ExecutionRoot({ upstream: deadUpstream }) })
    const bare = createServer((req, res) => {
      void analytics.handle(req, new URL(req.url ?? '/', 'http://127.0.0.1'), res)
        .then(claimed => { if (!claimed) { res.writeHead(404); res.end('{}') } })
    })
    await new Promise<void>(resolve => bare.listen(0, '127.0.0.1', resolve))
    try {
      const response = await fetch(`http://127.0.0.1:${(bare.address() as { port: number }).port}/api/analytics`)
      expect(response.status).toBe(503)
      expect((await response.json() as { error?: string }).error).toContain('编排器')
    } finally {
      await new Promise<void>(resolve => bare.close(() => resolve()))
      await new Promise<void>(resolve => dead.close(() => resolve()))
    }
  })
})
