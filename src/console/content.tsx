/** Console content pages: the calendar as Easel's own records carry it, and the personas and skills of the workspace. */
import { ApiError, usePoll } from '../client/api.ts'
import { usePanel } from '../client/provider.tsx'
import { Hint, KeyValues, LoadState, Section } from '../client/widgets.tsx'

/** A record's value as text: objects and arrays as their JSON, everything else as written; no value's shape is guessed at. */
const valueText = (value: unknown): string =>
  typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)

/** One calendar record as a card of every field it carries, in the record's own order. */
function EntryCard({ entry }: { entry: Record<string, unknown> }): JSX.Element {
  return <li className="dt-row">
    <KeyValues rows={Object.entries(entry).map(([key, value]): [string, string] => [key, valueText(value)])} />
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
  const { t, call } = usePanel()
  const { data, error } = usePoll(() => call('GET calendar'), [call])
  // The host answers 404 while the workspace has no calendar yet: the page's own empty state, not a failure.
  const empty = <p className="dt-hint">{t('console.emptyCalendar')}</p>
  if (error) return error instanceof ApiError && error.missing ? empty
    : <p className="dt-error" role="alert">{error.message}</p>
  if (!data) return <Hint>{t('loading')}</Hint>
  const days = byDate(data.entries)
  return <>{days.map(([date, entries]) => <Section key={date} title={date || t('empty')} count={entries.length}>
    <ul className="dt-list">{entries.map((entry, index) => <EntryCard key={index} entry={entry} />)}</ul>
  </Section>)}{days.length === 0 && empty}</>
}

/** The personas page: the workspace's account directories, one row each. */
export function PersonasPage(): JSX.Element {
  const { t, call } = usePanel()
  const { data, error } = usePoll(() => call('GET personas'), [call])
  return <>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">
      {data.items.map(persona => <li className="dt-row" key={persona.name}>
        <div className="dt-row-title">{persona.name}</div>
      </li>)}
    </ul> : <Hint>{t('none')}</Hint>)}
  </>
}

/** The skills page: the Easel skill library, each skill's one-line description beside its name. */
export function SkillsPage(): JSX.Element {
  const { t, call } = usePanel()
  const { data, error } = usePoll(() => call('GET skills'), [call])
  return <>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">
      {data.items.map(skill => <li className="dt-row" key={skill.name}>
        <div className="dt-row-title">{skill.name}</div>
        <div className="dt-row-meta">{skill.description}</div>
      </li>)}
    </ul> : <Hint>{t('none')}</Hint>)}
  </>
}
