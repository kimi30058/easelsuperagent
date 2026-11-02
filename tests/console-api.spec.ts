import { expect, it, vi } from 'vitest'
import { Engine, key, ticketStage, type Outcome } from '../src/core/index.ts'
import { consoleKind } from '../src/sources/console.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { registerHttp } from '../src/app/http.ts'
import type { HttpHost } from '../src/app/http.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { calendarView, deliverablesView, personasView, skillsView } from '../src/app/views/console.ts'
import { mkdtempSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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

/** Send a console request and decide its held candidate as the main Session would, returning the accepted ticket's id. */
async function ticketFromRequest(h: ReturnType<typeof host>, call: ReturnType<typeof serve>, text: string) {
  const { body } = await call('POST', 'console/threads', { text })
  const triggerId = body.trigger as string
  const accept: Outcome = { kind: 'accept', title: text, scope: 'small', reason: 'requested',
    acknowledgement: 'ok', evalId: h.engine.candidate(triggerId)?.evalId }
  return h.engine.decide(triggerId, accept).ticketId!
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
  const ticketId = await ticketFromRequest(h, call, '写一篇小红书帖子')
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

it('answers a retried gate message as a duplicate without attaching it again', async () => {
  const h = host()
  const call = serve({ store: h.store, engine: h.engine, requestPass: () => {} })
  const ticketId = await ticketFromRequest(h, call, '写一篇小红书帖子')
  const sent = await call('POST', `tickets/${ticketId}/message`, { text: '发布', id: 'g3' })
  expect(sent).toMatchObject({ status: 200, body: { received: 'stored', attached: true } })
  const before = h.store.tickets.get(ticketId)!.inputs
  const retried = await call('POST', `tickets/${ticketId}/message`, { text: '发布', id: 'g3' })
  expect(retried).toMatchObject({ status: 200, body: { received: 'duplicate', attached: false } })
  expect(h.store.tickets.get(ticketId)!.inputs).toEqual(before) // the ticket's inputs did not grow
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

it('reads the calendar and personas from an execution root, and 404s when absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'console-'))
  await mkdir(join(root, 'outputs'), { recursive: true })
  await writeFile(join(root, 'outputs', '_schedule.json'), JSON.stringify({ entries: [{ date: '2026-11-03', topic: '选题一' }] }))
  await mkdir(join(root, 'profiles', '小红书主号'), { recursive: true })
  expect(calendarView(root)).toEqual({ entries: [{ date: '2026-11-03', topic: '选题一' }] })
  expect(personasView(root)).toEqual({ items: [{ name: '小红书主号' }] })
  expect(calendarView(join(root, 'nowhere'))).toBeUndefined()
  expect(personasView(join(root, 'nowhere'))).toEqual({ items: [] })
})

it('lists the builtin skills from their SKILL.md frontmatter, skipping directories it cannot read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'console-skills-'))
  const skill = async (name: string, header: string) => {
    await mkdir(join(root, 'builtin', name), { recursive: true })
    await writeFile(join(root, 'builtin', name, 'SKILL.md'), header)
  }
  // 内置技能库的真实头形式：description 可为带引号的单行，也可为 YAML 折叠块，且 description 与 --- 之间还有 layer 行
  await skill('copywriting', '---\nname: copywriting\ndescription: "营销文案写作"\nlayer: produce\n---\n\n# 营销文案写作\n')
  await skill('asset-manager', '---\nname: asset-manager\ndescription: >\n  产物管理：按日期归档。\n  当用户说"整理素材"时使用。\nlayer: general\n---\n\n# 素材管理器\n')
  await mkdir(join(root, 'builtin', 'no-skill-md'), { recursive: true })
  await writeFile(join(root, 'builtin', 'README.md'), 'not a skill directory')
  expect(skillsView(root)).toEqual({ items: [
    { name: 'asset-manager', description: '产物管理：按日期归档。 当用户说"整理素材"时使用。' },
    { name: 'copywriting', description: '营销文案写作' },
  ] })
  expect(skillsView(join(root, 'nowhere'))).toEqual({ items: [] })
})

it('merges the deliverables of a ticket\'s assignments and checks each against its workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'console-deliverables-'))
  await mkdir(join(workspace, 'outputs'), { recursive: true })
  await writeFile(join(workspace, 'outputs', 'draft.md'), '正文')
  const ticket = { assignments: [
    { report: { state: 'ready' as const, summary: '', at: '', deliverables: ['outputs/draft.md', 'outputs/missing.md'],
      platforms: ['xhs', 'douyin'] } },
    { report: { state: 'ready' as const, summary: '', at: '', deliverables: ['outputs/draft.md'], platforms: ['wechat'] } },
    { report: { state: 'progress' as const, summary: '', at: '' } },
  ] }
  expect(deliverablesView(ticket, workspace)).toEqual({ items: [
    { path: 'outputs/draft.md', exists: true, platforms: ['xhs', 'douyin', 'wechat'] },
    { path: 'outputs/missing.md', exists: false, platforms: ['xhs', 'douyin'] },
  ] })
  // 工单还没有执行目录时，交付物一律无法确认存在
  expect(deliverablesView(ticket, undefined).items[0]).toEqual({ path: 'outputs/draft.md', exists: false,
    platforms: ['xhs', 'douyin', 'wechat'] })
  expect(deliverablesView({ assignments: [] }, workspace)).toEqual({ items: [] })
})

it('serves the console calendar, personas and skills views over the execution root', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'console-state-'))
  const root = join(stateDir, 'work') // 设置为空 executor.directory 时，执行根是 <stateDir>/work
  await mkdir(join(root, 'outputs'), { recursive: true })
  await writeFile(join(root, 'outputs', '_schedule.json'), JSON.stringify({ entries: [{ date: '2026-11-03', topic: '选题一' }] }))
  await mkdir(join(root, 'profiles', '小红书主号'), { recursive: true })
  const call = serve({ store: { settings: () => SettingsSchema.parse({}) }, machine: { stateDir } })
  expect(await call('GET', 'calendar')).toMatchObject({ status: 200, body: { entries: [{ date: '2026-11-03', topic: '选题一' }] } })
  expect(await call('GET', 'personas')).toMatchObject({ status: 200, body: { items: [{ name: '小红书主号' }] } })
  const skills = await call('GET', 'skills')
  expect(skills.status).toBe(200)
  expect(skills.body.items).toContainEqual({ name: 'copywriting', description: expect.any(String) })
  for (const item of skills.body.items as { name: string; description: string }[]) {
    expect(typeof item.name).toBe('string') // 真实技能库整体可读，而不是被成批跳过
    expect(item.description.length).toBeGreaterThan(0)
  }
  // 没有日历记录时是 404，画像目录缺失则是空列表
  const bare = serve({ store: { settings: () => SettingsSchema.parse({}) }, machine: { stateDir: await mkdtemp(join(tmpdir(), 'console-bare-')) } })
  expect(await bare('GET', 'calendar')).toEqual({ status: 404, body: { error: 'No calendar recorded yet' } })
  expect(await bare('GET', 'personas')).toEqual({ status: 200, body: { items: [] } })
})

