/** The accounts page: one card per platform with live state and whoami names, plus the login modal and its forms. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePanel } from '../client/provider.tsx'

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

/** The accounts page: cards with the fast-path state, healed in the background by whoami verification. */
export function AccountsPage(): JSX.Element {
  const { t } = usePanel()
  const [cards, setCards] = useState<AccountCard[] | undefined>()
  const [offline, setOffline] = useState(false)
  const [whoami, setWhoami] = useState<Record<string, WhoamiView>>(() => readWhoamiCache())
  const [loginFor, setLoginFor] = useState<{ key: string; name: string } | undefined>()
  const [confirmLogout, setConfirmLogout] = useState<string | undefined>()
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
      }).catch(() => undefined)  // 502/504：卡片保持原状态，不弹错（spec §7）
    }
  }, [cards])
  const logout = useCallback(async (platform: string) => {
    setConfirmLogout(undefined)
    await accountsFetch(`/logout/${platform}`, { method: 'POST' }).catch(() => undefined)
    await load()
  }, [load])
  if (offline) return <p className="dt-error" role="alert">{t('console.offlineRoot')}</p>
  if (cards === undefined) return <p className="dt-hint">{t('loading')}</p>
  return <div className="console-cards">
    {cards.map(card => <AccountCardView key={card.platform} card={card} whoami={whoami[card.platform]}
      onLogin={card.backend === 'wechat-oa' ? () => setLoginFor({ key: 'wechat-oa-mp', name: t('console.mpSession') })
        : () => setLoginFor({ key: card.platform, name: card.name })}
      onLogout={() => setConfirmLogout(card.platform)} />)}
    {loginFor !== undefined && <LoginModal platform={loginFor.key} name={loginFor.name}
      onClose={() => { setLoginFor(undefined); void load() }} />}
    {confirmLogout !== undefined && <div className="console-modal" role="dialog" aria-modal="true">
      <div className="console-modal-card">
        <p>{t('console.logoutConfirm')}</p>
        <div className="console-card-actions">
          <button type="button" onClick={() => setConfirmLogout(undefined)}>{t('cancel')}</button>
          <button type="button" className="console-danger" onClick={() => { void logout(confirmLogout) }}>{t('confirm')}</button>
        </div>
      </div>
    </div>}
  </div>
}

/** One platform's card: state badge (announced atomically), the whoami name, and its actions. */
function AccountCardView({ card, whoami, onLogin, onLogout }: {
  card: AccountCard; whoami?: WhoamiView; onLogin(): void; onLogout(): void
}): JSX.Element {
  const { t } = usePanel()
  // whoami 真校验先于 fast path 显示（Easel 语义：真值覆盖可能过期的标记）；未返回前显示 fast path。
  const loggedIn = whoami?.loggedIn ?? card.loggedIn
  return <div className="console-card" data-platform={card.platform}>
    <div className="console-card-title"><span>{card.name}</span>
      <span className={`console-state ${loggedIn ? 'console-state-ok' : 'console-state-off'}`}
        role="status" aria-atomic="true">{loggedIn ? t('console.loggedIn') : t('console.loggedOut')}</span>
    </div>
    <div className="console-card-note">{whoami?.name || card.note}</div>
    {card.backend === 'wechat-oa' && <CredentialsRow />}
    <div className="console-card-actions">
      {!loggedIn && <button type="button" onClick={onLogin}>
        {card.backend === 'wechat-oa' ? t('console.mpLogin') : t('console.login')}
      </button>}
      {loggedIn && <button type="button" onClick={onLogout}>{t('console.logout')}</button>}
    </div>
  </div>
}

interface CredentialsView { configured: boolean; appIdMasked: string; name: string; author: string }

