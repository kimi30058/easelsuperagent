import { expect, it, vi } from 'vitest'
import { Engine, key, ticketStage, type Outcome } from '../src/core/index.ts'
import { consoleKind } from '../src/sources/console.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { registerHttp } from '../src/app/http.ts'
import type { HttpHost } from '../src/app/http.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

/** A host as docs/008-cookbook section 11 builds it: a real Store in a tmpdir, a registry holding the console kind, and an Engine on stand-in ports. */
function host() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'console-api-')), 'db.sqlite'))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(consoleKind)
  // The policy block as the panel saves it: the console part carries no configuration, and the kind bakes the operator in.
  store.saveSettings(SettingsSchema.parse({ policy: { sources: sources.validatePolicy({ console: {} }) } }))
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  return { store, engine }
}

it('creates a console thread, and a retried send with the same message id is a duplicate', async () => {
  const h = host()
  const call = serve({ store: h.store, engine: h.engine, requestPass: () => {} })
  const first = await call('POST', 'console/threads', { text: '写一篇小红书帖子' })
  expect(first).toMatchObject({ status: 200, body: { received: 'stored', thread: expect.stringMatching(/^console:t/) } })
  // 追问走完整线程键；同一 id 重发 => duplicate
  const path = `console/threads/${encodeURIComponent(first.body.thread as string)}/messages`
  const follow = await call('POST', path, { text: '再多写两条', id: 'm1' })
  expect(follow).toMatchObject({ status: 200, body: { received: 'stored', trigger: key('console', 'm1') } })
  const again = await call('POST', path, { text: '再多写两条', id: 'm1' })
  expect(again).toMatchObject({ status: 200, body: { received: 'duplicate' } })
  h.store.close()
})

it('injects an operator message that releases a blocked ticket', async () => {
  const h = host()
  const call = serve({ store: h.store, engine: h.engine, requestPass: () => {} })
  const { body } = await call('POST', 'console/threads', { text: '写一篇小红书帖子' })
  // The assessor stands still, so the test decides the held candidate itself, as the main Session would.
  const triggerId = body.trigger as string
  const accept: Outcome = { kind: 'accept', title: '写一篇小红书帖子', scope: 'small', reason: 'requested',
    acknowledgement: 'ok', evalId: h.engine.candidate(triggerId)?.evalId }
  const ticketId = h.engine.decide(triggerId, accept).ticketId!
  h.engine.report(ticketId, { state: 'blocked', summary: '等待发布确认' })
  expect(ticketStage(h.store.tickets.get(ticketId)!)).toEqual({ stage: 'person', action: 'blocked' })
  // The gate message must arrive after the blocked report, so the follow-up counts as new.
  await new Promise(resolve => setTimeout(resolve, 3))
  const sent = await call('POST', `tickets/${ticketId}/message`, { text: '发布', id: 'g1' })
  expect(sent).toMatchObject({ status: 200, body: { received: 'stored', attached: true } })
  const after = h.store.tickets.get(ticketId)!
  const input = after.inputs.at(-1)!
  expect(input.kind === 'trigger' && input.human).toBe(true) // 人工消息不被持有
  expect(after.undelivered).toContain(input.id)
  expect(ticketStage(after)).not.toEqual({ stage: 'person', action: 'blocked' }) // the stage leaves blocked
  h.store.close()
})

it('rejects an empty body, a foreign thread key and an unknown ticket', async () => {
  const h = host()
  const call = serve({ store: h.store, engine: h.engine, requestPass: () => {} })
  expect(await call('POST', 'console/threads', { text: '  ' })).toMatchObject({ status: 400 })
  expect(await call('POST', `console/threads/${encodeURIComponent('feishu:oc_1')}/messages`, { text: '写一篇小红书帖子', id: 'm2' }))
    .toMatchObject({ status: 400, body: { error: 'Not a console thread' } })
  expect(await call('POST', 'tickets/t404/message', { text: '发布', id: 'g2' })).toMatchObject({ status: 404 })
  h.store.close()
})
