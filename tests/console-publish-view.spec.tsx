// @vitest-environment jsdom
// The publish center: platform cards over /api/publish, the SMS wall, and the empty states.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { ConsoleApp } from '../src/console/shell.tsx'
import { all, click, settle, type } from './fixtures/panel.tsx'
import { usePanelServer } from './fixtures/panel-server.ts'

let root: Root | undefined
let container: HTMLElement | undefined
const unmount = () => { act(() => { root?.unmount() }); root = undefined; container?.remove() }
usePanelServer(unmount)

/** /api/*（sidecar 域）与 served（编排器端点名，路径剥掉 /orchestrator/api/）两套拦截并存。 */
let api: Record<string, (method: string, body?: unknown) => Response> = {}
let served: Record<string, () => Response> = {}
let posted: { path: string; body?: unknown }[] = []
beforeEach(() => {
  api = {}; served = {}; posted = []
  const inner = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url), 'http://127.0.0.1:3083').pathname
    if (path.startsWith('/api/')) {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
      if ((init?.method ?? 'GET') !== 'GET') posted.push({ path, body })
      return api[path]?.(init?.method ?? 'GET', body) ?? new Response('{"error":"missing"}', { status: 404 })
    }
    return served[path.replace('/orchestrator/api/', '')]?.() ?? inner(url, init)
  }))
  localStorage.clear(); location.hash = ''
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true })
})
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
/** The aggregate answer for one douyin state, the rest quiet. */
const aggregate = (douyin: { state: string; message?: string; logTail?: string }) => [
  { platform: 'xiaohongshu', state: 'unknown', message: '', logTail: '', logMtime: undefined },
  { platform: 'bilibili', state: 'unknown', message: '', logTail: '', logMtime: undefined },
  { platform: 'douyin', message: douyin.message ?? '', logTail: douyin.logTail ?? '', logMtime: undefined, ...douyin },
  { platform: 'wechat-oa', state: 'unknown', message: '', logTail: '', logMtime: undefined },
]

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
const find = (platform: string): HTMLElement =>
  document.querySelector(`.console-card[data-platform="${platform}"]`) as HTMLElement

it('renders four cards with the empty state linking the gate conversation when nothing ever published', async () => {
  api['/api/publish'] = () => reply(aggregate({ state: 'unknown' }))
  await mountConsole(); await goto('#/publish')
  expect(all('.console-card')).toHaveLength(4)
  expect(find('xiaohongshu').textContent).toContain('尚未发布')
  expect(find('xiaohongshu').querySelector('a[href="#/messages"]')).toBeTruthy()
})

it('shows the SMS form while douyin waits, validates inline, and posts the code', async () => {
  api['/api/publish'] = () => reply(aggregate({ state: 'sms_required' }))
  api['/api/publish/douyin/sms'] = () => reply({ ok: true })
  await mountConsole(); await goto('#/publish')
  const card = find('douyin')
  expect(card.textContent).toContain('需要短信验证')
  await type(card.querySelector('input')!, 'abc')
  await act(async () => {
    const input = card.querySelector('input')!
    input.focus(); input.blur()   // jsdom 对未聚焦元素的 blur() 不派发 focusout，React 的 onBlur 收不到
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  expect(card.textContent).toContain('验证码应为 4-8 位数字')       // onBlur 内联校验
  await type(card.querySelector('input')!, '123456')
  await click(card.querySelector('button[type=submit]')!)
  expect(posted).toContainEqual({ path: '/api/publish/douyin/sms', body: { code: '123456' } })
})

it('marks a fresh log as publishing with its tail', async () => {
  api['/api/publish'] = () => reply([
    { platform: 'xiaohongshu', state: 'unknown', message: '', logTail: '✅ 发布成功', logMtime: Date.now() - 60_000 },
    { platform: 'bilibili', state: 'unknown', message: '', logTail: '', logMtime: undefined },
    { platform: 'douyin', state: 'unknown', message: '', logTail: '', logMtime: undefined },
    { platform: 'wechat-oa', state: 'unknown', message: '', logTail: '', logMtime: undefined },
  ])
  await mountConsole(); await goto('#/publish')
  expect(find('xiaohongshu').textContent).toContain('发布进行中')
  expect(find('xiaohongshu').querySelector('.console-publish-log')!.textContent).toContain('✅ 发布成功')
})

it('shows the latest calendar record by its Chinese platform name (Review Focus 2)', async () => {
  api['/api/publish'] = () => reply(aggregate({ state: 'unknown' }))
  served.calendar = () => reply({ entries: [
    { platform: 'B站', title: 'B站视频', date: '2026-11-03', status: 'published' },
    { platform: '公众号', title: '公众号草稿', date: '2026-11-03', status: 'published' },
  ] })
  await mountConsole(); await goto('#/publish')
  expect(find('bilibili').textContent).toContain('B站视频')
  expect(find('wechat-oa').textContent).toContain('公众号草稿')   // 公众号 ≠ 微信公众号：映射表钉死
})

it('treats a missing calendar as no records instead of an error (Review Focus 3)', async () => {
  api['/api/publish'] = () => reply(aggregate({ state: 'unknown' }))
  served.calendar = () => reply({ error: 'No calendar recorded yet' }, 404)
  await mountConsole(); await goto('#/publish')
  expect(find('xiaohongshu').textContent).toContain('尚未发布')
})

it('warns inside the login modal while a publish runs', async () => {
  api['/api/publish'] = () => reply(aggregate({ state: 'verifying' }))
  api['/api/accounts'] = () => reply([
    { platform: 'douyin', name: '抖音', backend: 'douyin', note: '', loggedIn: false },
  ])
  await mountConsole(); await goto('#/accounts')
  await click(document.querySelector('.console-card[data-platform="douyin"] button')!)
  expect(document.querySelector('.console-modal')!.textContent).toContain('发布进行中，登录可能失败')
})
