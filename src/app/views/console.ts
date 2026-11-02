/** Read-only console views over the shared execution root and the packaged Easel skill library. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const Calendar = z.looseObject({ entries: z.array(z.unknown()).default([]) })
/** A missing directory is an empty listing; anything else (a file in its place, permissions) still surfaces. */
function directories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** Reads the recorded calendar (`outputs/_schedule.json`) of an execution root; absent means no calendar was recorded yet. */
export function calendarView(root: string): { entries: unknown[] } | undefined {
  let text: string
  try { text = readFileSync(join(root, 'outputs', '_schedule.json'), 'utf8') }
  catch (error) {
    if (absent(error)) return undefined
    throw error
  }
  return { entries: Calendar.parse(JSON.parse(text)).entries }
}
/** Lists the persona account directories (`profiles/<名字>/`) of an execution root by name; none when the directory is absent. */
export function personasView(root: string): { items: { name: string }[] } {
  return { items: directories(join(root, 'profiles')).sort().map(name => ({ name })) }
}
/**
 * Lists the packaged built-in Easel skills (`skills/easel/builtin/<name>/SKILL.md`) by name, reading each one's frontmatter;
 * a directory whose SKILL.md is missing or does not parse is skipped rather than failing the listing.
 */
export function skillsView(skillsRoot: string): { items: { name: string; description: string }[] } {
  const builtin = join(skillsRoot, 'builtin')
  const skills = directories(builtin).flatMap(name => skillHeader(join(builtin, name, 'SKILL.md')))
  return { items: skills.sort((one, other) => one.name < other.name ? -1 : 1) }
}
/** Reads one SKILL.md's `name` and `description` frontmatter, or nothing when the file is missing or its header does not parse. */
function skillHeader(path: string): { name: string; description: string }[] {
  let text: string
  try { text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n') }
  catch { return [] }
  const header = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!header) return []
  const lines = header[1]!.split('\n')
  const name = frontmatter(lines, 'name'), description = frontmatter(lines, 'description')
  return name && description ? [{ name, description }] : []
}
/** Reads one frontmatter field of a SKILL.md header: an inline value (a wrapping pair of double quotes stripped), or a `>`/`|` block (with any chomping indicator) folded to one line. */
function frontmatter(lines: string[], key: string): string | undefined {
  const index = lines.findIndex(line => line.startsWith(`${key}:`))
  if (index < 0) return undefined
  const inline = lines[index]!.slice(key.length + 1).trim()
  if (!/^[|>][+-]?$/.test(inline)) return /^".*"$/s.test(inline) ? inline.slice(1, -1) : inline
  const block: string[] = []
  for (const line of lines.slice(index + 1)) {
    if (!/^[ \t]/.test(line)) break // 每一行比键名行缩进得更深的才属于这个块
    block.push(line.trim())
  }
  return block.join(' ').trimEnd()
}
/**
 * Collects the deliverable paths a ticket's assignments reported, deduplicated in first-seen order with every naming
 * report's platforms merged onto the paths it named; `exists` checks each path inside the ticket's workspace directory,
 * which a ticket with no execution directory yet never confirms.
 */
export function deliverablesView(ticket: { assignments: { report?: { deliverables?: string[]; platforms?: string[] } }[] },
  directory: string | undefined): { items: { path: string; exists: boolean; platforms?: string[] }[] } {
  const platforms = new Map<string, string[]>()
  for (const { report } of ticket.assignments) {
    if (!report?.deliverables) continue
    for (const path of report.deliverables)
      platforms.set(path, [...new Set([...platforms.get(path) ?? [], ...(report.platforms ?? [])])])
  }
  return { items: [...platforms].map(([path, named]) => ({ path, exists: !!directory && existsSync(join(directory, path)),
    ...named.length ? { platforms: named } : {} })) }
}
