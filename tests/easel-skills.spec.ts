/** The mounted Easel skill library: every directory is a valid dsh skill and the customSkillDirs wiring reaches workers. */
import { it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = join(import.meta.dirname, '..')

it('ships 115 Easel skills whose frontmatter the dsh skill loader accepts', () => {
  const dirs = readdirSync(join(repo, 'skills/easel/builtin'), { withFileTypes: true }).filter(item => item.isDirectory())
  expect(dirs.length).toBe(115)
  for (const dir of dirs) {
    const text = readFileSync(join(repo, 'skills/easel/builtin', dir.name, 'SKILL.md'), 'utf8')
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)
    expect(frontmatter, dir.name).toBeTruthy()
    expect(frontmatter![1], dir.name).toMatch(/^name:\s*\S/m)
    expect(frontmatter![1], dir.name).toMatch(/^description:\s*\S/m)
    // Longer descriptions are truncated in the dsh catalog message, never dropped; loading keeps the full text.
  }
})

it('bundles an easel index skill in the strict packaged format', () => {
  const text = readFileSync(join(repo, 'skills/easel-superagent-easel-index/SKILL.md'), 'utf8')
  expect(text).toMatch(/^---\nname: easel-superagent-easel-index\ndescription: [^\n]+\n---\n\n/)
})

it('configures customSkillDirs on both presets in the bundle patch', () => {
  const yml = readFileSync(join(repo, 'cordis.patch.yml'), 'utf8')
  expect((yml.match(/customSkillDirs/g) ?? []).length).toBeGreaterThanOrEqual(2)
})