/** The wechat-oa card's credentials row: publishing rides on AppID/AppSecret, saved and verified in place. */
function CredentialsRow(): JSX.Element {
  const { t } = usePanel()
  const [view, setView] = useState<CredentialsView | undefined>()
  const [open, setOpen] = useState(false)
  const [fields, setFields] = useState({ appId: '', appSecret: '' })
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { void accountsFetch<CredentialsView>('/accounts/wechat-oa/credentials').then(setView).catch(() => undefined) }, [])
  const refresh = (): void => { void accountsFetch<CredentialsView>('/accounts/wechat-oa/credentials').then(setView).catch(() => undefined) }
  const save = (): void => {
    setBusy(true); setMessage('')
    void accountsFetch<{ ok: boolean; message: string }>('/accounts/wechat-oa/credentials',
      { method: 'POST', body: JSON.stringify({ appId: fields.appId, appSecret: fields.appSecret,
        name: view?.name ?? '', author: view?.author ?? '' }) })
      .then(result => setMessage(result.message))
      .catch(error => setMessage(error.message))
      .finally(() => { setBusy(false); refresh() })
  }
  return <>
    <div className="console-card-note">{t('console.credentials')}
      {view?.configured && view.appIdMasked !== '' ? `：${view.appIdMasked}` : ''}</div>
    <button type="button" onClick={() => { setOpen(previous => !previous) }}>{t('console.credentials')}</button>
    {open && <form className="console-form" onSubmit={event => { event.preventDefault(); save() }}>
      <label htmlFor="credential-appid">{t('console.appId')}</label>
      <input id="credential-appid" value={fields.appId}
        onChange={event => setFields(previous => ({ ...previous, appId: event.target.value }))} />
      <label htmlFor="credential-secret">{t('console.appSecret')}</label>
      <input id="credential-secret" type="password" value={fields.appSecret}
        onChange={event => setFields(previous => ({ ...previous, appSecret: event.target.value }))} />
      {message !== '' && <p className="console-card-note" role="status">{message}</p>}
      <button type="button" disabled={busy} onClick={save}>{t('console.saveCredentials')}</button>
    </form>}
  </>
}

/** The login modal: the whole scan flow of one platform, polled once a second; closing it cancels the login. */
function LoginModal({ platform, name, onClose }: { platform: string; name: string; onClose(): void }): JSX.Element {
  const { t } = usePanel()
  const [status, setStatus] = useState<LoginStatusView>({ state: 'starting', message: '' })
  const [sms, setSms] = useState('')
  const [smsError, setSmsError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void accountsFetch<LoginStatusView>(`/login/${platform}`, { method: 'POST' })
      .then(setStatus).catch(error => setStatus({ state: 'error', message: error.message }))
  }, [platform])
  useEffect(() => {
    const terminal = status.state === 'success' || status.state === 'expired' || status.state === 'error'
    if (terminal) return
    const timer = setInterval(() => {
      void accountsFetch<LoginStatusView>(`/login/${platform}/status`).then(setStatus).catch(() => undefined)
    }, 1000)
    return () => clearInterval(timer)
  }, [platform, status.state])
  const close = (): void => {
    // 关闭即取消：终止 runner（服务端对无进行中的登录幂等处理）。
    void accountsFetch(`/login/${platform}`, { method: 'DELETE' }).catch(() => undefined)
    onClose()
  }
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
  return <div className="console-modal" role="dialog" aria-modal="true" aria-label={`${t('console.login')} ${name}`}>
    <div className="console-modal-card">
      <h2>{name}</h2>
      <p className="console-card-note" role="status" aria-atomic="true">
        {status.message || (STATE_TEXT[status.state] !== undefined ? t(STATE_TEXT[status.state]) : status.state)}
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
        <button type="submit" disabled={busy}>{t('console.smsSubmit')}</button>
      </form>}
      {status.state === 'expired' && <button type="button" onClick={restart}>{t('console.relogin')}</button>}
      <p className="console-card-note">{t('console.cancelLoginHint')}</p>
      <button type="button" onClick={close}>{t('close')}</button>
    </div>
  </div>
}
