// @vitest-environment jsdom
// The console content pages: the calendar's Easel records, and the personas and skills of the workspace.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { ConsoleApp } from '../src/console/shell.tsx'
import { all, settle } from './fixtures/panel.tsx'
import { usePanelServer } from './fixtures/panel-server.ts'

let root: Root | undefined
let container: HTMLElement | undefined
const unmount = () => { act(() => { root?.unmount() }); root = undefined; container?.remove() }
usePanelServer(unmount)

/** The console content endpoints this test answers itself, instead of the fake server's stand-in data. */
let served: Record<string, () => Response> = {}
beforeEach(() => {
  served = {}
  const inner = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit): Promise<Response> =>
    served[new URL(String(url), 'http://127.0.0.1:3082').pathname.replace('/orchestrator/api/', '')]?.()
      ?? inner(url, init)))
})
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value),
  { status, headers: { 'content-type': 'application/json' } })

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

it('renders the calendar records grouped by date, latest first, every field as written', async () => {
  served.calendar = () => reply({ entries: [
    { date: '2026-11-02', topic: '选题二', platforms: ['xhs', 'dy'] },
    { date: '2026-11-04', topic: '选题四' },
    { date: '2026-11-02', topic: '另一条', note: { week: 2 } },
  ] })
  await mountConsole()
  await goto('#/calendar')
  expect(all('.dt-section-name').map(name => name.textContent)).toEqual(['2026-11-04', '2026-11-02'])
  expect(all('.dt-count').map(count => count.textContent)).toEqual(['1', '2'])
  expect(all('.dt-kv dt').map(term => term.textContent))
    .toEqual(['date', 'topic', 'date', 'topic', 'platforms', 'date', 'topic', 'note'])
  expect(all('.dt-kv').map(card => [...card.querySelectorAll('dd')].map(value => value.textContent))).toEqual([
    ['2026-11-04', '选题四'],
    ['2026-11-02', '选题二', '["xhs","dy"]'],
    ['2026-11-02', '另一条', '{"week":2}'],
  ])
})

it('lists the personas and the skills of the workspace', async () => {
  served.personas = () => reply({ items: [{ name: '小红书主号' }, { name: '公众号小助手' }] })
  served.skills = () => reply({ items: [
    { name: 'copywriting', description: '营销文案写作' },
    { name: 'seo', description: '搜索引擎优化' },
  ] })
  await mountConsole()
  await goto('#/personas')
  expect(all('.dt-row-title').map(title => title.textContent)).toEqual(['小红书主号', '公众号小助手'])
  await goto('#/skills')
  expect(all('.dt-row-title').map(title => title.textContent)).toEqual(['copywriting', 'seo'])
  expect(all('.dt-row-meta').map(meta => meta.textContent)).toEqual(['营销文案写作', '搜索引擎优化'])
})

it('shows the empty calendar state while the workspace has none recorded', async () => {
  served.calendar = () => reply({ error: 'No calendar recorded yet' }, 404)
  await mountConsole()
  await goto('#/calendar')
  expect(document.querySelector('p.dt-hint')?.textContent).toBe(zh['console.emptyCalendar'])
  expect(all('.dt-kv')).toEqual([])
})
