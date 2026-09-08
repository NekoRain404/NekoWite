import { fsService } from '../platform/gateways/fs'
import type { FileEntry } from '../platform/gateways/contracts'

/** A vault-relative template file in `<vault>/templates/`, with the `.md`
 *  extension stripped for a human-friendly display name. */
export interface TemplateEntry {
  name: string
  path: string
}

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

/** Lists the markdown templates in `<vault>/templates/`, sorted by name, with
 *  the `.md` extension stripped from the display `name`. Returns an empty
 *  array when the directory does not exist or cannot be read. */
export async function listTemplates(vault: string): Promise<TemplateEntry[]> {
  let entries: FileEntry[]
  try {
    entries = await fsService.list(vault, 'templates')
  } catch {
    return []
  }
  return entries
    .filter((e) => !e.is_dir && /\.md$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ name: e.name.replace(/\.md$/i, ''), path: e.path }))
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
