// @vitest-environment jsdom
// The accounts page: cards over /api/*, the login modal's state machine, and its forms.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { ConsoleApp } from '../src/console/shell.tsx'
import { all, click, settle, type } from './fixtures/panel.tsx'
import { usePanelServer } from './fixtures/panel-server.ts'

let root: Root | undefined
let container: HTMLElement | undefined
const unmount = () => { act(() => { root?.unmount() }); root = undefined; container?.remove() }
usePanelServer(unmount)

/** /api/* responses this test serves (keyed by path, answered per method and body); everything else falls to the panel server. */
let api: Record<string, (method: string, body?: unknown) => Response> = {}
let posted: { path: string; method: string; body?: unknown }[] = []
beforeEach(() => {
  api = {}; posted = []
  const inner = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url), 'http://127.0.0.1:3083').pathname
    if (path.startsWith('/api/')) {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
      const method = init?.method ?? 'GET'
      if (method !== 'GET') posted.push({ path, method, body })
      return api[path]?.(method, body) ?? new Response('{"error":"missing"}', { status: 404 })
    }
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
/** Real-clock sleep for the modal's one-second status poll, which no act flush advances. */
const tick = async (ms = 1300): Promise<void> => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
  await settle()
}

/** All four cards plus whoami answers for each, so the page's background verification settles. */
function serveCards(cards: { platform: string; name: string; backend: string; loggedIn: boolean }[],
  whoami: Record<string, { loggedIn: boolean; name: string; avatar: string }> = {}) {
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

/** One card's button by its visible text, scoped to a platform's card. */
const cardButton = (platform: string, label: string): HTMLButtonElement =>
  all(`.console-card[data-platform='${platform}'] button`).find(button => button.textContent === label) as HTMLButtonElement

it('runs the login modal through the state machine to success', async () => {
  serveCards(FOUR_CARDS.map(card => card.platform === 'xiaohongshu' ? card : { ...card, loggedIn: false }))
  let phase = 'qr'
  api['/api/login/xiaohongshu'] = () => reply({ state: 'starting', message: '' })
  api['/api/login/xiaohongshu/status'] = () => reply(phase === 'qr'
    ? { state: 'qr_ready', message: '', qrTs: 123 } : { state: 'success', message: '' })
  await mountConsole()
  await goto('#/accounts')
  await click(cardButton('xiaohongshu', zh['console.login']))
  await tick()                                        // 首态 starting，二维码由 1s 轮询带来
  const image = container!.querySelector('.console-qr img') as HTMLImageElement
  expect(image.getAttribute('src')).toBe('/api/login/xiaohongshu/qr?ts=123')
  phase = 'success'
  await tick()
  expect(container!.textContent).toContain(zh['console.loginSuccess'])
}, 9000)

it('submits an sms code through the douyin wall and validates its shape', async () => {
  serveCards(FOUR_CARDS.map(card => ({ ...card, loggedIn: false })))
  api['/api/login/douyin'] = () => reply({ state: 'starting', message: '' })
  api['/api/login/douyin/status'] = () => reply({ state: 'sms_required', message: '' })
  api['/api/login/douyin/sms'] = () => reply({ ok: true })
  await mountConsole()
  await goto('#/accounts')
  await click(cardButton('douyin', zh['console.login']))
  await tick()                                        // 首态 starting，短信墙由 1s 轮询带来
  expect(container!.textContent).toContain(zh['console.smsRequired'])
  const input = container!.querySelector('.console-modal input') as HTMLInputElement
  await type(input, '12')
  await click(container!.querySelector('.console-modal button[type=submit]') as HTMLButtonElement)
  expect(container!.textContent).toContain(zh['console.smsInvalid'])        // inline 校验挡下，不发请求
  expect(posted.filter(call => call.path === '/api/login/douyin/sms')).toEqual([])
  await type(input, '654321')
  await click(container!.querySelector('.console-modal button[type=submit]') as HTMLButtonElement)
  expect(posted.filter(call => call.path === '/api/login/douyin/sms').map(call => call.body))
    .toEqual([{ code: '654321' }])
}, 9000)

it('asks before logout and calls the endpoint once confirmed', async () => {
  serveCards(FOUR_CARDS.map(card => card.platform === 'bilibili' ? { ...card, loggedIn: true } : { ...card, loggedIn: false }),
    { bilibili: { loggedIn: true, name: 'B站昵称', avatar: '' } })
  api['/api/logout/bilibili'] = () => reply({ ok: true })
  await mountConsole()
  await goto('#/accounts')
  await act(async () => { cardButton('bilibili', zh['console.logout']).click() })
  await settle()
  expect(posted.filter(call => call.path === '/api/logout/bilibili')).toEqual([])   // 先确认
  expect(container!.textContent).toContain(zh['console.logoutConfirm'])
  await act(async () => {
    (all('.console-modal button').find(button => button.textContent === zh['confirm']) as HTMLButtonElement).click()
  })
  await settle()
  expect(posted.filter(call => call.path === '/api/logout/bilibili').length).toBe(1)
})

it('shows and saves the wechat-oa credentials through the form', async () => {
  serveCards(FOUR_CARDS.map(card => ({ ...card, loggedIn: false })))
  let credentials = { configured: false, appIdMasked: '', name: '', author: '' }
  api['/api/accounts/wechat-oa/credentials'] = method => method === 'GET'
    ? reply(credentials)
    : reply((credentials = { configured: true, appIdMasked: 'wx1234***90ab', name: '', author: '' }) && { ok: true, message: '公众号凭证已保存并验证通过' })
  await mountConsole()
  await goto('#/accounts')
  expect(container!.textContent).toContain(zh['console.credentials'])
  expect(container!.textContent).not.toContain('wx1234***90ab')           // 未配置时不显示
  // note 行是名词（配置后带脱敏 AppID），按钮是动作词：「凭证（发布）」不得在按钮上再出现一遍
  expect(all(`.console-card[data-platform='wechat-oa'] button`).some(button => button.textContent === zh['console.credentials'])).toBe(false)
  await act(async () => { cardButton('wechat-oa', zh['console.credentialsConfigure']).click() })
  await settle()
  const appId = container!.querySelector('.console-form input#credential-appid') as HTMLInputElement
  const secret = container!.querySelector('.console-form input#credential-secret') as HTMLInputElement
  await type(appId, 'wx1234567890ab')
  await type(secret, 'sec')
  await act(async () => { cardButton('wechat-oa', zh['console.saveCredentials']).click() })
  await settle()
  expect(posted.filter(call => call.path === '/api/accounts/wechat-oa/credentials').map(call => call.body))
    .toEqual([{ appId: 'wx1234567890ab', appSecret: 'sec', name: '', author: '' }])
  expect(container!.textContent).toContain('公众号凭证已保存并验证通过')
  expect(container!.textContent).toContain('wx1234***90ab')                // 保存后回显脱敏 AppID
})

it('closes itself after success without cancelling the finished login', async () => {
  serveCards(FOUR_CARDS.map(card => ({ ...card, loggedIn: false })))
  let phase = 'qr'
  api['/api/login/bilibili'] = () => reply({ state: 'starting', message: '' })
  api['/api/login/bilibili/status'] = () => reply(phase === 'qr'
    ? { state: 'qr_ready', message: '', qrTs: 9 } : { state: 'success', message: '' })
  await mountConsole()
  await goto('#/accounts')
  await click(cardButton('bilibili', zh['console.login']))
  await tick()
  phase = 'success'
  await tick()                                        // success 到达（约 1s 轮询）
  await tick(1500)                                    // 900ms 自动关闭定时器走完
  expect(container!.querySelector('.console-modal')).toBeNull()
  expect(posted.filter(call => call.path === '/api/login/bilibili').map(call => call.method)).toEqual(['POST'])   // 只有开启的 POST，绝无取消
}, 12000)

it('offers verify to force a fresh whoami check past the cache', async () => {
  serveCards(FOUR_CARDS, { xiaohongshu: { loggedIn: true, name: '旧名字', avatar: '' } })
  let checks = 0
  api['/api/accounts/xiaohongshu/whoami'] = () => {
    checks++
    return reply(checks === 1 ? { loggedIn: true, name: '旧名字', avatar: '' }
      : { loggedIn: true, name: '新名字', avatar: '' })
  }
  await mountConsole()
  await goto('#/accounts')
  expect(container!.textContent).toContain('旧名字')
  await click(cardButton('xiaohongshu', zh['console.verify']))
  await settle()
  expect(container!.textContent).toContain('新名字')
  expect(container!.textContent).not.toContain(zh['console.accountWhoamiFailed'])   // 成功不说失败的话
})

it('tells the operator an explicit verify could not confirm, leaving the state untouched', async () => {
  serveCards(FOUR_CARDS, { xiaohongshu: { loggedIn: true, name: '旧名字', avatar: '' } })
  let force = false
  api['/api/accounts/xiaohongshu/whoami'] = () => force
    ? new Response('{"error":"未能确认当前账号身份，请稍后重试校验"}', { status: 502, headers: { 'content-type': 'application/json' } })
    : reply({ loggedIn: true, name: '旧名字', avatar: '' })
  await mountConsole()
  await goto('#/accounts')
  force = true
  await click(cardButton('xiaohongshu', zh['console.verify']))
  await settle()
  expect(container!.textContent).toContain(zh['console.accountWhoamiFailed'])
  expect(container!.textContent).toContain('未能确认当前账号身份')      // 服务端的具体原因拼在词条后
  expect(container!.textContent).toContain('旧名字')                   // spec §7：状态保持不变，不误报
  force = false                                                       // 下一次验证成功：失败话术即撤
  await click(cardButton('xiaohongshu', zh['console.verify']))
  await settle()
  expect(container!.textContent).not.toContain(zh['console.accountWhoamiFailed'])
})

it('closes on Escape during an active login, cancelling it', async () => {
  serveCards(FOUR_CARDS.map(card => ({ ...card, loggedIn: false })))
  api['/api/login/douyin'] = () => reply({ state: 'starting', message: '' })
  api['/api/login/douyin/status'] = () => reply({ state: 'starting', message: '' })
  await mountConsole()
  await goto('#/accounts')
  await click(cardButton('douyin', zh['console.login']))
  await settle()
  expect(container!.querySelector('.console-modal')).not.toBeNull()
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  await settle()
  expect(container!.querySelector('.console-modal')).toBeNull()
  expect(posted.filter(call => call.path === '/api/login/douyin').map(call => call.method)).toEqual(['POST', 'DELETE'])
})
