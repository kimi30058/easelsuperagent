/** The accounts page: one card per platform with live state and whoami names, plus the login and credentials modals and their forms. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Icon } from '../client/controls.tsx'
import { usePanel } from '../client/provider.tsx'
import type { T } from '../client/text.ts'
import { PageHeader } from '../client/widgets.tsx'

export interface AccountCard { platform: string; name: string; backend: string; note: string; loggedIn: boolean }
export interface WhoamiView { loggedIn: boolean; name: string; avatar: string }
export interface LoginStatusView { state: string; message: string; qrTs?: number }

/** Call one /api/* account endpoint (the sidecar serves these beside the proxied orchestrator API); non-2xx throws the server's message. */
export async function accountsFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { headers: { 'content-type': 'application/json' }, ...init })
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) {
    const error = new Error(body.error ?? `HTTP ${response.status}`) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  return body as T
}

const WHOAMI_KEY = 'easel-superagent/accounts-whoami'
export const readWhoamiCache = (): Record<string, WhoamiView> => {
  try { return JSON.parse(localStorage.getItem(WHOAMI_KEY) ?? '{}') as Record<string, WhoamiView> } catch { return {} }
}
const writeWhoamiCache = (value: Record<string, WhoamiView>): void => {
  try { localStorage.setItem(WHOAMI_KEY, JSON.stringify(value)) } catch { /* 私密模式等：秒显是锦上添花 */ }
}

/** The state machine's own words for a state the runner reported without a message. */
const STATE_TEXT: Record<string, 'console.loginStarting' | 'console.qrWaiting' | 'console.scanned'
  | 'console.smsRequired' | 'console.verifying' | 'console.loginSuccess' | 'console.qrExpired'> = {
  starting: 'console.loginStarting', qr_ready: 'console.qrWaiting', window_login: 'console.qrWaiting',
  scanned: 'console.scanned', sms_required: 'console.smsRequired', verifying: 'console.verifying',
  success: 'console.loginSuccess', expired: 'console.qrExpired',
}
const stateText = (t: T, state: string): string => {
  const key = STATE_TEXT[state]
  return key === undefined ? state : t(key)
}

