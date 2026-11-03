/** The publish center: one card per platform over the _publish file protocol, with douyin's SMS wall and each platform's latest calendar record. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '../client/controls.tsx'
import type { EaselSuperagentKey } from '../client/locales.ts'
import { usePanel } from '../client/provider.tsx'
import { accountsFetch } from './accounts.tsx'
import { live, logFresh, stateLive, type PublishView } from './publish-view.ts'

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

/** The publish center: live cards while anything runs, the latest record otherwise. */
export function PublishPage(): JSX.Element {
  const { t, call } = usePanel()
  const [views, setViews] = useState<PublishView[] | undefined>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [records, setRecords] = useState<CalendarRecord[] | undefined>()
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  // 首载失败给出错误态与重试，不再永驻「加载中」；轮询中途失败保留上一帧照常渲染。
  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await accountsFetch<PublishView[]>('/publish')
      if (alive.current) { setViews(next); setLoadFailed(false) }
    } catch { if (alive.current) setLoadFailed(true) }
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
  if (views === undefined) {
    if (loadFailed) return <p className="dt-error" role="alert">{t('console.publishLoadFailed')}{' '}
      <Button variant="outline" onClick={(): void => { setLoadFailed(false); void load() }}>{t('retry')}</Button></p>
    return <p className="dt-hint">{t('loading')}</p>
  }
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
  // 日志贴底：验证码与新进度都在尾部，等码时最想看的恰在底部。用户上翻读旧行时松手，回到底部附近再自动贴回。
  // useLayoutEffect：paint 前跳底，轮询新尾不闪旧位置（settings-kit 同款）。
  const logRef = useRef<HTMLPreElement>(null)
  const [pinned, setPinned] = useState(true)
  useLayoutEffect(() => {
    if (pinned && logRef.current !== null) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [pinned, view.logTail])
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
      <pre ref={logRef} className="console-publish-log" onScroll={event => {
        const element = event.currentTarget
        setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 40)
      }}>{view.logTail}</pre>}
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
