/**
 * The note summary projection: what a note card, the library list and the
 * search index know about one note.
 *
 * Everything here answers one question — given a note's path, its text and its
 * stat, what does the rest of the app show for it? That spans the fallback
 * chain for the title, the plain-text sample used as the summary, the note's
 * references resolved to vault-relative targets, and the assembly of all of it
 * into a `NoteSummary`. The three are one concern because `parseNoteMeta` is
 * their only consumer and the shape of its result is what defines them: change
 * what a card shows and all three move together.
 *
 * The frontmatter block itself is read by `frontmatter-scan.ts` and the path
 * arithmetic by `note-paths.ts`; nothing here touches fs, a store or the DOM.
 */

import { t } from '../../../i18n'
import { baseName } from '../../../services/paths'
import { parseFrontmatterBlock, splitNoteForSummary } from './frontmatter-scan'
import { dirRelativeToVault, resolveLinkTarget } from './note-paths'

export interface NoteSummary {
  path: string
  name: string
  title: string
  tags: string[]
  summary: string
  mtime: number
  size: number
  dir: string
  links: string[]
}

export interface MdLink {
  text: string
  target: string
}

const SUMMARY_CHARS = 120

export function fileNameTitle(name: string): string {
  return name.replace(/\.(md|mdx)$/i, '').trim()
}

function fenceMask(content: string): string {
  let inFence = false
  const lines: string[] = []
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      lines.push('')
      continue
    }
    lines.push(inFence ? '' : line)
  }
  return lines.join('\n')
}

export function extractH1(body: string): string {
  const visible = fenceMask(body)
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(visible)
  if (!match) return ''
  return match[1].replace(/[#`*_~]/g, '').replace(/\s+/g, ' ').trim()
}

export function extractSummary(body: string, max = SUMMARY_CHARS): string {
  const visible = fenceMask(body)
  const text = visible
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, max)
}

const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
/** `[[target]]` / `[[target|alias]]` — the app's own wiki syntax. */
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g
const EXTERNAL_RE = /^(https?:|mailto:|#|data:)/i

/**
 * A wiki target names a NOTE, so `[[other]]` and `[[other.md]]` are the same
 * reference. The editor accepts both when you Ctrl+click, and the index has to
 * key them the same way or a backlink can never match: `inlinksOf` compares the
 * stored links against a `<name>.md` path, so an extension-less target would sit
 * in the list invisibly. A `#fragment` rides along untouched — the resolvers
 * strip it.
 */
function withNoteExtension(target: string): string {
  // Split the fragment OFF before touching the extension: appending to the whole
  // string turned `[[target#section]]` into `target#section.md`, whose path
  // resolves to nothing (the fragment is not part of the file name).
  const hash = target.indexOf('#')
  const path = (hash < 0 ? target : target.slice(0, hash)).trim()
  if (!path) return ''
  const fragment = hash < 0 ? '' : target.slice(hash)
  return /\.(md|mdx)$/i.test(path) ? `${path}${fragment}` : `${path}.md${fragment}`
}

export function extractOutlinks(content: string): MdLink[] {
  const out: MdLink[] = []
  for (const match of content.matchAll(LINK_RE)) {
    const target = match[2]
    if (EXTERNAL_RE.test(target)) continue
    const path = target.split('#')[0]
    if (!/\.(md|mdx)$/i.test(path)) continue
    out.push({ text: match[1].trim(), target })
  }
  // Wikilinks too. They render as chips and Ctrl+click navigates, but the link
  // EXTRACTOR only knew `[text](target)` — so a note referenced with the app's
  // own wiki syntax never appeared in the backlinks list or in the graph, and
  // the panel said "no note references this document" while one plainly did.
  for (const match of content.matchAll(WIKILINK_RE)) {
    // An escaped bracket is literal text, not a link (the editor's parser draws
    // the same line).
    if (match.index > 0 && content[match.index - 1] === '\\') continue
    const raw = match[1].trim()
    if (!raw || EXTERNAL_RE.test(raw)) continue
    const target = withNoteExtension(raw)
    if (!target) continue
    out.push({ text: (match[2] ?? '').trim() || raw, target })
  }
  return out
}

export function parseNoteMeta(
  path: string,
  content: string,
  meta: { mtime: number; size: number; vault: string },
): NoteSummary {
  const { front, body } = splitNoteForSummary(content)
  const parsed = parseFrontmatterBlock(front)
  // Must be the basename: on Windows this used to be the whole absolute
  // path, which is what the note list rendered as every note's title.
  const name = baseName(path)
  const dir = dirRelativeToVault(path, meta.vault)
  const tags = [...new Set(parsed.tags.map((t) => t.replace(/^#/, '').trim()).filter(Boolean))]
  const fromDir = dir
  const links = [
    ...new Set(
      extractOutlinks(content)
        .map((l) => resolveLinkTarget(fromDir, l.target))
        .filter(Boolean),
    ),
  ]
  return {
    path,
    name,
    title: parsed.title || extractH1(body) || fileNameTitle(name) || t('note.untitled'),
    tags,
    summary: extractSummary(body),
    mtime: meta.mtime,
    size: meta.size,
    dir,
    links,
  }
}
