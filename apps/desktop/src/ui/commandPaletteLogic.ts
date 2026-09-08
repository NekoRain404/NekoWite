import { t } from '../i18n'

export type PaletteKind = 'command' | 'file'

export interface PaletteEntry {
  id: string
  kind: PaletteKind
  label: string
  hint?: string
  keywords?: string
  run: () => void
}

export interface PaletteGroup {
  key: PaletteKind
  label: string
  entries: PaletteEntry[]
}

export const GROUP_LABELS: Record<PaletteKind, string> = {
  command: t('palette.groupCommand'),
  file: t('palette.groupFile'),
}

const GROUP_ORDER: PaletteKind[] = ['command', 'file']

/** 0 exact label/keyword word · 1 label prefix · 2 secondary prefix · 3
 * label includes · 4 secondary includes · -1 no match. Case-insensitive. */
export function scoreEntry(entry: PaletteEntry, needle: string): number {
  const label = entry.label.toLowerCase()
  const extra = (entry.keywords ?? '').toLowerCase()
  if (label === needle) return 0
  if (extra.split(/\s+/).includes(needle)) return 0
  if (label.startsWith(needle)) return 1
  if (extra.startsWith(needle)) return 2
  if (label.includes(needle)) return 3
  if (extra.includes(needle)) return 4
  return -1
}

/** Empty query returns the entries untouched (caller-curated order, e.g.
 * recents); a non-empty query filters, ranks and truncates. */
export function filterEntries(entries: PaletteEntry[], query: string, limit = Number.POSITIVE_INFINITY): PaletteEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return entries.slice()
  const scored: { entry: PaletteEntry; score: number }[] = []
  for (const entry of entries) {
    const score = scoreEntry(entry, needle)
    if (score >= 0) scored.push({ entry, score })
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.entry.label.localeCompare(b.entry.label, 'zh-Hans-CN') ||
      a.entry.id.localeCompare(b.entry.id),
  )
  return scored.slice(0, limit).map((s) => s.entry)
}

/** Command group first, file group second; empty groups are dropped. */
export function groupEntries(entries: PaletteEntry[]): PaletteGroup[] {
  const buckets = new Map<PaletteKind, PaletteEntry[]>()
  for (const entry of entries) {
    const list = buckets.get(entry.kind)
    if (list) list.push(entry)
    else buckets.set(entry.kind, [entry])
  }
  const groups: PaletteGroup[] = []
  for (const key of GROUP_ORDER) {
    const items = buckets.get(key)
    if (items?.length) groups.push({ key, label: GROUP_LABELS[key], entries: items })
  }
  return groups
}

export function flattenGroups(groups: PaletteGroup[]): PaletteEntry[] {
  const out: PaletteEntry[] = []
  for (const group of groups) out.push(...group.entries)
  return out
}

export interface PathParts {
  name: string
  dir: string
}

export function splitPath(path: string): PathParts {
  const cut = path.lastIndexOf('/')
  if (cut < 0) return { name: path, dir: '' }
  return { name: path.slice(cut + 1), dir: path.slice(0, cut) }
}

/** Directory portion for display, with the vault prefix stripped so hints
 * stay short; paths outside the vault fall back to the raw dir. */
export function displayDir(path: string, vault: string | null): string {
  const { dir } = splitPath(path)
  if (!dir) return ''
  if (!vault) return dir
  const root = vault.replace(/\/+$/, '')
  if (dir === root) return ''
  const prefix = root + '/'
  return dir.startsWith(prefix) ? dir.slice(prefix.length) : dir
}

export function fileEntryOf(path: string, vault: string | null, run: () => void): PaletteEntry {
  const { name } = splitPath(path)
  const shown = displayDir(path, vault)
  return {
    id: `file:${path}`,
    kind: 'file',
    label: name,
    hint: shown,
    keywords: shown ? `${shown} ${name}` : name,
    run,
  }
}
