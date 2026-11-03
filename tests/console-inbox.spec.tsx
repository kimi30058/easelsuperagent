// @vitest-environment jsdom
// The console inbox: the unified thread list with its composes, and the publish-gate actions over a ticket.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { ConsoleApp } from '../src/console/shell.tsx'
import { all, click, field, find, settle, text, type } from './fixtures/panel.tsx'
import { server, threadSummary, usePanelServer } from './fixtures/panel-server.ts'

/** The thread key the fake server's `POST console/threads` stand-in answers with. */
const CONSOLE_THREAD = 'console:t4f9a1c2'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MESSAGES_PATH = `console/threads/${CONSOLE_THREAD}/messages`

let root: Root | undefined
let container: HTMLElement | undefined
const unmount = () => { act(() => { root?.unmount() }); root = undefined; container?.remove() }
usePanelServer(unmount)

/** Every request the page made, including ones the sabotage below answers instead of the fake server. */
let calls: { method: string; path: string; body?: unknown }[] = []
/** Fail the first `count` requests to one path with a 500, then delegate to the fake server. */
let sabotage: { path: string; count: number } | undefined
beforeEach(() => {
  calls = []
  const inner = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const address = new URL(String(url), 'http://127.0.0.1:3082')
    const path = decodeURIComponent(address.pathname.replace('/orchestrator/api/', '') + address.search)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method: init?.method ?? 'GET', path, ...body === undefined ? {} : { body } })
    const withoutQuery = path.split('?')[0]!
    if (sabotage && sabotage.count > 0 && withoutQuery === sabotage.path) {
      sabotage = { path: sabotage.path, count: sabotage.count - 1 }
      return Promise.resolve(new Response(JSON.stringify({ error: 'sabotaged' }), { status: 500 }))
    }
    return inner(url, init)
  }))
})

/** The shell picks its dictionary from the browser language; jsdom speaks en-US, so each test states its own. */
const speak = (value: string) => Object.defineProperty(window.navigator, 'language', { value, configurable: true })
beforeEach(() => { location.hash = ''; speak('zh-CN') })

async function mountConsole() {
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(<ConsoleApp />) })
  await settle()
}

/** Move the hash and let jsdom's asynchronous hashchange arrive inside act. */
const goto = async (hash: string) => {
  await act(async () => { location.hash = hash; await new Promise(resolve => setTimeout(resolve, 0)) })
  await settle()
}

/** Add the console thread to the fake server's list and serve its detail page, so the inbox round trip has somewhere to land. */
function serveConsoleThread() {
  const earlier = server.threadPages
  const row = threadSummary({ key: CONSOLE_THREAD, source: 'console', title: '写一篇小红书帖子', stage: 'unsubscribed',
    tickets: [], subscriptions: 0, facts: {} })
  server.threads = [...server.threads, row]
  server.threadPages = (key, query) => key === CONSOLE_THREAD
    ? { ...row, url: undefined, context: [], correlated: [], decisions: [], tickets: [], timeline: [], earlier: null }
    : earlier(key, query)
}

it('sends a new request and a follow-up through the console endpoints', async () => {
  serveConsoleThread()
  await mountConsole()
  await goto('#/messages')
  expect(calls.some(request => request.method === 'GET' && request.path === 'threads?filter=recent')).toBe(true)
  await type(field<HTMLTextAreaElement>(zh['console.newThread']), '写一篇小红书帖子')
  await click(zh['console.send'])
  expect(calls.filter(request => request.path === 'console/threads').at(-1)).toMatchObject({ method: 'POST',
    body: { text: '写一篇小红书帖子' } })
  await vi.waitFor(() => expect(location.hash).toBe(`#/messages/${encodeURIComponent(CONSOLE_THREAD)}`))
  await settle()
  expect(text()).toContain('写一篇小红书帖子')
  await type(field<HTMLTextAreaElement>(zh['console.followUp']), '标题加上标签')
  await click(zh['console.send'])
  expect(calls.filter(request => request.path === MESSAGES_PATH).at(-1)).toMatchObject({ method: 'POST',
    body: { text: '标题加上标签', id: expect.stringMatching(UUID) } })
})

