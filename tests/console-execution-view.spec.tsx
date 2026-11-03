// @vitest-environment jsdom
// The execution page: the header band with pause control, executor stat tiles, card rows, and the empty state.
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

/** The orchestrator endpoints this test answers itself; everything else falls to the panel server's stand-in data. */
let served: Record<string, () => Response> = {}
beforeEach(() => {
  served = {}
  const inner = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit): Promise<Response> =>
    served[new URL(String(url), 'http://127.0.0.1:3082').pathname.replace('/orchestrator/api/', '')]?.()
      ?? inner(url, init)))
  location.hash = ''
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true })
})
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value),
  { status, headers: { 'content-type': 'application/json' } })

async function mountConsole() {
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(<ConsoleApp />) })
  await settle()
}
const goto = async (hash: string) => {
  await act(async () => { location.hash = hash; await new Promise(resolve => setTimeout(resolve, 0)) })
  await settle()
}

it('opens with the header band, the pause action, and the executor stat tiles', async () => {
  await mountConsole()
  await goto('#/execution')
  expect(document.querySelector('.dt-header-title')?.textContent).toBe(zh['tab.execution'])
  expect(document.querySelector('.dt-header-hint')?.textContent).toBe(zh['executionStatusIntro'])
  expect(all('.dt-stat-tile-label').map(tile => tile.textContent)).toEqual([zh['executingLabel'], zh['queuedLabel']])
  expect(all('.dt-list .dt-ticket .dt-open').map(title => title.textContent)).toContain('修复回归')
})

it('shows the empty state with its guidance action when the filter matches nothing', async () => {
  served.tickets = () => reply({ items: [], next_offset: null })
  await mountConsole()
  await goto('#/execution')
  expect(document.querySelector('.dt-empty-title')?.textContent).toBe(zh['console.emptyExecutionTitle'])
  const action = document.querySelector<HTMLButtonElement>('.dt-empty-action button')
  expect(action?.textContent).toBe(zh['console.emptyExecutionAction'])
  await act(async () => { action!.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
  await settle()
  expect(location.hash).toBe('#/messages')
})
