/** Console content pages: the calendar as Easel's own records carry it, and the personas and skills of the workspace. */
import { ApiError, usePoll } from '../client/api.ts'
import { Button } from '../client/controls.tsx'
import { usePanel } from '../client/provider.tsx'
import { EmptyState, KeyValues, LoadState, PageHeader, Section } from '../client/widgets.tsx'

/** A record's value as text: objects and arrays as their JSON, everything else as written; no value's shape is guessed at. */
const valueText = (value: unknown): string =>
  typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)

/** One calendar record as a card row: the platforms bracket the topic up front, every other field follows in its own order; `date` rides the group title. */
function EntryCard({ entry }: { entry: Record<string, unknown> }): JSX.Element {
  const topic = entry.topic !== undefined ? entry.topic : entry.title !== undefined ? entry.title : ''
  const rest = Object.entries(entry).filter(([key]) => !['date', 'topic', 'title', 'platforms'].includes(key))
  const platforms = Array.isArray(entry.platforms) ? entry.platforms.map(String) : []
  return <li className="dt-row console-entry">
    <div className="dt-row-main">
      <div className="dt-row-title console-entry-title">
        {platforms.map(platform => <span key={platform} className="console-entry-platform">[{platform}]</span>)}
        <span>{valueText(topic)}</span>
      </div>
      <KeyValues rows={rest.map(([key, value]): [string, string] => [key, valueText(value)])} />
    </div>
  </li>
}

/** The records grouped by their `date` field, latest first; a record without a date groups under the empty name, which sorts last. */
function byDate(entries: unknown[]): [string, Record<string, unknown>[]][] {
  const days = new Map<string, Record<string, unknown>[]>()
  for (const entry of entries) {
    const record = typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry as Record<string, unknown> : {}
    const date = typeof record.date === 'string' && record.date ? record.date : ''
    days.set(date, [...(days.get(date) ?? []), record])
  }
  return [...days.entries()].sort(([former], [latter]) => (former < latter ? 1 : former > latter ? -1 : 0))
}

/** The calendar page: Easel's schedule records exactly as recorded, grouped by date and latest first. */
export function CalendarPage(): JSX.Element {
  const { t, call, navigate } = usePanel()
  const { data, error } = usePoll(() => call('GET calendar'), [call])
  // The host answers 404 while the workspace has no calendar yet: the page's own empty state, not a failure.
  const missing = error instanceof ApiError && error.missing
  const empty = <EmptyState icon="inbox" title={t('console.emptyCalendar')} hint={t('console.emptyCalendarHint')}
    action={<Button variant="primary" onClick={() => navigate({ page: 'messages' })}>{t('console.emptyCalendarAction')}</Button>} />
  const days = data === undefined ? [] : byDate(data.entries)
  return <>
    <PageHeader title={t('nav.calendar')} hint={t('console.calendarIntro')} />
    <LoadState error={missing ? undefined : error} loading={data === undefined && error === undefined} />
    {days.map(([date, entries]) => <Section key={date} title={date || t('empty')} count={entries.length}>
      <ul className="dt-list">{entries.map((entry, index) => <EntryCard key={index} entry={entry} />)}</ul>
    </Section>)}
    {(missing || data !== undefined) && days.length === 0 && empty}
  </>
}

/** The personas page: the workspace's account directories, one card each with its path. */
export function PersonasPage(): JSX.Element {
  const { t, call } = usePanel()
  const { data, error } = usePoll(() => call('GET personas'), [call])
  return <>
    <PageHeader title={t('nav.personas')} hint={t('console.personasIntro')} />
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <div className="console-persona-grid">
      {data.items.map(persona => <div className="console-card" key={persona.name}>
        <div className="dt-row-title">{persona.name}</div>
        <div className="dt-row-meta dt-mono">profiles/{persona.name}/</div>
      </div>)}
    </div> : <EmptyState icon="settings" title={t('console.emptyPersonasTitle')} hint={t('console.emptyPersonasHint')} />)}
  </>
}

/** The skills page: the Easel skill library, each skill's one-line description beside its name. */
export function SkillsPage(): JSX.Element {
  const { t, call } = usePanel()
  const { data, error } = usePoll(() => call('GET skills'), [call])
  return <>
    <PageHeader title={t('nav.skills')} hint={t('console.skillsIntro')} />
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <div className="console-card-grid">
      {data.items.map(skill => <div className="console-card" key={skill.name}>
        <div className="dt-row-title">{skill.name}</div>
        <div className="dt-row-meta">{skill.description}</div>
      </div>)}
    </div> : <EmptyState icon="settings" title={t('none')} />)}
  </>
}
