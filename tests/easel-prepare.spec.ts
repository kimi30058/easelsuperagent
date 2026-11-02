/** The Easel workspace-preparation script: each ticket directory is shaped as an Easel-style project root. */
import { it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = join(import.meta.dirname, '..')
const script = join(repo, 'scripts', 'prepare-ticket.sh')

function run(root: string, dirName: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync('sh', [script], { cwd: root, encoding: 'utf8',
    env: { ...process.env, EASEL_SUPERAGENT_DIR: join(root, dirName), EASEL_SUPERAGENT_NAME: dirName, EASEL_SUPERAGENT_TICKET: 't-1', ...env } })
}

it('shapes a ticket workspace as an Easel root: outputs, shared profiles and .env, and both shared-path forms resolve', () => {
  const root = mkdtempSync(join(tmpdir(), 'easel-root-'))
  mkdirSync(join(root, 'profiles'), { recursive: true })
  writeFileSync(join(root, '.env'), 'TEST=1')
  const result = run(root, 't-1')
  expect(result.status).toBe(0)
  const ticket = join(root, 't-1')
  expect(existsSync(join(ticket, 'outputs'))).toBe(true)
  expect(readlinkSync(join(ticket, 'skills'))).toBe(join(repo, 'skills/easel'))
  // macOS resolves /var to /private/var; compare the real paths the shell saw.
  expect(readlinkSync(join(ticket, 'profiles'))).toBe(realpathSync(join(root, 'profiles')))
  expect(readlinkSync(join(ticket, '.env'))).toBe(realpathSync(join(root, '.env')))
  // Easel skill bodies reference shared scripts by both path forms; both must resolve from the ticket root.
  expect(existsSync(join(ticket, 'skills/shared/scripts/calendar_ops.py'))).toBe(true)
  expect(existsSync(join(ticket, 'skills/builtin/skill-xhs-publisher/../../shared/scripts/xhs_publish.py'))).toBe(true)
})

it('fails with a readable stderr message when a dependency is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'easel-root-'))
  // A PATH without python3 (macOS keeps its stub under /usr/bin) but with the shell itself.
  const result = run(root, 't-2', { PATH: '/bin:/usr/sbin' })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/python3/)
})

it('warns but succeeds when the shared .env is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'easel-root-'))
  const result = run(root, 't-3')
  expect(result.status).toBe(0)
  expect(result.stderr).toMatch(/no shared \.env/)
  expect(existsSync(join(root, 't-3', 'skills'))).toBe(true)
})