it('retries a failed follow-up as the same message, and mints a fresh id for the next one', async () => {
  serveConsoleThread()
  sabotage = { path: MESSAGES_PATH, count: 1 }
  await mountConsole()
  await goto(`#/messages/${encodeURIComponent(CONSOLE_THREAD)}`)
  const followUp = () => field<HTMLTextAreaElement>(zh['console.followUp'])
  await type(followUp(), '标题加上标签')
  await click(zh['console.send'])
  await click(zh['console.send']) // the first send failed; the retry must reach the server as the same message
  const sends = calls.filter(request => request.path === MESSAGES_PATH)
  expect(sends).toHaveLength(2)
  expect(sends[1]!.body).toEqual(sends[0]!.body)
  expect(followUp().value).toBe('') // the retry succeeded, so the compose cleared
  await type(followUp(), '再补一句')
  await click(zh['console.send'])
  const later = calls.filter(request => request.path === MESSAGES_PATH).at(-1)!.body as { text: string; id: string }
  expect(later.text).toBe('再补一句')
  expect(later.id).toMatch(UUID)
  expect(later.id).not.toBe((sends[1]!.body as { id: string }).id)
})

it('lists threads from both sources together, marking console threads with the badge', async () => {
  serveConsoleThread()
  await mountConsole()
  await goto('#/messages')
  const badges = all('.console-badge')
  expect(badges).toHaveLength(1)
  expect(badges[0]!.textContent).toBe(zh['console.title'])
  expect(text()).toContain('这个文案好奇怪') // the Feishu thread sits in the same list, without a badge
  await click('写一篇小红书帖子')
  await vi.waitFor(() => expect(location.hash).toBe(`#/messages/${encodeURIComponent(CONSOLE_THREAD)}`))
})

it('opens with the header band and the compose as a card', async () => {
  await mountConsole()
  await goto('#/messages')
  expect(document.querySelector('.dt-header-title')?.textContent).toBe(zh['nav.messages'])
  expect(document.querySelector('.console-compose')?.className).toContain('console-compose')
  expect(document.querySelector('.console-compose textarea')).not.toBeNull()
})

it('keeps a thread the console cannot write to read-only', async () => {
  await mountConsole()
  await goto('#/messages/feishu%3Aoc_1%3Aom_root')
  expect(document.querySelector('.dt-page-title h2')?.textContent).toContain('这个文案好奇怪')
  expect(all('textarea')).toEqual([])
})

it('enables the publish actions only while the ticket waits for a person', async () => {
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, stage: 'person' as const, action: 'blocked' as const }
  await mountConsole()
  await goto('#/execution/t1')
  expect((find(zh['console.confirmPublish']) as HTMLButtonElement).disabled).toBe(false)
  expect((find(zh['console.refusePublish']) as HTMLButtonElement).disabled).toBe(false)
  await click(zh['console.refusePublish'])
  expect(calls.filter(request => request.path === 'tickets/t1/message').at(-1)).toMatchObject({ method: 'POST',
    body: { text: '不发布', id: expect.stringMatching(UUID) } })
})

it('retries a failed confirmation as the same message, and mints a fresh id for the next round', async () => {
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, stage: 'person' as const, action: 'blocked' as const }
  sabotage = { path: 'tickets/t1/message', count: 1 }
  await mountConsole()
  await goto('#/execution/t1')
  await click(zh['console.confirmPublish'])
  await click(zh['console.confirmPublish']) // the first send failed; the retry must reach the server as the same message
  const answers = calls.filter(request => request.path === 'tickets/t1/message')
  expect(answers).toHaveLength(2)
  expect(answers[1]!.body).toEqual(answers[0]!.body)
  await click(zh['console.confirmPublish']) // a later round of the same gate answers as a new message
  const later = calls.filter(request => request.path === 'tickets/t1/message').at(-1)!.body as { text: string; id: string }
  expect(later.text).toBe('发布')
  expect(later.id).toMatch(UUID)
  expect(later.id).not.toBe((answers[1]!.body as { id: string }).id)
})

it('disables the publish actions with the current stage while the executor works', async () => {
  await mountConsole()
  await goto('#/execution/t1')
  expect((find(zh['console.confirmPublish']) as HTMLButtonElement).disabled).toBe(true)
  expect((find(zh['console.refusePublish']) as HTMLButtonElement).disabled).toBe(true)
  expect(find(zh['console.confirmPublish']).closest('.console-gate')?.textContent).toContain(zh['stage.working'])
})

it('renders the ticket page with the headline card and the gate banner', async () => {
  await mountConsole()
  await goto('#/execution/t1')
  expect(document.querySelector('.dt-ticket-headline .dt-stage')?.textContent).toBeTruthy()
  const values = [...document.querySelectorAll('.dt-ticket-headline .dt-lv-label')].map(label => label.textContent)
  expect(values).toContain(zh['ticketMandateLabel'])
  expect(document.querySelector('.console-gate')).not.toBeNull()
})
