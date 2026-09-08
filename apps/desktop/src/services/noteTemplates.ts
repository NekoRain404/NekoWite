import { fsService } from '../platform/gateways/fs'
import type { FileEntry } from '../platform/gateways/contracts'

import builtinDaily from '../templates/daily.md?raw'
import builtinWeekly from '../templates/weekly.md?raw'
import builtinMeeting from '../templates/meeting.md?raw'
import builtinStudy from '../templates/study.md?raw'
import builtinReading from '../templates/reading.md?raw'
import builtinExperiment from '../templates/experiment.md?raw'
import builtinLiterature from '../templates/literature.md?raw'
import builtinResearchPlan from '../templates/research-plan.md?raw'
import builtinTestCase from '../templates/test-case.md?raw'
import builtinDecision from '../templates/decision.md?raw'

/** A vault-relative template file in `<vault>/templates/`, with the `.md`
 *  extension stripped for a human-friendly display name. */
export interface TemplateEntry {
  name: string
  path: string
  /** Stable ASCII file base used for built-in template output names. */
  slug?: string
}

const BUILTIN_PREFIX = 'builtin:'

interface BuiltinTemplate extends TemplateEntry {
  body: string
}

const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  { name: '每日日记', path: 'builtin:daily', slug: 'daily', body: builtinDaily },
  { name: '每周复盘', path: 'builtin:weekly', slug: 'weekly', body: builtinWeekly },
  { name: '会议记录', path: 'builtin:meeting', slug: 'meeting', body: builtinMeeting },
  { name: '学习笔记', path: 'builtin:study', slug: 'study', body: builtinStudy },
  { name: '读书笔记', path: 'builtin:reading', slug: 'reading', body: builtinReading },
  { name: '实验记录', path: 'builtin:experiment', slug: 'experiment', body: builtinExperiment },
  { name: '文献阅读', path: 'builtin:literature', slug: 'literature', body: builtinLiterature },
  { name: '研究计划', path: 'builtin:research-plan', slug: 'research-plan', body: builtinResearchPlan },
  { name: '测试用例', path: 'builtin:test-case', slug: 'test-case', body: builtinTestCase },
  { name: '决策记录', path: 'builtin:decision', slug: 'decision', body: builtinDecision },
]

/** The built-in templates every vault gets before any user templates. */
export const DEFAULT_TEMPLATES: TemplateEntry[] = BUILTIN_TEMPLATES.map((entry) => ({
  name: entry.name,
  path: entry.path,
  slug: entry.slug,
}))

export const DEFAULT_DAILY_TEMPLATE = `---
title: "Daily {{date}}"
---

# {{date}}

- `

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** `YYYY-MM-DD` for the given date, using local-time fields so it is stable
 *  regardless of the process timezone. */
export function dailyDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** `YYYY-MM-DD.md` filename for a daily note. */
export function dailyNoteFileName(date: Date = new Date()): string {
  return `${dailyDateKey(date)}.md`
}

/** Vault-relative path for a daily note, stored under `<vault>/daily/`. */
export function dailyNotePath(vault: string, date: Date = new Date()): string {
  const dir = vault.replace(/\/+$/, '')
  return `${dir}/daily/${dailyNoteFileName(date)}`
}

/** Builds the default variable map for a daily note. Any provided override
 *  wins over the computed value; callers can thus customise `title`/`weekday`
 *  while keeping the computed `date`/`time`. */
export function buildDailyVars(
  date: Date = new Date(),
  overrides: Partial<Record<'date' | 'time' | 'title' | 'weekday', string>> = {},
): Record<string, string> {
  const dateKey = dailyDateKey(date)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return {
    date: dateKey,
    time,
    title: `Daily ${dateKey}`,
    weekday: WEEKDAYS[date.getDay()] ?? '',
    ...overrides,
  }
}

/** Matches `{{ name }}` placeholders with optional surrounding whitespace.
 *  A replacer function is used so replacement values are inserted literally
 *  (never as `$`-substitution patterns) and unknown names are kept intact. */
const VARIABLE_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g

/** Replaces known `{{var}}` tokens in `templateBody` with the matching value
 *  from `vars`. Unknown or missing variables are preserved verbatim. */
export function renderTemplate(templateBody: string, vars: Record<string, string>): string {
  return templateBody.replace(VARIABLE_RE, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
  })
}

/** Returns true when `entry` ships with the application rather than living
 *  in the user's `<vault>/templates/` directory. */
export function isBuiltinTemplate(entry: TemplateEntry): boolean {
  return entry.path.startsWith(BUILTIN_PREFIX)
}

/** File base for a template output note: built-ins use their stable ASCII
 *  slug so new files are not named with Chinese characters; user templates
 *  keep their display name. */
export function templateFileBase(entry: TemplateEntry): string {
  return entry.slug ?? entry.name
}

/** Lists the built-in templates plus the markdown templates in
 *  `<vault>/templates/`. A user template with the same display name overrides
 *  its built-in counterpart; the remaining user templates follow the built-ins
 *  in name order. */
export async function listTemplates(vault: string): Promise<TemplateEntry[]> {
  let entries: FileEntry[]
  try {
    entries = await fsService.list(vault, 'templates')
  } catch {
    return [...DEFAULT_TEMPLATES]
  }

  const userEntries = entries
    .filter((e) => !e.is_dir && /\.md$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ name: e.name.replace(/\.md$/i, ''), path: e.path }))

  const userByName = new Map(userEntries.map((entry) => [entry.name, entry]))
  const builtinNames = new Set(DEFAULT_TEMPLATES.map((entry) => entry.name))
  return [
    ...DEFAULT_TEMPLATES.map((entry) => userByName.get(entry.name) ?? entry),
    ...userEntries.filter((entry) => !builtinNames.has(entry.name)),
  ]
}

/** Reads a template body from application resources for built-in entries or
 *  from `<vault>/templates/` for user entries. */
export async function readTemplate(vault: string, entry: TemplateEntry): Promise<string> {
  if (isBuiltinTemplate(entry)) {
    const builtin = BUILTIN_TEMPLATES.find((item) => item.path === entry.path)
    if (!builtin) throw new Error(`unknown built-in template: ${entry.name}`)
    return builtin.body
  }
  return fsService.read(vault, entry.path)
}

/** Picks the first free `<base>.md` / `<base>-<n>.md` filename not present in
 *  `existing` (an iterable of file names in the target directory). */
export function nextAvailableName(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing)
  const first = `${base}.md`
  if (!taken.has(first)) return first
  let n = 1
  while (taken.has(`${base}-${n}.md`)) n += 1
  return `${base}-${n}.md`
}

/** Shorthand for `nextAvailableName('untitled', existing)`. */
export function nextUntitledName(existing: Iterable<string>): string {
  return nextAvailableName('untitled', existing)
}

/** Returns the daily note path and whether it was created on this call. When
 *  the note already exists it is left untouched; otherwise the default daily
 *  template is rendered and written to disk (creating `daily/` first,
 *  best-effort). */
export async function ensureDailyNote(
  vault: string,
  date: Date = new Date(),
): Promise<{ path: string; created: boolean }> {
  const path = dailyNotePath(vault, date)
  try {
    await fsService.stat(vault, path)
    return { path, created: false }
  } catch {
    try {
      await fsService.createDir(vault, 'daily')
    } catch {
      // The directory may already exist; writing is still safe.
    }
    const content = renderTemplate(DEFAULT_DAILY_TEMPLATE, buildDailyVars(date))
    await fsService.write(vault, path, content)
    return { path, created: true }
  }
}