/** The accounts page: cards with the fast-path state, healed in the background by whoami verification. */
export function AccountsPage(): JSX.Element {
  const { t } = usePanel()
  const [cards, setCards] = useState<AccountCard[] | undefined>()
  const [offline, setOffline] = useState(false)
  const [whoami, setWhoami] = useState<Record<string, WhoamiView>>(() => readWhoamiCache())
  const [loginFor, setLoginFor] = useState<{ key: string; name: string } | undefined>()
  const [confirmLogout, setConfirmLogout] = useState<string | undefined>()
  const [credentialsOpen, setCredentialsOpen] = useState(false)
  const [verifyNote, setVerifyNote] = useState<Record<string, string>>({})
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const load = useCallback(async () => {
    try { setCards(await accountsFetch<AccountCard[]>('/accounts')); setOffline(false) }
    catch { setOffline(true) }
  }, [])
  useEffect(() => { void load() }, [load])
  // 开页后台真校验：逐平台刷新昵称/头像并写 localStorage（Easel 验证过的自愈节奏）。
  useEffect(() => {
    if (cards === undefined) return
    for (const card of cards) {
      void accountsFetch<WhoamiView>(`/accounts/${card.platform}/whoami`).then(result => {
        if (!alive.current) return
        setWhoami(previous => {
          const next = { ...previous, [card.platform]: result }
          writeWhoamiCache(next)
          return next
        })
        // 自愈成功时顺手撤掉验证失败的提示：新的昵称就在眼前，旧失败话术不该并排挂着。
        setVerifyNote(previous => previous[card.platform] !== undefined && previous[card.platform] !== ''
          ? { ...previous, [card.platform]: '' } : previous)
      }).catch(() => undefined)  // 502/504：卡片保持原状态，不弹错（spec §7）
    }
  }, [cards])
  const logout = useCallback(async (platform: string) => {
    setConfirmLogout(undefined)
    await accountsFetch(`/logout/${platform}`, { method: 'POST' }).catch(() => undefined)
    await load()
  }, [load])
  const verify = useCallback(async (platform: string) => {
    setVerifyNote(previous => ({ ...previous, [platform]: '' }))
    try {
      const result = await accountsFetch<WhoamiView>(`/accounts/${platform}/whoami?force=1`)
      setWhoami(previous => {
        const next = { ...previous, [platform]: result }
        writeWhoamiCache(next)
        return next
      })
    } catch (error) {
      // 502/504：状态保持不变（spec §7）——但这是显式点过的「验证」，要说一声为什么没动静；
      // 服务端的话术（如 409 的「请稍后重试校验」）比笼统词条更有行动价值，拼在词条后面。
      const reason = error instanceof Error && error.message !== ''
        ? `${t('console.accountWhoamiFailed')}：${error.message}` : t('console.accountWhoamiFailed')
      setVerifyNote(previous => ({ ...previous, [platform]: reason }))
    }
  }, [t])
  const closeLogin = useCallback((): void => { setLoginFor(undefined); void load() }, [load])
  if (offline) return <p className="dt-error" role="alert">{t('console.offlineRoot')}</p>
  if (cards === undefined) return <p className="dt-hint">{t('loading')}</p>
  return <>
    <PageHeader title={t('nav.accounts')} hint={t('console.accountsIntro')}
      actions={<Button variant="ghost" icon={<Icon name="refresh" size={14} />}
        onClick={() => { void load() }}>{t('console.refresh')}</Button>} />
    <div className="console-cards">
      {cards.map(card => <AccountCardView key={card.platform} card={card} whoami={whoami[card.platform]}
        verifyNote={verifyNote[card.platform] ?? ''}
        onLogin={card.backend === 'wechat-oa' ? () => setLoginFor({ key: 'wechat-oa-mp', name: t('console.mpSession') })
          : () => setLoginFor({ key: card.platform, name: card.name })}
        onVerify={() => { void verify(card.platform) }}
        onLogout={() => setConfirmLogout(card.platform)}
        onCredentials={card.backend === 'wechat-oa' ? () => setCredentialsOpen(true) : undefined} />)}
      {loginFor !== undefined && <LoginModal platform={loginFor.key} name={loginFor.name} onClose={closeLogin} />}
      {confirmLogout !== undefined && <div className="console-modal" role="dialog" aria-modal="true">
        <div className="console-modal-card">
          <p>{t('console.logoutConfirm')}</p>
          <div className="console-card-actions">
            <Button variant="ghost" onClick={() => setConfirmLogout(undefined)}>{t('cancel')}</Button>
            <Button variant="ghost" className="console-danger" onClick={() => { void logout(confirmLogout) }}>{t('confirm')}</Button>
          </div>
        </div>
      </div>}
    </div>
    {credentialsOpen && <CredentialsModal onClose={() => { setCredentialsOpen(false); void load() }} />}
  </>
}

/** The account's avatar as whoami saw it, or its initial on the brand gradient when the image is missing or broken. */
function Avatar({ name, src }: { name: string; src: string }): JSX.Element {
  const [broken, setBroken] = useState(false)
  const initial = name.trim().charAt(0).toUpperCase() || '?'
  return src !== '' && !broken
    ? <img className="console-avatar" src={src} alt="" onError={() => setBroken(true)} />
    : <span className="console-avatar console-avatar-fallback" aria-hidden="true">{initial}</span>
}

