/** The publish center: one card per platform over the _publish file protocol, with douyin's SMS wall and each platform's latest calendar record. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../client/controls.tsx'
import type { EaselSuperagentKey } from '../client/locales.ts'
import { usePanel } from '../client/provider.tsx'
import { accountsFetch } from './accounts.tsx'

export interface PublishView {
  platform: string; state: string; message: string; ts?: number
  logTail: string; logMtime?: number
}
interface CalendarRecord { platform: string; title: string; date: string; status: string }

/** 卡片标题的显示名（与账号页 PLATFORMS 同名，含「微信公众号」）；日历匹配名在 CALENDAR_NAMES（公众号）。 */
const DISPLAY_NAMES: Record<string, string> = {
  xiaohongshu: '小红书', bilibili: 'B站', douyin: '抖音', 'wechat-oa': '微信公众号',
  kuaishou: '快手', 'weixin-channels': '微信视频号', zhihu: '知乎',
}
/** 日历按平台中文名存记录（calendar_ops.PLATFORM_NAMES + 公众号手动 record 用名）——与显示名不同，两张表各管各的。 */
const CALENDAR_NAMES: Record<string, string> = {
  xiaohongshu: '小红书', bilibili: 'B站', douyin: '抖音', 'wechat-oa': '公众号',
  kuaishou: '快手', 'weixin-channels': '微信视频号', zhihu: '知乎',
}
const TERMINAL = ['success', 'error']
const stateLive = (view: PublishView): boolean => view.state !== 'unknown' && !TERMINAL.includes(view.state)
const logFresh = (view: PublishView): boolean =>
  view.logMtime !== undefined && Date.now() - view.logMtime < 10 * 60_000
/** 日志新鲜度只兜没有状态文件的平台（xhs/bili/wechat）：已知状态（含终态）不被日志启发式压过。 */
const live = (view: PublishView): boolean => stateLive(view) || (view.state === 'unknown' && logFresh(view))

/** The publish center: live cards while anything runs, the latest record otherwise. */
export function PublishPage(): JSX.Element {
  const { t, call } = usePanel()
  const [views, setViews] = useState<PublishView[] | undefined>()
  const [records, setRecords] = useState<CalendarRecord[] | undefined>()
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const load = useCallback(async (): Promise<void> => {
    try { const next = await accountsFetch<PublishView[]>('/publish'); if (alive.current) setViews(next) }
    catch { if (alive.current) setViews(undefined) }
  }, [])
  useEffect(() => { void load() }, [load])
  // 日历最近记录：404（还没有 _schedule.json）就是空态，不是错误。
  useEffect(() => {
    void call('GET calendar')
      .then(result => { if (alive.current) setRecords(result.entries as CalendarRecord[]) })
      .catch(() => { if (alive.current) setRecords([]) })
  }, [call])
  // 轮询照 SP2 模式：任一平台进行中 1s 一拉，全静默不轮询。
  useEffect(() => {
    if (views === undefined || !views.some(live)) return
    const timer = setInterval(() => { void load() }, 1000)
    return () => { clearInterval(timer) }
  }, [views, load])
  if (views === undefined) return <p className="dt-hint">{t('loading')}</p>
  // _schedule.json 文件序最旧在前，最近一条要从尾部找。
  const latest = (platform: string): CalendarRecord | undefined =>
    records && [...records].reverse().find(record => record.platform === CALENDAR_NAMES[platform] && record.status === 'published')
  return <div className="console-cards">
    {views.map(view => <PublishCard key={view.platform} view={view} record={latest(view.platform)} />)}
  </div>
}

/** The state machine's own words for a state the runner reported without a message. */
const STATE_TEXT: Record<string, EaselSuperagentKey> = {
  starting: 'console.publishStarting', sms_required: 'console.smsRequired', verifying: 'console.verifying',
  success: 'console.publishSuccess', error: 'console.publishError',
}

/** One platform's card: douyin's live state and SMS wall, a fresh log while it runs, the latest record otherwise. */
function PublishCard({ view, record }: { view: PublishView; record?: CalendarRecord }): JSX.Element {
  const { t } = usePanel()
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = (): void => {
    setBusy(true); setNote('')
    void accountsFetch(`/publish/${view.platform}/sms`, { method: 'POST', body: JSON.stringify({ code }) })
      .then(() => setNote(t('console.verifying')))
      .catch(error => setNote(error.message))
      .finally(() => setBusy(false))
  }
  const resend = (): void => {
    void accountsFetch(`/publish/${view.platform}/resend`, { method: 'POST', body: '{}' }).catch(() => undefined)
  }
  const stateKey = STATE_TEXT[view.state]
  return <div className="console-card" data-platform={view.platform}>
    <div className="console-card-title"><span>{DISPLAY_NAMES[view.platform]}</span>
      <span className="console-state" role="status" aria-atomic="true">
        {view.state !== 'unknown' ? (stateKey !== undefined ? t(stateKey) : view.message || view.state)
          : logFresh(view) ? t('console.publishRunning')
          : record ? `${t('console.publishSuccess')} · ${record.date}` : t('console.publishNone')}
      </span>
    </div>
    {view.platform === 'wechat-oa' && <div className="console-card-note">{t('console.publishOaNote')}</div>}
    {stateLive(view) && view.message !== '' && <div className="console-card-note">{view.message}</div>}
    {logFresh(view) && view.logTail !== '' &&
      <pre className="console-publish-log">{view.logTail}</pre>}
    {view.state === 'sms_required' && <form className="console-form" onSubmit={event => {
      event.preventDefault()
      if (!/^\d{4,8}$/.test(code.trim())) { setCodeError(t('console.smsInvalid')); return }
      submit()
    }}>
      <label htmlFor={`publish-sms-${view.platform}`}>{t('console.smsLabel')}</label>
      <input id={`publish-sms-${view.platform}`} value={code} inputMode="numeric"
        onBlur={() => { setCodeError(/^\d{4,8}$/.test(code.trim()) ? '' : t('console.smsInvalid')) }}
        onChange={event => { setCode(event.target.value); setCodeError('') }} />
      {codeError !== '' && <p className="dt-error" role="alert">{codeError}</p>}
      <Button variant="primary" type="submit" disabled={busy}>{t('console.smsSubmit')}</Button>
      <Button variant="ghost" onClick={resend}>{t('console.publishResend')}</Button>
      {note !== '' && <p className="console-card-note" role="status">{note}</p>}
    </form>}
    {!live(view) && record === undefined && view.state === 'unknown' && view.logTail === '' &&
      <a className="console-card-note" href="#/messages">{t('console.publishEmptyHint')}</a>}
    {!live(view) && record !== undefined && <div className="console-card-note">{record.title}</div>}
  </div>
}
