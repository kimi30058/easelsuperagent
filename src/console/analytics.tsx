/** The analytics page: one card per platform over /api/analytics — tiles, a sparkline, the 7-day metrics behind a chevron — plus the works table. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../client/controls.tsx'
import type { EaselSuperagentKey } from '../client/locales.ts'
import { usePanel } from '../client/provider.tsx'
import { accountsFetch } from './accounts.tsx'

interface SparkPoint { ts: number; followers: number }
interface PlatformView { platform: string; login: boolean; state: string; latest?: { followers?: number; likes?: number; nickname?: string; fetchedAt?: string; metrics?: unknown }; spark: SparkPoint[] }
interface WorkView { title: string; platform: string; date: string; stat: string; url?: string }
interface AggregateView { platforms: PlatformView[]; works: WorkView[]; progress: { done: number; total: number } }

/** 卡片标题显示名（账号页 PLATFORMS 同名）；日历匹配在协议侧，页面不做领域 join。 */
const DISPLAY_NAMES: Record<string, string> = {
  xiaohongshu: '小红书', bilibili: 'B站', douyin: '抖音', 'wechat-oa': '微信公众号',
  kuaishou: '快手', 'weixin-channels': '微信视频号', zhihu: '知乎',
}
const busyState = (view: PlatformView): boolean => view.state === 'fetching' || view.state === 'queued'
/** 本周环比从 spark 直算：最后一个点减去 ≥7 天前最近的点——不依赖脚本 growth 字段的形状。 */
const weekDelta = (spark: SparkPoint[]): number | undefined => {
  if (spark.length < 2) return undefined
  const last = spark[spark.length - 1]!
  const weekAgo = last.ts - 7 * 24 * 3600
  const base = [...spark].reverse().find(point => point.ts <= weekAgo) ?? spark[0]!
  return last.followers - base.followers
}
const formatNumber = (value: number): string => value.toLocaleString('zh-CN')

/** The analytics page: cards with the manual fetch entry points, the works table below. */
export function AnalyticsPage(): JSX.Element {
  const { t } = usePanel()
  const [data, setData] = useState<AggregateView | undefined>()
  const [loadFailed, setLoadFailed] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await accountsFetch<AggregateView>('/analytics')
      if (alive.current) { setData(next); setLoadFailed(false) }
    } catch { if (alive.current) setLoadFailed(true) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {                                    // 轮询照 SP2/SP3 模式：有采集/排队 1s 一拉，全静默即停
    if (data === undefined || !data.platforms.some(busyState)) return
    const timer = setInterval(() => { void load() }, 1000)
    return () => { clearInterval(timer) }
  }, [data, load])
  if (data === undefined) {
    if (loadFailed) return <p className="dt-error" role="alert">{t('console.analyticsLoadFailed')}{' '}
      <Button variant="outline" onClick={(): void => { setLoadFailed(false); void load() }}>{t('retry')}</Button></p>
    return <p className="dt-hint">{t('loading')}</p>
  }
  const fetching = data.progress.total > 0 && data.progress.done < data.progress.total
  const fetchAll = (): void => { void accountsFetch('/analytics/fetch', { method: 'POST', body: '{}' }).then(load).catch(() => undefined) }
  return <>
    <div className="console-page-head">
      <h2 className="dt-page-title">{t('nav.analytics')}</h2>
      <Button variant="primary" className="console-analytics-fetchall" disabled={fetching} aria-busy={fetching}
        onClick={fetchAll}>{fetching ? `${t('console.analyticsFetching')} ${data.progress.done}/${data.progress.total}` : t('console.analyticsFetchAll')}</Button>
    </div>
    <div className="console-cards">
      {data.platforms.map(view => <AnalyticsCard key={view.platform} view={view} onFetched={load} />)}
    </div>
    <WorksTable works={data.works} />
  </>
}

