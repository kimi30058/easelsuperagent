/** Tests for the analytics domain's node side: the _analytics file protocol, the works join, and (later tasks) the runner and routes. */
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, describe, beforeEach, afterEach } from 'vitest'
import {
  CALENDAR_NAME, joinWorks, jsonlPath, lastJsonObject, latestPath,
  readCalendarRecords, readLatest, readSpark, writeLatest,
} from '../src/console/analytics-protocol.ts'

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
