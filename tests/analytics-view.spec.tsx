// @vitest-environment jsdom
// The analytics page: platform cards with tiles and sparklines, the works table, and the fetch entry points.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { ConsoleApp } from '../src/console/shell.tsx'
import { all, click, settle } from './fixtures/panel.tsx'
import { usePanelServer } from './fixtures/panel-server.ts'

let root: Root | undefined
let container: HTMLElement | undefined
const unmount = () => { act(() => { root?.unmount() }); root = undefined; container?.remove() }
usePanelServer(unmount)

let api: Record<string, (method: string, body?: unknown) => Response> = {}
let posted: { path: string }[] = []
beforeEach(() => {
  api = {}; posted = []
  const inner = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url), 'http://127.0.0.1:3083').pathname
    if (path.startsWith('/api/')) {
      if ((init?.method ?? 'GET') !== 'GET') posted.push({ path })
      return api[path]?.(init?.method ?? 'GET') ?? new Response('{"error":"missing"}', { status: 404 })
    }
    return inner(url, init)
  }))
  localStorage.clear(); location.hash = ''
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true })
})
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

const SEVEN = ['xiaohongshu', 'bilibili', 'douyin', 'wechat-oa', 'kuaishou', 'weixin-channels', 'zhihu']
/** 七平台聚合应答：默认全未登录、无数据、静默；over 键直接覆盖平台视图（latest 整个传入）。 */
const aggregate = (over: Record<string, Partial<{ login: boolean; state: string; latest: { followers?: number; likes?: number; metrics?: unknown } | undefined; spark: { ts: number; followers: number }[] }>> = {}) =>
  ({ platforms: SEVEN.map(platform => ({ platform, login: false, state: 'idle', latest: undefined, spark: [], ...over[platform] })),
    works: [], progress: { done: 0, total: 0 } })

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

it('renders seven cards; logged-out ones say so and link to accounts', async () => {
  api['/api/analytics'] = () => reply(aggregate())
  await mountConsole(); await goto('#/analytics')
  expect(all('.console-card')).toHaveLength(7)
  expect(find('xiaohongshu').textContent).toContain('未登录')
  expect(find('xiaohongshu').querySelector('a[href="#/accounts"]')).toBeTruthy()
})

it('shows tiles, a computed week delta and a sparkline from the history', async () => {
  api['/api/analytics'] = () => reply(aggregate({
    xiaohongshu: { login: true, latest: { followers: 1234, likes: 12300 },
      spark: [{ ts: 1, followers: 1200 }, { ts: 2, followers: 1222 }, { ts: 3, followers: 1234 }] },
  }))
  await mountConsole(); await goto('#/analytics')
  const card = find('xiaohongshu')
  expect(card.textContent).toContain('1,234')
  expect(card.textContent).toContain('本周')
  expect(card.querySelector('.console-analytics-spark polyline')!.getAttribute('points')!.split(' ')).toHaveLength(3)
})

it('expands the card to the 7-day metrics list', async () => {
  api['/api/analytics'] = () => reply({ platforms: SEVEN.map(platform => ({ platform, login: platform === 'douyin', state: 'idle',
    latest: platform === 'douyin' ? { followers: 9, metrics: [{ label: '播放量', value: '3.2k', vs: '+5%' }] } : undefined,
    spark: [] })), works: [], progress: { done: 0, total: 0 } })
  await mountConsole(); await goto('#/analytics')
  await click(find('douyin').querySelector('.console-analytics-expand')!)
  expect(find('douyin').textContent).toContain('播放量')
})

it('renders the works table with matched stats and a bare dash otherwise', async () => {
  api['/api/analytics'] = () => reply({ platforms: SEVEN.map(platform => ({ platform, login: true, state: 'idle', latest: undefined, spark: [] })),
    works: [
      { title: '秋天的第一杯奶茶', platform: 'xiaohongshu', date: '2026-11-01', stat: '赞 23 评 4', url: 'https://x/x1' },
      { title: '没对上的新作', platform: 'bilibili', date: '2026-10-28', stat: '' },
    ], progress: { done: 0, total: 0 } })
  await mountConsole(); await goto('#/analytics')
  const rows = all('.console-analytics-works tbody tr')
  expect(rows).toHaveLength(2)
  const link = rows[0]!.querySelector('a[href="https://x/x1"]')!
  expect(link.textContent).toContain('秋天的第一杯奶茶')
  expect(link.getAttribute('aria-label')).toContain('新窗口打开')   // 外链向读屏念出新窗口语义
  expect(link.querySelector('svg')).toBeTruthy()                    // 外链 icon（aria-hidden，视觉提示不重复念）
  expect(rows[1]!.textContent).toContain('—')
})

it('posts the fetch-all button and a per-card fetch', async () => {
  api['/api/analytics'] = () => reply(aggregate({ douyin: { login: true } }))
  api['/api/analytics/fetch'] = () => reply({ ok: true, queued: 1 })
  api['/api/analytics/douyin/fetch'] = () => reply({ ok: true, queued: 1 })
  await mountConsole(); await goto('#/analytics')
  await click(document.querySelector('.console-analytics-fetchall')!)
  await click(find('douyin').querySelector('button.console-analytics-fetch')!)
  expect(posted).toContainEqual({ path: '/api/analytics/fetch' })
  expect(posted).toContainEqual({ path: '/api/analytics/douyin/fetch' })
})

it('polls while anything fetches or queues, and stops when quiet', async () => {
  let calls = 0
  api['/api/analytics'] = () => { calls++; return reply(aggregate()) }
  await mountConsole(); await goto('#/analytics')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1300)) })
  expect(calls).toBe(1)                                                              // 全静默不轮询
  let live = 0
  api['/api/analytics'] = () => { live++; return reply(aggregate({ douyin: { login: true, state: 'fetching' } })) }
  await goto('#/overview'); await goto('#/analytics')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1300)) })
  expect(live).toBeGreaterThan(1)                                                    // 进行中 1s 轮询
})

it('skips a tick while the previous poll is still in flight (in-flight 守卫)', async () => {
  let calls = 0
  api['/api/analytics'] = () => { calls++; return reply(aggregate({ douyin: { login: true, state: 'fetching' } })) }
  await mountConsole(); await goto('#/analytics')
  calls = 0                                                                          // 首载已回、轮询已开；之后的响应换成永不关闭的流
  api['/api/analytics'] = () => { calls++; return new Response(new ReadableStream({ start: () => undefined })) }
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2300)) })
  expect(calls).toBe(1)                                                              // 1s 拍发出后一直挂着，2s 拍被守卫跳过——慢响应不叠并发
})

it('shows the load error with a retry instead of loading forever', async () => {
  api['/api/analytics'] = () => reply({ error: '数据服务内部错误' }, 500)
  await mountConsole(); await goto('#/analytics')
  expect(document.querySelector('.dt-error')!.textContent).toContain('数据加载失败')
  api['/api/analytics'] = () => reply(aggregate())
  await click(document.querySelector('.dt-error button')!)
  expect(all('.console-card')).toHaveLength(7)
})
