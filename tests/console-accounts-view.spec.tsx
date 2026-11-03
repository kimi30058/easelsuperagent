// @vitest-environment jsdom
// The accounts page: cards over /api/*, the login modal's state machine, and its forms.
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

/** /api/* responses this test serves; everything else falls through to the panel server. */
let api: Record<string, () => Response> = {}
beforeEach(() => {
  api = {}
  const inner = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url), 'http://127.0.0.1:3083').pathname
    if (path.startsWith('/api/')) return api[path]?.() ?? new Response('{"error":"missing"}', { status: 404 })
    return inner(url, init)
  }))
  localStorage.clear(); location.hash = ''
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
/** Move the hash and let jsdom's asynchronous hashchange arrive inside act. */
const goto = async (hash: string) => {
  await act(async () => { location.hash = hash; await new Promise(resolve => setTimeout(resolve, 0)) })
  await settle()
}

/** All four cards plus whoami answers for each, so the page's background verification settles. */
function serveCards(cards: { platform: string; name: string; backend: string; loggedIn: boolean }[],
  whoami: Record<string, { loggedIn: boolean; name: string; avatar: string }>) {
  api['/api/accounts'] = () => reply(cards)
  for (const platform of ['xiaohongshu', 'bilibili', 'douyin', 'wechat-oa'])
    api[`/api/accounts/${platform}/whoami`] = () => reply(whoami[platform] ?? { loggedIn: false, name: '', avatar: '' })
}

const FOUR_CARDS = [
  { platform: 'xiaohongshu', name: '小红书', backend: 'xhs', loggedIn: true },
  { platform: 'bilibili', name: 'B站', backend: 'biliup', loggedIn: false },
  { platform: 'douyin', name: '抖音', backend: 'douyin', loggedIn: false },
  { platform: 'wechat-oa', name: '微信公众号', backend: 'wechat-oa', loggedIn: false },
]

it('renders one card per platform with the fast-path state and whoami names', async () => {
  serveCards(FOUR_CARDS, { xiaohongshu: { loggedIn: true, name: '小红书昵称', avatar: '' } })
  await mountConsole()
  await goto('#/accounts')
  expect(all('.console-card-title span:first-child').map(title => title.textContent))
    .toEqual(['小红书', 'B站', '抖音', '微信公众号'])
  expect(all('.console-state').map(state => state.textContent)).toEqual([zh['console.loggedIn'], zh['console.loggedOut'],
    zh['console.loggedOut'], zh['console.loggedOut']])
  expect(container!.textContent).toContain('小红书昵称')
  // whoami 结果进 localStorage：下次开页秒显
  expect(localStorage.getItem('easel-superagent/accounts-whoami')).toContain('小红书昵称')
})

it('shows the offline-root state when every account call answers 503', async () => {   // Review Focus 5
  api['/api/accounts'] = () => reply({ error: '编排器不可达' }, 503)
  await mountConsole()
  await goto('#/accounts')
  expect(container!.textContent).toContain(zh['console.offlineRoot'])
})
