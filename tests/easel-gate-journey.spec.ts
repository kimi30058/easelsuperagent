/** Phase 0 acceptance: the publish-gate journey end to end against the in-memory host. */
import { afterEach, expect, it, vi } from 'vitest'
import { waitsForPerson } from '../src/core/index.ts'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'
import { SettingsSchema } from '../src/policy.ts'

vi.setConfig({ testTimeout: 30_000 })
let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const gate = '内容已就绪：秋日晨跑短文。产物：outputs/autumn-run/。回复『发布』执行发布，或直接给修改意见'

it('gates content behind approval, withholds automatic input, steers the operator reply and ends completed on ready', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 写一篇关于秋日晨跑的 300 字短文'))
  // The assignment reached the worker Session.
  expect(h.deliveries.mock.calls.some(([call]) => call.sessionId === sessionId)).toBe(true)
  // Content ready: the worker gates behind human approval, the question routed to the requesting message.
  await h.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: '初稿完成', human_action: gate,
    question_for_trigger_id: ticket.origin.triggerId })
  const gated = h.runtime.store.tickets.get(ticket.id)!
  expect(waitsForPerson(gated)).toBe(true)
  expect(gated.attention).toMatchObject({ question: expect.stringContaining('内容已就绪') })
  // While the ticket waits for a person, an automatic trigger on its thread is withheld: no delivery wakes the worker.
  h.runtime.store.saveSettings(SettingsSchema.parse({ ...h.runtime.store.settings(),
    eval: { ...h.runtime.store.settings().eval, mode: 'observe' },
    policy: { ...h.runtime.store.settings().policy, sources: { feishu: { ...h.runtime.store.settings().policy.sources.feishu!,
      bots: [{ id: 'cli_alerts', name: 'Alerts' }] } } } }))
  const deliveriesBefore = h.deliveries.mock.calls.filter(([call]) => call.sessionId === sessionId).length
  h.runtime.receive(feishu('2', '一条提醒卡消息', { sender_id: 'cli_alerts', sender_type: 'bot', mentions: [] }))
  await h.runtime.idle()
  expect(h.deliveries.mock.calls.filter(([call]) => call.sessionId === sessionId).length).toBe(deliveriesBefore)
  // The operator approves in the same conversation; the reply steers the worker.
  const approval = feishu('3', '确认', { root_id: 'om_1', parent_id: 'om_1', thread_id: 'omt_1' })
  h.runtime.receive(approval)
  await h.runtime.idle()
  const steered = h.deliveries.mock.calls.filter(([call]) => call.sessionId === sessionId && call.mode === 'steer').map(([call]) => call.text)
  expect(steered.some(text => text.includes(approval.id))).toBe(true)
  // The worker archives and reports ready with its deliverables; the ticket ends completed and the record relays.
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '已归档并记录日历', deliverables: ['outputs/autumn-run/'], platforms: [] })
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
  expect(h.relays(h.runtime.masterId).some(item => item.kind === 'worker_report' && item.state === 'ready')).toBe(true)
})

it('re-gates after a revision: feedback steers the worker, the second approval closes the gate', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 写一篇关于秋日晨跑的 300 字短文'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: '初稿完成', human_action: gate,
    question_for_trigger_id: ticket.origin.triggerId })
  // A revision reply is feedback: it steers the worker, whose revised content gates again.
  h.runtime.receive(feishu('4', '标题改短一点', { root_id: 'om_1', parent_id: 'om_1', thread_id: 'omt_1' }))
  await h.runtime.idle()
  const steered = h.deliveries.mock.calls.filter(([call]) => call.sessionId === sessionId && call.mode === 'steer').map(([call]) => call.text)
  console.log('ALLDELIV', JSON.stringify(h.deliveries.mock.calls.map(([c]) => [c.sessionId, c.mode, c.text.slice(0, 120)])))
  expect(steered.some(text => text.includes('标题改短'))).toBe(true)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: '已按意见修改', human_action: gate,
    question_for_trigger_id: ticket.origin.triggerId })
  expect(waitsForPerson(h.runtime.store.tickets.get(ticket.id)!)).toBe(true)
  // The second approval closes the gate and the ready report ends the ticket.
  h.runtime.receive(feishu('5', '发布', { root_id: 'om_1', parent_id: 'om_1', thread_id: 'omt_1' }))
  await h.runtime.idle()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '已归档并记录日历', deliverables: ['outputs/autumn-run/'], platforms: [] })
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ outcome: 'completed' })
})