it('serves a ticket\'s deliverables, and 404s for an unknown ticket', async () => {
  const h = host()
  const workspace = await mkdtemp(join(tmpdir(), 'console-ticket-'))
  await mkdir(join(workspace, 'outputs'), { recursive: true })
  await writeFile(join(workspace, 'outputs', 'draft.md'), '正文')
  const call = serve({ store: h.store, engine: h.engine, requestPass: () => {} })
  const ticketId = await ticketFromRequest(h, call, '写一篇小红书帖子')
  const reported = h.engine.report(ticketId, { state: 'ready', summary: '写完了', deliverables: ['outputs/draft.md', 'outputs/missing.md'],
    platforms: ['xhs'] })
  // 执行器负责填 execution.directory；本测试的桩执行器没填，手工指向工作区
  h.store.tickets.save({ ...reported, execution: { name: ticketId, directory: workspace, assignment: '' } })
  expect(await call('GET', `tickets/${ticketId}/deliverables`)).toMatchObject({ status: 200, body: { items: [
    { path: 'outputs/draft.md', exists: true, platforms: ['xhs'] },
    { path: 'outputs/missing.md', exists: false, platforms: ['xhs'] },
  ] } })
  expect(await call('GET', 'tickets/t404/deliverables')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  h.store.close()
})
