/** Console inbox: the unified thread list with a new-request compose, a console thread with a follow-up compose, and the publish-gate actions. */
import { useRef, useState } from 'react'
import { usePoll, type ThreadRow, type TicketPageView } from '../client/api.ts'
import { Button } from '../client/controls.tsx'
import { threadMark, ticketMark } from '../client/marks.ts'
import { useAction, usePanel } from '../client/provider.tsx'
import { actorName, readableMarkers } from '../client/text.ts'
import { ThreadPage } from '../client/thread.tsx'
import { Hint, LoadState, StageMark, When } from '../client/widgets.tsx'

/** The person-waiting actions the publish gate serves: the worker reported itself blocked on the gate, or ready for review. */
const GATED = new Set(['blocked', 'review'])

/** One thread of the inbox: its stage and latest message beside the title, which opens the thread here in the console; console-born threads carry the badge. */
function InboxRow({ thread }: { thread: ThreadRow }): JSX.Element {
  const { t, navigate } = usePanel()
  const { dot, icon, label } = threadMark(t, thread)
  return <li className="dt-row dt-link dt-ticket">
    <div className="dt-ticket-stage"><StageMark state={dot} icon={icon} label={label} /></div>
    <div className="dt-ticket-body">
      <div className="dt-row-title">
        {thread.source === 'console' && <span className="console-badge">{t('console.title')}</span>}
        <button type="button" className="dt-open" onClick={() => navigate({ page: 'messages', id: thread.key })}>{readableMarkers(t,
          thread.title)}</button>
      </div>
      <div className="dt-row-quote dt-line">{thread.latest && <>{actorName(t, thread.latest.actor)}{t('labelSeparator')}
        {readableMarkers(t, thread.latest.preview) || t('empty')}</>}</div>
      <div className="dt-row-meta dt-line"><When at={thread.lastAt} /></div>
    </div>
  </li>
}

/** The inbox list: recent Feishu and console Threads side by side, over a compose that starts a new console request. */
function ThreadList(): JSX.Element {
  const { t, call, navigate } = usePanel()
  const [text, setText] = useState('')
  const { data, error } = usePoll(() => call('GET threads', { query: { filter: 'recent' } }), [call])
  const request = useAction(async (value: string) => {
    const result = await call('POST console/threads', { body: { text: value } })
    navigate({ page: 'messages', id: result.thread })
  })
  const send = async () => {
    if (text.trim() && await request.run(text)) setText('')
  }
  return <>
    <form className="console-compose" onSubmit={event => { event.preventDefault(); void send() }}>
      <textarea rows={2} aria-label={t('console.newThread')} placeholder={t('console.placeholder')} value={text}
        onChange={event => setText(event.target.value)} />
      <Button variant="primary" type="submit" disabled={request.busy || !text.trim()}>{t('console.send')}</Button>
    </form>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(thread => <InboxRow key={thread.key}
      thread={thread} />)}</ul> : <Hint>{t('threadsNone')}</Hint>)}
  </>
}

/** The follow-up compose of one console thread; one message id is minted per submission and reused across its retries. */
function FollowUp({ thread }: { thread: string }): JSX.Element {
  const { t, call } = usePanel()
  const [text, setText] = useState('')
  const id = useRef<string>()
  const send = useAction(async (value: string) => {
    // The id stays the same across retries of one send, so the server's idempotency by id holds; the next send mints a new one.
    id.current ??= crypto.randomUUID()
    await call('POST console/threads/:key/messages', { key: thread, body: { text: value, id: id.current } })
    id.current = undefined
  })
  const submit = async () => {
    if (text.trim() && await send.run(text)) setText('')
  }
  return <form className="console-compose console-compose-follow" onSubmit={event => { event.preventDefault(); void submit() }}>
    <textarea rows={2} aria-label={t('console.followUp')} placeholder={t('console.followUp')} value={text}
      onChange={event => setText(event.target.value)} />
    <Button variant="primary" type="submit" disabled={send.busy || !text.trim()}>{t('console.send')}</Button>
  </form>
}

/** The messages page: every recent thread together, or one thread in full — a console thread answers from the page, the rest stay read-only. */
export function MessagesPage({ id }: { id?: string }): JSX.Element {
  if (id !== undefined) return <>
    <ThreadPage id={id} />
    {/* Only the console Source accepts a message from the page; its thread keys are `console:<id>`, so the key itself tells them apart. */}
    {id.startsWith('console:') && <FollowUp thread={id} />}
  </>
  return <ThreadList />
}

/** The publish gate over a Ticket: while its worker waits on a person, the operator's answer goes in as one operator message; other stages show the stage. */
export function GateActions({ ticket }: { ticket: TicketPageView }): JSX.Element {
  const { t, call } = usePanel()
  // The stage moves as the worker reports, so the gate reads the Ticket itself instead of reaching into the ticket page's data.
  const { data, reload } = usePoll(() => call('GET tickets/:id', { id: ticket.id }), [ticket.id])
  const current = data ?? ticket
  const decide = useAction(async (text: string) => {
    await call('POST tickets/:id/message', { id: current.id, body: { text, id: crypto.randomUUID() } })
  }, { reload })
  const waiting = current.stage === 'person' && GATED.has(current.action ?? '')
  return <div className="console-gate">
    <Button variant="primary" disabled={!waiting || decide.busy} onClick={() => void decide.run('发布')}>{t('console.confirmPublish')}</Button>
    <Button variant="outline" disabled={!waiting || decide.busy} onClick={() => void decide.run('不发布')}>{t('console.refusePublish')}</Button>
    {!waiting && <span className="console-gate-stage">{ticketMark(t, current).label}</span>}
  </div>
}
