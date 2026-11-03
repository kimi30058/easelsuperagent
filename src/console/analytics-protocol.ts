/** The analytics file protocol: every path and read/write under outputs/_analytics, the calendar read, and the published→effect works join. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LoginPlatform } from './login-protocol.ts'

export const analyticsDir = (root: string): string => join(root, 'outputs', '_analytics')
export const latestPath = (root: string, platform: LoginPlatform): string => join(analyticsDir(root), `${platform}.json`)
export const jsonlPath = (root: string, platform: LoginPlatform): string => join(analyticsDir(root), `${platform}.jsonl`)

/** One platform's latest full fetch result (the script's stdout JSON, persisted by the sidecar); torn reads as undefined. */
export interface AnalyticsLatest {
  readonly followers?: number; readonly likes?: number; readonly nickname?: string; readonly fetchedAt?: string
  readonly metrics?: unknown
  readonly notes?: readonly { readonly title?: unknown; readonly url?: unknown; readonly stat?: unknown }[]
}
export async function readLatest(root: string, platform: LoginPlatform): Promise<AnalyticsLatest | undefined> {
  try {
    const data = JSON.parse(await readFile(latestPath(root, platform), 'utf8')) as Record<string, unknown>
    return data && typeof data === 'object' ? data as AnalyticsLatest : undefined
  } catch { return undefined }   // 缺失或撕裂（Review Focus 1）
}

/** Persist one fetch's full result atomically (tmp + rename, 照 writeMarker); the sidecar owns this file, the script owns the jsonl. */
export async function writeLatest(root: string, platform: LoginPlatform, value: Record<string, unknown>): Promise<void> {
  const target = latestPath(root, platform)
  await mkdir(analyticsDir(root), { recursive: true })
  const temporary = `${target}.tmp`
  await writeFile(temporary, JSON.stringify(value), 'utf8')
  await rename(temporary, target)
}

/** One sparkline point: the compact snapshot the script appends to the jsonl, reduced to what the chart needs. */
export interface SparkPoint { readonly ts: number; readonly followers: number }
/** Read the jsonl's newest snapshots for the sparkline; torn or bad lines are skipped, never thrown (Review Focus 2). */
export async function readSpark(root: string, platform: LoginPlatform, limit = 90): Promise<SparkPoint[]> {
  let text: string
  try { text = await readFile(jsonlPath(root, platform), 'utf8') } catch { return [] }
  const points: SparkPoint[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const data = JSON.parse(line) as { ts?: unknown; followers?: unknown }
      if (typeof data.ts === 'number' && typeof data.followers === 'number') points.push({ ts: data.ts, followers: data.followers })
    } catch { /* 半行：跳过 */ }
  }
  return points.slice(-limit)
}

/** A calendar record as calendar_ops writes it (platform 存中文名)；url 是发布→效果归因的主 join 键。 */
export interface CalendarRecord { platform: string; title: string; date: string; status: string; url?: string }
/** Read the calendar's entries; a missing or torn _schedule.json reads as none（页面空态，不是错误）. */
export async function readCalendarRecords(root: string): Promise<CalendarRecord[]> {
  let entries: unknown
  try { entries = (JSON.parse(await readFile(join(root, 'outputs', '_schedule.json'), 'utf8')) as { entries?: unknown }).entries }
  catch { return [] }
  if (!Array.isArray(entries)) return []
  return entries.flatMap(item => {
    const record = item as Record<string, unknown>
    return typeof record.platform === 'string' && typeof record.title === 'string'
      && typeof record.date === 'string' && typeof record.status === 'string'
      ? [{ platform: record.platform, title: record.title, date: record.date, status: record.status,
          url: typeof record.url === 'string' ? record.url : undefined }]
      : []
  })
}

/** 日历按平台中文名存记录（calendar_ops.PLATFORM_NAMES + 公众号手动 record 用名）——join 的映射键，与 publish.tsx 的 CALENDAR_NAMES 同源同值。 */
export const CALENDAR_NAME: Record<LoginPlatform, string> = {
  xiaohongshu: '小红书', bilibili: 'B站', douyin: '抖音', 'wechat-oa': '公众号',
  kuaishou: '快手', 'weixin-channels': '微信视频号', zhihu: '知乎',
}

/** One row of the works table: a recent published calendar record with its matched platform stat. */
export interface Work { readonly title: string; readonly platform: LoginPlatform; readonly date: string; readonly stat: string; readonly url?: string }
/** Join 近 30 天已发布记录 × 各平台 latest.notes[]：URL 精确匹配为主、标题前缀 12 字兜底（platform_readback 口径）；对不上 stat 为空串，映射不到的记录跳过（Review Focus 3）。 */
export function joinWorks(
  records: readonly CalendarRecord[],
  latests: Partial<Record<LoginPlatform, AnalyticsLatest | undefined>>,
  now = Date.now(),
): Work[] {
  const windowMs = 30 * 24 * 3600_000
  const works: Work[] = []
  for (const record of records) {
    const platform = (Object.keys(CALENDAR_NAME) as LoginPlatform[]).find(key => CALENDAR_NAME[key] === record.platform)
    if (platform === undefined) continue
    const time = Date.parse(`${record.date}T12:00:00Z`)
    if (!Number.isFinite(time) || now - time > windowMs) continue
    if (record.status !== 'published') continue
    const note = matchNote(record, latests[platform]?.notes)
    works.push({ title: record.title, platform, date: record.date,
      stat: note !== undefined && typeof note.stat === 'string' ? note.stat : '',
      url: note !== undefined && typeof note.url === 'string' ? note.url : record.url })
  }
  return works.sort((a, b) => b.date.localeCompare(a.date))
}
const matchNote = (
  record: CalendarRecord,
  notes: readonly { readonly title?: unknown; readonly url?: unknown; readonly stat?: unknown }[] | undefined,
): { readonly title?: unknown; readonly url?: unknown; readonly stat?: unknown } | undefined => {
  if (notes === undefined) return undefined
  if (record.url !== undefined) {
    const byUrl = notes.find(note => note.url === record.url)
    if (byUrl !== undefined) return byUrl
  }
  // 双向前缀：平台侧标题可能被截断（双侧各取前 12 字比）也可能被装饰后缀（一侧是另一侧开头）；空前缀永不匹配。
  const prefix = record.title.slice(0, 12)
  if (prefix === '') return undefined
  return notes.find(note => {
    if (typeof note.title !== 'string') return false
    const notePrefix = note.title.slice(0, 12)
    return notePrefix === prefix || note.title.startsWith(prefix) || record.title.startsWith(notePrefix)
  })
}

/** The last line of stdout that parses as a JSON object — how the fetch scripts report their full result. */
export const lastJsonObject = (stdout: string): Record<string, unknown> | undefined => {
  for (const line of [...stdout.split('\n')].reverse()) {
    const trimmed = line.trim()
    if (trimmed.startsWith('{')) { try { return JSON.parse(trimmed) as Record<string, unknown> } catch { /* keep walking */ } }
  }
  return undefined
}
