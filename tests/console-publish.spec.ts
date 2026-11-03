/** Tests for the publish domain's node side: the _publish file protocol and the /api/publish routes. */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, describe, beforeEach, afterEach } from 'vitest'
import {
  aggregatePublish, isSmsPublishPlatform, publishPaths, readLogTail, readPublishState,
  touchResend, writePublishSmsCode, TERMINAL_PUBLISH_STATES,
} from '../src/console/publish-protocol.ts'

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