/** One platform's card: tiles with the computed week delta, the sparkline, the metrics behind a chevron, its own fetch button. */
function AnalyticsCard({ view, onFetched }: { view: PlatformView; onFetched: () => void }): JSX.Element {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const fetchOne = (): void => {
    setBusy(true)
    void accountsFetch(`/analytics/${view.platform}/fetch`, { method: 'POST', body: '{}' })
      .then(() => onFetched())
      .catch(() => undefined)
      .finally(() => setBusy(false))
  }
  const delta = view.latest === undefined ? undefined : weekDelta(view.spark)
  const stateText: EaselSuperagentKey | undefined = view.state === 'fetching' ? 'console.analyticsFetching'
    : view.state === 'queued' ? 'console.analyticsQueued' : view.state === 'failed' ? 'console.analyticsFetchFailed' : undefined
  return <div className="console-card" data-platform={view.platform}>
    <div className="console-card-title"><span>{DISPLAY_NAMES[view.platform] ?? view.platform}</span>
      <Button variant="outline" className="console-analytics-fetch" disabled={busy || busyState(view)} aria-busy={busy || view.state === 'fetching'}
        onClick={fetchOne}>{stateText !== undefined ? t(stateText) : t('console.analyticsFetch')}</Button>
    </div>
    {!view.login && <div className="console-card-note"><a href="#/accounts">{t('console.analyticsNotLoggedIn')}</a>
      {view.platform === 'wechat-oa' && <span> · {t('console.analyticsOaNote')}</span>}</div>}
    {view.login && view.latest === undefined && <div className="console-card-note">{t('console.analyticsNeverFetched')}</div>}
    {view.latest !== undefined && <>
      <div className="console-analytics-tiles">
        <div><div className="dt-stat-value">{view.latest.followers === undefined ? '—' : formatNumber(view.latest.followers)}</div>
          <div className="console-analytics-delta">{t('console.analyticsFollowers')}</div></div>
        <div><div className="dt-stat-value">{view.latest.likes === undefined ? '—' : formatNumber(view.latest.likes)}</div>
          <div className="console-analytics-delta">{t('console.analyticsLikes')}</div></div>
      </div>
      {delta !== undefined && delta !== 0 && <div className={`console-analytics-delta ${delta > 0 ? 'console-analytics-delta-up' : 'console-analytics-delta-down'}`}>
        {delta > 0 ? `+${formatNumber(delta)} ↗` : `${formatNumber(delta)} ↘`} {t('console.analyticsWeek')}
      </div>}
      <Sparkline points={view.spark} />
      {Array.isArray(view.latest.metrics) && view.latest.metrics.length > 0 &&
        <Button variant="ghost" className="console-analytics-expand" aria-expanded={open}
          onClick={(): void => { setOpen(!open) }}>{t('console.analyticsExpand')} {open ? '▴' : '▾'}</Button>}
      {open && Array.isArray(view.latest.metrics) && <div className="console-analytics-metrics">
        {(view.latest.metrics as { label?: unknown; value?: unknown; vs?: unknown }[]).map((metric, index) =>
          <div key={index} className="console-analytics-metric">
            <span>{typeof metric.label === 'string' ? metric.label : ''}</span>
            <span>{typeof metric.value === 'string' || typeof metric.value === 'number' ? String(metric.value) : ''}
              {typeof metric.vs === 'string' && metric.vs !== '' ? ` ${metric.vs}` : ''}</span>
          </div>)}
      </div>}
    </>}
  </div>
}

/** 迷你趋势：单系列 2px 线、无轴无图例（dataviz stat-tile 形态）；线色 = 归因层历史色 #d97706（MASTER 五层白名单）。
 *  aria-hidden：数值与环比文本即无障碍形态，图不进读屏。 */
function Sparkline({ points }: { points: SparkPoint[] }): JSX.Element | null {
  if (points.length < 2) return null
  const width = 120; const height = 28
  const values = points.map(point => point.followers)
  const min = Math.min(...values); const span = (Math.max(...values) - min) || 1
  const path = points.map((point, index) =>
    `${((index / (points.length - 1)) * width).toFixed(1)},${(height - 2 - ((point.followers - min) / span) * (height - 4)).toFixed(1)}`)
    .join(' ')
  return <svg className="console-analytics-spark" viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
    <polyline points={path} fill="none" stroke="#d97706" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
  </svg>
}

/** The works table: works[] rendered as-is（api 侧已 join），无匹配「—」，空态引导把关对话。表头列名是表数据非词条，写死中文。 */
function WorksTable({ works }: { works: WorkView[] }): JSX.Element {
  const { t } = usePanel()
  if (works.length === 0) return <div className="console-analytics-works">
    <h3 className="dt-section-title">{t('console.analyticsWorksTitle')}</h3>
    <p className="dt-hint">{t('console.analyticsWorksEmpty')} <a href="#/messages">{t('console.analyticsWorksHint')}</a></p>
  </div>
  return <div className="console-analytics-works">
    <h3 className="dt-section-title">{t('console.analyticsWorksTitle')}</h3>
    <table className="dt-table">
      <thead><tr><th>标题</th><th>平台</th><th>日期</th><th>效果</th></tr></thead>
      <tbody>{works.map((work, index) => <tr key={index}>
        <td>{work.url !== undefined ? <a href={work.url} target="_blank" rel="noreferrer">{work.title}</a> : work.title}</td>
        <td>{DISPLAY_NAMES[work.platform] ?? work.platform}</td>
        <td>{work.date}</td>
        <td>{work.stat !== '' ? work.stat : '—'}</td>
      </tr>)}</tbody>
    </table>
  </div>
}
