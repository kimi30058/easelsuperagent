// @vitest-environment jsdom
// The console shell: sidebar navigation, hash routing over the shared views, and the offline bar.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { ConsoleApp } from '../src/console/shell.tsx'
import { all, click, find, settle, text } from './fixtures/panel.tsx'
import { server, usePanelServer } from './fixtures/panel-server.ts'

let root: Root | undefined
let container: HTMLElement | undefined
const unmount = () => { act(() => { root?.unmount() }); root = undefined; container?.remove() }
usePanelServer(unmount)

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
const navLinks = () => all('.console-nav a').map(link => [link.textContent, link.getAttribute('href')] as const)

it('renders the console sidebar over the shared overview', async () => {
  await mountConsole()
  expect(document.querySelector('.console-nav h1')?.textContent).toBe(zh['console.title'])
  expect(document.querySelector('.console-brand')?.textContent).toBe('easelsuperagent')
  expect(navLinks()).toEqual([['概览', '#/overview'], ['消息', '#/messages'], ['执行', '#/execution'], ['发布', '#/publish'], ['数据', '#/analytics'],
    ['日历', '#/calendar'], ['画像', '#/personas'], ['技能', '#/skills'], ['账号', '#/accounts'], ['触发', '#/trigger'], ['评估', '#/eval'], ['设置', '#/settings']])
  expect(all('.console-nav a').find(link => link.textContent === zh['tab.overview'])?.getAttribute('aria-current')).toBe('page')
  expect(document.querySelector('main[role="tabpanel"]')?.getAttribute('aria-label')).toBe(zh['tab.overview'])
  expect(text()).toContain(zh.pendingTickets)
})

it('switches pages by hash, marking the active page and carrying record ids', async () => {
  await mountConsole()
  await goto('#/execution')
  expect(text()).toContain(zh.executorRunning)
  expect(all('.console-nav a').find(link => link.textContent === zh['tab.execution'])?.getAttribute('aria-current')).toBe('page')
  await goto('#/execution/t1')
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
  await goto('#/calendar')
  expect(text()).toContain(zh['console.emptyCalendar'])
  // A hash naming no page falls back to the overview, not a blank console.
  await goto('#/nonsense')
  expect(all('.console-nav a').find(link => link.textContent === zh['tab.overview'])?.getAttribute('aria-current')).toBe('page')
  expect(text()).toContain(zh.pendingTickets)
  // A navigation link opens settings at its default group; choosing a group rewrites the hash in place.
  await click(zh['tab.settings'])
  await vi.waitFor(() => expect(location.hash).toBe('#/settings'))
  expect(document.querySelector('.dt-settings-title')?.textContent).toBe(zh['settingsGroup.source'])
  await click(find(zh['settingsGroup.eval'], '.dt-settings-link'))
  expect(location.hash).toBe('#/settings?group=eval')
  expect(document.querySelector('.dt-settings-title')?.textContent).toBe(zh['settingsGroup.eval'])
})

it('moves the hash when a shared view navigates within the console', async () => {
  await mountConsole()
  await click('修复回归')
  await vi.waitFor(() => expect(location.hash).toBe('#/execution/t1'))
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
})

it('shows the offline bar while the orchestrator does not answer', async () => {
  server.down = true
  await mountConsole()
  await vi.waitFor(() => expect(document.querySelector('p.console-offline[role="status"]')?.textContent)
    .toBe(zh['console.offlineBar']))
})

it('speaks English when the browser asks for it', async () => {
  speak('en-US')
  await mountConsole()
  expect(document.querySelector('.console-nav h1')?.textContent).toBe(en['console.title'])
  expect(navLinks().map(([label]) => label)).toEqual([en['tab.overview'], en['nav.messages'], en['tab.execution'], en['nav.publish'], en['nav.analytics'],
    en['nav.calendar'], en['nav.personas'], en['nav.skills'], en['nav.accounts'], en['tab.trigger'], en['tab.eval'], en['tab.settings']])
})
