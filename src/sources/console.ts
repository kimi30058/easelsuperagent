/** Console Source: the operator's page as a push Source — endpoints translate page input into Triggers; replies are the Outbox receipts the page polls. */
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export const OPERATOR = 'operator'
const ConfigSchema = z.object({}).strict()
export type ConsoleConfig = z.infer<typeof ConfigSchema>

/** The Trigger of one console message; the operator typed it, so it is human and directly addressed. */
export function consoleTrigger(message: { id: string; thread: string; text: string; at: string }): Trigger {
  const thread = { source: 'console', id: message.thread }
  return { id: key('console', message.id), source: 'console', threads: [thread],
    actor: { source: 'console', id: OPERATOR }, human: true, addressed: 'direct', at: message.at, text: message.text,
    channel: { source: 'console', thread: threadKey(thread), address: { thread: message.thread } }, meta: {} }
}

export const consoleKind: SourceKind<ConsoleConfig> = {
  kind: 'console',
  title: { zh: '控制台', en: 'Console' },
  description: { zh: '运营者在控制台页面上发起与回复。', en: 'The operator originates and replies on the console page.' },
  schema: ConfigSchema, fields: [], health: [],
  channel: { send: async (_host: Pick<SourceContext, 'commands'>, _message: OutboundMessage) => 'sent',
    link: () => ({ url: '', label: { zh: '控制台', en: 'Console' } }) },
  policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1) }).strict())
      .default([{ id: OPERATOR }]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } }] }],
    explicit: { zh: '运营者在控制台输入并发送。', en: 'The operator types and sends in the console.' } },
}
