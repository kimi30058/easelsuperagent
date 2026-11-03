/** Tests for the publish domain's node side: the _publish file protocol and the /api/publish routes. */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { expect, it, describe, beforeEach, afterEach } from 'vitest'
import {
  aggregatePublish, isSmsPublishPlatform, publishPaths, readLogTail, readPublishState,
  touchResend, writePublishSmsCode, TERMINAL_PUBLISH_STATES,
} from '../src/console/publish-protocol.ts'
import { ExecutionRoot } from '../src/console/execution-root.ts'
import { PublishApi } from '../src/console/publish-api.ts'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sp3-protocol-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('publish file protocol', () => {
  it('reads douyin\'s status and falls back to unknown on a missing or torn file', async () => {
    const paths = publishPaths(root, 'douyin')
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.status, JSON.stringify({ state: 'sms_required', message: '等验证码', qr: '', ts: 123 }), 'utf8')
    expect(await readPublishState(paths)).toEqual({ state: 'sms_required', message: '等验证码', ts: 123 })
    await writeFile(paths.status, '{"state": "sms_re', 'utf8')  // 撕裂写
    expect((await readPublishState(paths)).state).toBe('unknown')
    expect((await readPublishState(publishPaths(root, 'xiaohongshu'))).state).toBe('unknown')
  })

  it('reads only the last 2KB of a publish log, never the whole file (Review Focus 5)', async () => {
    const paths = publishPaths(root, 'douyin')
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.log, `${'a'.repeat(3000)}tail-end`, 'utf8')
    const log = await readLogTail(paths)
    expect(log).toBeDefined()
    expect(log!.tail.length).toBe(2048)
    expect(log!.tail.endsWith('tail-end')).toBe(true)
    expect(log!.mtime).toBeGreaterThan(0)
    expect(await readLogTail(publishPaths(root, 'bilibili'))).toBeUndefined()
  })

  it('aggregates all four platforms, douyin live and the rest quiet', async () => {
    const paths = publishPaths(root, 'douyin')
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.status, JSON.stringify({ state: 'starting', message: '', qr: '', ts: 1 }), 'utf8')
    const views = await aggregatePublish(root)
    expect(views.map(view => view.platform)).toEqual(['xiaohongshu', 'bilibili', 'douyin', 'wechat-oa'])
    expect(views[2]).toMatchObject({ state: 'starting', logTail: '' })
    expect(views[0]).toMatchObject({ state: 'unknown', logTail: '', logMtime: undefined })
  })

  it('writes the one-shot code and the resend sidecar file', async () => {
    const paths = publishPaths(root, 'douyin')
    await writePublishSmsCode(paths, '123456')
    expect(await readFile(paths.code, 'utf8')).toBe('123456')
    await touchResend(paths)
    expect(await stat(paths.resend)).toBeTruthy()
  })

  it('only douyin\'s publish asks for an SMS code', () => {
    expect(isSmsPublishPlatform('douyin')).toBe(true)
    expect(isSmsPublishPlatform('xiaohongshu')).toBe(false)   // Review Focus 4 的协议侧一半
    expect(TERMINAL_PUBLISH_STATES).toEqual(['success', 'error'])
  })
})

describe('PublishApi routes', () => {
  let settings: Server; let upstream: string; let server: Server; let base: string
  let apiRoot: string

  beforeEach(async () => {
    apiRoot = await mkdtemp(join(tmpdir(), 'sp3-api-'))
    settings = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ environment: { root: apiRoot } }))
    })
    await new Promise<void>(resolve => settings.listen(0, '127.0.0.1', resolve))
    upstream = `http://127.0.0.1:${(settings.address() as { port: number }).port}`
    const publishes = new PublishApi({ root: new ExecutionRoot({ upstream }) })
    server = createServer((req, res) => {
      void publishes.handle(req, new URL(req.url ?? '/', 'http://127.0.0.1'), res)
        .then(claimed => { if (!claimed) { res.writeHead(404); res.end('{}') } })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => settings.close(() => resolve()))
    await rm(apiRoot, { recursive: true, force: true })
  })
  const post = async (path: string, body: unknown): Promise<{ status: number; json: { error?: string; ok?: boolean } }> => {
    const response = await fetch(`${base}${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, json: await response.json() as { error?: string; ok?: boolean } }
  }

  it('aggregates every platform over GET /api/publish', async () => {
    const response = await fetch(`${base}/api/publish`)
    expect(response.status).toBe(200)
    const json = await response.json() as { platform: string }[]
    expect(json.map(view => view.platform)).toEqual(['xiaohongshu', 'bilibili', 'douyin', 'wechat-oa'])
  })

  it('accepts a code only while douyin is publishing (Review Focus 1)', async () => {
    const paths = publishPaths(apiRoot, 'douyin')
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.status, JSON.stringify({ state: 'sms_required', message: '', qr: '', ts: 1 }), 'utf8')
    const ok = await post('/api/publish/douyin/sms', { code: '123456' })
    expect(ok.status).toBe(200)
    expect(await readFile(paths.code, 'utf8')).toBe('123456')
    await writeFile(paths.status, JSON.stringify({ state: 'success', message: '', qr: '', ts: 2 }), 'utf8')
    const stale = await post('/api/publish/douyin/sms', { code: '654321' })
    expect(stale.status).toBe(400)
  })

  it('refuses codes for platforms without a wall and malformed codes (Review Focus 4)', async () => {
    const wrongPlatform = await post('/api/publish/xiaohongshu/sms', { code: '123456' })
    expect(wrongPlatform.status).toBe(400)
    const malformed = await post('/api/publish/douyin/sms', { code: 'abc' })
    expect(malformed.status).toBe(400)
  })

  it('touches the resend sidecar and 404s unknown platforms', async () => {
    const paths = publishPaths(apiRoot, 'douyin')
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.status, JSON.stringify({ state: 'sms_required', message: '', qr: '', ts: 1 }), 'utf8')
    const resend = await post('/api/publish/douyin/resend', {})
    expect(resend.status).toBe(200)
    expect(await stat(paths.resend)).toBeTruthy()
    const unknown = await fetch(`${base}/api/publish/kuaishou`)
    expect(unknown.status).toBe(404)
  })
})
