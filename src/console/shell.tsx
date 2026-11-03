/** Console shell: hash-routed sidebar over the shared panel views, with its own words, offline bar, and Session links. */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { usePoll } from '../client/api.ts'
import { EvalStatus } from '../client/eval.tsx'
import { ExecutionStatus } from '../client/execution.tsx'
import { en, zh, type EaselSuperagentKey } from '../client/locales.ts'
import { OverviewPage } from '../client/overview.tsx'
import { PanelProvider, usePanel, usePanelData, type PanelContext } from '../client/provider.tsx'
import { HOME, parseRoute, type Route } from '../client/route.ts'
import { SettingsPage } from '../client/settings.tsx'
import { SourceStatus } from '../client/source.tsx'
import type { T } from '../client/text.ts'
import { ThreadPage } from '../client/thread.tsx'
import { TicketPage } from '../client/ticket.tsx'
import { TriggerStatus } from '../client/trigger.tsx'
import { AccountsPage } from './accounts.tsx'
import { AnalyticsPage } from './analytics.tsx'
import { CalendarPage, PersonasPage, SkillsPage } from './content.tsx'
import { GateActions, MessagesPage } from './inbox.tsx'
import { PublishPage } from './publish.tsx'

/** The console's own translator: the zh words unless the browser asks for English. */
function consoleText(): T {
  const dictionary = navigator.language.startsWith('en') ? en : zh
  return (key: EaselSuperagentKey, values?: Record<string, unknown>) =>
    dictionary[key]?.replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? '')) ?? key
}

