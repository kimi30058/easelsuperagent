import { expect, it, vi } from 'vitest'
import { Engine, key, threadKey, type Trigger } from '../src/core/index.ts'
import { consoleKind, consoleTrigger, OPERATOR } from '../src/sources/console.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A host as docs/008-cookbook section 11 builds it: a real Store in a tmpdir, a registry holding the console kind, and an Engine on stand-in ports. */
function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'console-')), 'db.sqlite'))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(consoleKind)
  // The policy block as the panel saves it: the console part carries no configuration, and the kind bakes the operator in.
  store.saveSettings(SettingsSchema.parse({ policy: { sources: sources.validatePolicy({ console: {} }) } }))
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  // The console Source's replies are the Outbox receipts the page polls, so the outbox here only records them.
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...deps, store, engine, commands, receive, health: board.all, ctx: sourceContextOf(deps, consoleKind) }
}

it('builds an explicit human Trigger with a stable id and a console thread', () => {
  const trigger = consoleTrigger({ id: 'm1', thread: 't3f9a1c2', text: '写一篇小红书帖子', at: '2026-11-02T08:00:00Z' })
  expect(trigger).toMatchObject({ id: key('console', 'm1'), source: 'console', human: true, addressed: 'direct',
    actor: { source: 'console', id: OPERATOR }, text: '写一篇小红书帖子', at: '2026-11-02T08:00:00Z' })
  expect(trigger.threads).toEqual([{ source: 'console', id: 't3f9a1c2' }])
  expect(trigger.channel).toMatchObject({ source: 'console', thread: threadKey({ source: 'console', id: 't3f9a1c2' }) })
})

it('answers channel sends as delivered without side effects; receipts are the Outbox records', async () => {
  const sent = await consoleKind.channel!.send({} as never, { id: 'r1' } as never)
  expect(sent).toBe('sent')
})

it('admits the baked operator without configuration', () => {
  expect(consoleKind.policy!.schema.parse({})).toEqual({ allowed: [{ id: 'operator' }] })
})

it('takes an operator message in as an explicit candidate through the real engine', () => {
  const h = host()
  const trigger = consoleTrigger({ id: 'm1', thread: 't3f9a1c2', text: '写一篇小红书帖子', at: '2026-11-02T08:00:00Z' })
  expect(h.engine.receive(trigger)).toBe('stored')
  h.engine.evaluateDue()
  expect(h.engine.candidate(trigger.id)?.strength).toBe('explicit')
  h.store.close()
})
