/** Tests for the account domain's node side: the _login file protocol, runner lifecycle, whoami, and credentials. */
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, describe, beforeEach, afterEach } from 'vitest'
import {
  PLATFORMS, PROCESS_KEYS, bilibiliCookiePath, clearArtifacts, isPlatform, isProcessKey,
  loggedInFast, loginDir, loginPaths, profileDir, readQr, readStatus, validSmsCode, writeMarker, writeSmsCode,
} from '../src/console/login-protocol.ts'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sp2-protocol-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('platform table', () => {
  it('lists the four fork platforms plus the wechat-oa-mp process key, and rejects anything else', () => {
    expect(PLATFORMS.map(p => p.platform)).toEqual(['xiaohongshu', 'bilibili', 'douyin', 'wechat-oa'])
    expect(PROCESS_KEYS).toContain('wechat-oa-mp')
    expect(isPlatform('xiaohongshu')).toBe(true)
    expect(isPlatform('kuaishou')).toBe(false)          // fork 发布范围外的 Easel 平台
    expect(isProcessKey('../../etc')).toBe(false)       // Review Focus 1
  })

  it('maps browser platforms to their global profile directory and leaves biliup/wechat-oa without one', () => {
    expect(profileDir('xiaohongshu')).toContain('XiaohongshuProfile')
    expect(profileDir('wechat-oa-mp')).toContain('WeixinMpProfile')
    expect(profileDir('bilibili')).toBeUndefined()
    expect(profileDir('wechat-oa')).toBeUndefined()
  })
})

describe('login status files', () => {
  it('reads a written status and reports a ready qr by its mtime', async () => {
    const paths = loginPaths(root, 'xiaohongshu')
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.status, JSON.stringify({ state: 'qr_ready', message: '等扫码', qr: '', ts: 1 }), 'utf8')
    await writeFile(paths.qr, Buffer.from([137, 80, 78, 71]), 'utf8')  // PNG magic
    const status = await readStatus(paths)
    expect(status.state).toBe('qr_ready')
    expect(status.message).toBe('等扫码')
    expect(status.qrTs).toBeGreaterThan(0)
    expect(await readQr(paths)).toEqual(Buffer.from([137, 80, 78, 71]))
  })

  it('falls back to unknown on a missing or torn file instead of throwing', async () => {
    const paths = loginPaths(root, 'douyin')
    expect((await readStatus(paths)).state).toBe('unknown')
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.status, '{"state": "qr_re', 'utf8')  // Review Focus 2
    expect((await readStatus(paths)).state).toBe('unknown')
  })

  it('synthesizes an actionable error when the runner died before a terminal state', async () => {
    const paths = loginPaths(root, 'douyin')                       // Review Focus 3
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.status, JSON.stringify({ state: 'starting', message: '' }), 'utf8')
    const status = await readStatus(paths, 9)
    expect(status.state).toBe('error')
    expect(status.message).toContain('douyin.log')
    // 终态不合成：success 就是 success
    await writeFile(paths.status, JSON.stringify({ state: 'success', message: '' }), 'utf8')
    expect((await readStatus(paths, 9)).state).toBe('success')
  })
})

describe('sms codes, markers, and the fast path', () => {
  it('validates 4-8 digit codes and writes the one-shot code file', async () => {
    expect(validSmsCode('1234')).toBe(true)
    expect(validSmsCode('12345678')).toBe(true)
    expect(validSmsCode('12ab')).toBe(false)
    expect(validSmsCode('123')).toBe(false)
    const paths = loginPaths(root, 'douyin')
    await writeSmsCode(paths, '654321')
    expect(await readFile(paths.code, 'utf8')).toBe('654321')
  })

  it('writes atomic markers and clears every artifact of a key', async () => {
    const paths = loginPaths(root, 'xiaohongshu')
    await writeMarker(paths, 'expired', '已取消')
    expect((await readStatus(paths)).state).toBe('expired')
    await clearArtifacts(paths)
    expect((await readStatus(paths)).state).toBe('unknown')
  })

  it('judges the fast path from the marker and the biliup cookie file', async () => {
    expect(await loggedInFast(root, 'xiaohongshu')).toBe(false)
    await writeMarker(loginPaths(root, 'xiaohongshu'), 'success', '')
    expect(await loggedInFast(root, 'xiaohongshu')).toBe(true)
    expect(await loggedInFast(root, 'bilibili')).toBe(false)
    await mkdir(loginDir(root), { recursive: true })
    await writeFile(bilibiliCookiePath(root), '{}', 'utf8')
    expect(await loggedInFast(root, 'bilibili')).toBe(true)
  })
})