/** One route as a URL fragment: `#/page`, `#/page/id`, and each defined query parameter (settings carries `?group=`). */
const serialize = (route: Route): string => {
  const query = Object.entries(route.query ?? {}).filter(([, value]) => value !== undefined)
  return `#/${route.page}${route.id === undefined ? '' : `/${encodeURIComponent(route.id)}`}${query.length ? `?${new URLSearchParams(Object.fromEntries(query))}` : ''}`
}
/** The route the current URL fragment names, or `undefined` when it names none; validated by the shared route parser. */
const routeFromHash = (): Route | undefined => {
  const [path = '', search = ''] = location.hash.replace(/^#/, '').split('?')
  const [page, id] = path.split('/').filter(Boolean)
  return parseRoute({ page, id: id === undefined ? undefined : decodeURIComponent(id),
    query: Object.fromEntries(new URLSearchParams(search)) })
}

/** The route behind `location.hash`, kept current through fragment links and the browser's back and forward. */
function useHashRoute(): { route: Route; navigate: PanelContext['navigate'] } {
  const [route, setRoute] = useState<Route>(() => routeFromHash() ?? HOME)
  useEffect(() => {
    const change = () => setRoute(routeFromHash() ?? HOME)
    window.addEventListener('hashchange', change)
    return () => { window.removeEventListener('hashchange', change) }
  }, [])
  /** Moves the hash; `replace` swaps the current entry (a filter or focus change) instead of adding a back step. */
  const navigate = useCallback<PanelContext['navigate']>((next, replace = false) => {
    const hash = serialize(next)
    if (hash === location.hash) return
    if (replace) { history.replaceState(null, '', hash); setRoute(next) } else location.hash = hash
  }, [])
  return { route, navigate }
}

/** The sidebar's pages in labeled groups; every entry is `[page, label key]` and the flat order is the sidebar's order. */
const NAV_GROUPS: { label: EaselSuperagentKey; items: readonly (readonly [Route['page'], EaselSuperagentKey])[] }[] = [
  { label: 'console.group.ops', items: [['overview', 'tab.overview'], ['messages', 'nav.messages'], ['execution', 'tab.execution'], ['publish', 'nav.publish'], ['analytics', 'nav.analytics']] },
  { label: 'console.group.workspace', items: [['calendar', 'nav.calendar'], ['personas', 'nav.personas'], ['skills', 'nav.skills'], ['accounts', 'nav.accounts']] },
  { label: 'console.group.system', items: [['trigger', 'tab.trigger'], ['eval', 'tab.eval'], ['settings', 'tab.settings']] },
]
const NAV: readonly (readonly [Route['page'], EaselSuperagentKey])[] = NAV_GROUPS.flatMap(group => group.items)

/** The execution detail: the publish gate above the shared ticket page, each reading the Ticket its own way. */
function TicketWithGate({ id }: { id: string }) {
  const { call } = usePanel()
  const { data } = usePoll(() => call('GET tickets/:id', { id }), [id])
  return <>{data && <GateActions ticket={data} />}<TicketPage id={id} /></>
}

/** The active page over the shared views and the console's own content and inbox pages. */
function Page({ route }: { route: Route }) {
  const { t } = usePanel()
  const { state, error, reload } = usePanelData()
  const waiting = error ? <p className="dt-error" role="alert">{error.message}</p> : <p className="dt-hint">{t('loading')}</p>
  switch (route.page) {
    case 'overview': return <OverviewPage />
    case 'source': return <SourceStatus />
    case 'trigger': return route.id !== undefined ? <ThreadPage key={route.id} id={route.id} target={route.query?.trigger} />
      : <TriggerStatus filter={route.query?.filter ?? 'subscribed'} />
    case 'eval': return <EvalStatus filter={route.query?.filter ?? 'work'} window={route.query?.window}
      paused={!!state?.paused} />
    case 'execution': return route.id !== undefined ? <TicketWithGate key={route.id} id={route.id} />
      : state ? <ExecutionStatus filter={route.query?.filter ?? 'open'} state={state} reload={reload} /> : waiting
    case 'settings': return state ? <SettingsPage key={state.masterId} group={route.query.group} query={route.query}
      state={state} deploymentForm={undefined} /> : waiting
    case 'messages': return <MessagesPage key={route.id} id={route.id} />
    case 'calendar': return <CalendarPage />
    case 'personas': return <PersonasPage />
    case 'skills': return <SkillsPage />
    case 'accounts': return <AccountsPage />
    case 'publish': return <PublishPage />
    case 'analytics': return <AnalyticsPage />
  }
}

/** The console chrome: the offline bar as the frame's first row, then the brand and grouped page navigation beside the active view. */
function ConsoleShell({ route }: { route: Route }) {
  const { t } = usePanel()
  const { error } = usePanelData()
  const current = NAV.find(([page]) => page === route.page)
  return <div className="console-shell">
    {error && <p className="console-offline" role="status">{t('console.offlineBar')}</p>}
    <nav className="console-nav" aria-label={t('console.navLabel')}>
      <div className="console-brand">easel<span>superagent</span></div>
      <h1>{t('console.title')}</h1>
      {NAV_GROUPS.map(group => <Fragment key={group.label}>
        <h2 className="console-nav-group">{t(group.label)}</h2>
        {group.items.map(([page, key]) => <a key={page} href={`#/${page}`}
          aria-current={route.page === page ? 'page' : undefined}>{t(key)}</a>)}
      </Fragment>)}
    </nav>
    <div className="console-main">
      <main role="tabpanel" aria-label={current ? t(current[1]) : undefined}><Page route={route} /></main>
    </div>
  </div>
}

/** The console page root: its own words and hash routing wrapped around the shared panel state and views. */
export function ConsoleApp(): JSX.Element {
  const t = useMemo(consoleText, [])
  const { route, navigate } = useHashRoute()
  const back = useCallback(() => history.back(), [])
  // The console runs beside DSH, which owns the Sessions; opening one shows its page there.
  const openSession = useCallback(async () => { window.open('http://127.0.0.1:3082/', '_blank', 'noopener') }, [])
  return <PanelProvider t={t} navigate={navigate} back={back} openSession={openSession} backLabel={t('console.back')}>
    <ConsoleShell route={route} />
  </PanelProvider>
}