/** One platform's card: the state badge up top, a fixed-height identity row in the middle, actions pinned to the bottom. */
function AccountCardView({ card, whoami, verifyNote, onLogin, onVerify, onLogout, onCredentials }: {
  card: AccountCard; whoami?: WhoamiView; verifyNote: string; onLogin(): void; onVerify(): void; onLogout(): void
  onCredentials?: () => void
}): JSX.Element {
  const { t } = usePanel()
  // whoami 真校验先于 fast path 显示（Easel 语义：真值覆盖可能过期的标记）；未返回前显示 fast path。
  const loggedIn = whoami?.loggedIn ?? card.loggedIn
  return <div className="console-card" data-platform={card.platform}>
    <div className="console-card-title"><span>{card.name}</span>
      <span className={`console-state ${loggedIn ? 'console-state-ok' : 'console-state-off'}`}
        role="status" aria-atomic="true">{loggedIn ? t('console.loggedIn') : t('console.loggedOut')}</span>
    </div>
    <div className="console-card-identity">
      {loggedIn
        ? <><Avatar name={whoami?.name ?? ''} src={whoami?.avatar ?? ''} />
          <span className="console-card-name">{whoami?.name || card.note}</span></>
        : <span className="console-card-note">{card.note}</span>}
      {card.backend === 'wechat-oa' && <span className="console-card-note console-card-credentials">{t('console.credentials')}</span>}
    </div>
    <div className="console-card-actions">
      {!loggedIn && <Button variant="primary" onClick={onLogin}>
        {card.backend === 'wechat-oa' ? t('console.mpLogin') : t('console.login')}
      </Button>}
      {loggedIn && <Button variant="outline" onClick={onVerify}>{t('console.verify')}</Button>}
      {loggedIn && <Button variant="ghost" onClick={onLogout}>{t('console.logout')}</Button>}
      {card.backend === 'wechat-oa' && <Button variant="ghost" onClick={onCredentials}>{t('console.credentialsConfigure')}</Button>}
    </div>
    {verifyNote !== '' && <p className="console-card-note" role="status">{verifyNote}</p>}
  </div>
}

interface CredentialsView { configured: boolean; appIdMasked: string; name: string; author: string }

/** The wechat-oa credentials in their own modal: the API pair publishing rides on, saved and verified in place. */
function CredentialsModal({ onClose }: { onClose(): void }): JSX.Element {
  const { t } = usePanel()
  const [view, setView] = useState<CredentialsView | undefined>()
  const [fields, setFields] = useState({ appId: '', appSecret: '', name: '', author: '' })
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  // 已存名称/默认作者预填进表单：只轮换 AppID/AppSecret 的保存把原值带回，不会用空串抹掉（服务端整组覆写）。
  useEffect(() => {
    void accountsFetch<CredentialsView>('/accounts/wechat-oa/credentials')
      .then(view => { setView(view); setFields(previous => ({ ...previous, name: view.name, author: view.author })) })
      .catch(() => undefined)
  }, [])
  const close = useCallback((): void => onClose(), [onClose])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [close])
  const save = (): void => {
    setBusy(true); setMessage('')
    void accountsFetch<{ ok: boolean; message: string }>('/accounts/wechat-oa/credentials',
      { method: 'POST', body: JSON.stringify(fields) })
      .then(result => setMessage(result.message))
      .catch(error => setMessage(error.message))
      .finally(() => setBusy(false))
  }
  return <div className="console-modal" role="dialog" aria-modal="true" aria-label={t('console.credentials')} onClick={close}>
    <div className="console-modal-card" onClick={event => event.stopPropagation()}>
      <h2>{t('console.credentials')}</h2>
      {view?.configured && view.appIdMasked !== '' && <p className="console-card-note">{view.appIdMasked}</p>}
      <p className="console-card-note">{t('console.credentialsHint')}</p>
      <form className="console-form" onSubmit={event => { event.preventDefault(); save() }}>
        <label htmlFor="credential-appid">{t('console.appId')}</label>
        <input id="credential-appid" value={fields.appId}
          onChange={event => setFields(previous => ({ ...previous, appId: event.target.value }))} />
        <label htmlFor="credential-secret">{t('console.appSecret')}</label>
        <input id="credential-secret" type="password" value={fields.appSecret}
          onChange={event => setFields(previous => ({ ...previous, appSecret: event.target.value }))} />
        <label htmlFor="credential-name">{t('console.credentialsName')}</label>
        <input id="credential-name" value={fields.name}
          onChange={event => setFields(previous => ({ ...previous, name: event.target.value }))} />
        <label htmlFor="credential-author">{t('console.credentialsAuthor')}</label>
        <input id="credential-author" value={fields.author}
          onChange={event => setFields(previous => ({ ...previous, author: event.target.value }))} />
        {message !== '' && <p className="console-card-note" role="status">{message}</p>}
        <Button variant="primary" type="submit" className={busy ? 'dt-btn-busy' : undefined} disabled={busy}>{t('console.saveCredentials')}</Button>
      </form>
      <Button variant="ghost" onClick={close}>{t('close')}</Button>
    </div>
  </div>
}

