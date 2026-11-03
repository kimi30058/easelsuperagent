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

/** The accounts page: cards with the fast-path state, healed in the background by whoami verification. */
export function AccountsPage(): JSX.Element {
  const { t } = usePanel()
  const [cards, setCards] = useState<AccountCard[] | undefined>()
  const [offline, setOffline] = useState(false)
  const [whoami, setWhoami] = useState<Record<string, WhoamiView>>(() => readWhoamiCache())
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
        if (result.loggedIn !== card.loggedIn) void load()
      }).catch(() => undefined)  // 502/504：卡片保持原状态，不弹错（spec §7）
    }
  }, [cards, load])
  if (offline) return <p className="dt-error" role="alert">{t('console.offlineRoot')}</p>
  if (cards === undefined) return <p className="dt-hint">{t('loading')}</p>
  return <div className="console-cards">
    {cards.map(card => <AccountCardView key={card.platform} card={card} whoami={whoami[card.platform]} />)}
  </div>
}

/** One platform's card: state badge (announced atomically) and the whoami name. */
function AccountCardView({ card, whoami }: { card: AccountCard; whoami?: WhoamiView }): JSX.Element {
  const { t } = usePanel()
  return <div className="console-card" data-platform={card.platform}>
    <div className="console-card-title"><span>{card.name}</span>
      <span className={`console-state ${card.loggedIn ? 'console-state-ok' : 'console-state-off'}`}
        role="status" aria-atomic="true">{card.loggedIn ? t('console.loggedIn') : t('console.loggedOut')}</span>
    </div>
    <div className="console-card-note">{whoami?.name || card.note}</div>
  </div>
}