/** The login modal: the whole scan flow of one platform, polled once a second. Esc, backdrop, or the close button
 *  cancel an in-flight login; a finished one (success/expired/error) closes without touching its terminal state. */
function LoginModal({ platform, name, onClose }: { platform: string; name: string; onClose(): void }): JSX.Element {
  const { t } = usePanel()
  const [status, setStatus] = useState<LoginStatusView>({ state: 'starting', message: '' })
  const [sms, setSms] = useState('')
  const [smsError, setSmsError] = useState('')
  const [busy, setBusy] = useState(false)
  const terminal = status.state === 'success' || status.state === 'expired' || status.state === 'error'
  useEffect(() => {
    void accountsFetch<LoginStatusView>(`/login/${platform}`, { method: 'POST' })
      .then(setStatus).catch(error => setStatus({ state: 'error', message: error.message }))
  }, [platform])
  useEffect(() => {
    if (terminal) return
    const timer = setInterval(() => {
      void accountsFetch<LoginStatusView>(`/login/${platform}/status`).then(setStatus).catch(() => undefined)
    }, 1000)
    return () => clearInterval(timer)
  }, [platform, terminal, status.state])
  // 登录成功后自动收起：让卡片自己接棒显示，不需要人手点关闭（spec §6）。
  useEffect(() => {
    if (status.state !== 'success') return
    const timer = setTimeout(onClose, 900)
    return () => clearTimeout(timer)
  }, [status.state, onClose])
  const close = useCallback((): void => {
    // 仅进行中的登录被取消；终态关闭不改写服务端的 success/过期记录（迟到的取消是 noop）。
    if (!terminal) void accountsFetch(`/login/${platform}`, { method: 'DELETE' }).catch(() => undefined)
    onClose()
  }, [platform, terminal, onClose])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])
  const submitSms = (): void => {
    if (!/^\d{4,8}$/.test(sms.trim())) { setSmsError(t('console.smsInvalid')); return }
    setSmsError(''); setBusy(true)
    void accountsFetch(`/login/${platform}/sms`, { method: 'POST', body: JSON.stringify({ code: sms.trim() }) })
      .catch(error => setSmsError(error.message))
      .finally(() => setBusy(false))
  }
  const restart = (): void => {
    void accountsFetch<LoginStatusView>(`/login/${platform}?restart=1`, { method: 'POST' })
      .then(setStatus).catch(error => setStatus({ state: 'error', message: error.message }))
  }
  return <div className="console-modal" role="dialog" aria-modal="true" aria-label={`${t('console.login')} ${name}`}
    onClick={close}>
    <div className="console-modal-card" onClick={event => event.stopPropagation()}>
      <h2>{name}</h2>
      <p className="console-card-note" role="status" aria-atomic="true">
        {status.message || stateText(t, status.state)}
      </p>
      {(status.state === 'qr_ready' || status.state === 'window_login') && status.qrTs !== undefined &&
        <div className="console-qr">
          <img src={`/api/login/${platform}/qr?ts=${status.qrTs}`} alt={`${name} ${t('console.qrWaiting')}`} />
        </div>}
      {status.state === 'sms_required' && <form className="console-form" onSubmit={event => { event.preventDefault(); submitSms() }}>
        <label htmlFor={`sms-${platform}`}>{t('console.smsLabel')}</label>
        <input id={`sms-${platform}`} inputMode="numeric" autoComplete="one-time-code" value={sms}
          onChange={event => setSms(event.target.value)}
          onBlur={() => { if (sms !== '' && !/^\d{4,8}$/.test(sms.trim())) setSmsError(t('console.smsInvalid')) }} />
        {smsError !== '' && <p className="dt-error" role="alert">{smsError}</p>}
        <Button variant="primary" type="submit" disabled={busy}>{t('console.smsSubmit')}</Button>
      </form>}
      {status.state === 'expired' && <Button variant="outline" onClick={restart}>{t('console.relogin')}</Button>}
      <p className="console-card-note">{t('console.cancelLoginHint')}</p>
      <Button variant="ghost" onClick={close}>{t('close')}</Button>
    </div>
  </div>
}
