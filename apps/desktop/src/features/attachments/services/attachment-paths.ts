import { dirName, stripVaultPrefix } from '../../../services/paths'

/**
 * Attachment path grammar: MIME↔extension mapping for the supported image
 * formats, paste naming, the `attachments/` layout and the note↔vault path
 * juggling used by paste/drop insertion, display resolution and export.
 *
 * Pure by design — no gateway, no Vue, no store — so a caller that only needs
 * to name or reference an attachment never takes a filesystem dependency, and
 * the rules stay testable without one. The media reads live in
 * `attachment-library.ts` and the intake limits in `attachment-import.ts`.
 *
 * `platform/gateways/memory.ts` deliberately INLINES the extension→mime map
 * instead of importing this module: `platform` must never depend back on a
 * feature (§13.11), so that inline stays and a change to {@link
 * mimeFromExtension}'s table has to be mirrored there by hand.
 */

export const ATTACHMENTS_DIR = 'attachments'

export const ATTACHMENT_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'avif',
  'svg',
] as const

export type AttachmentExtension = (typeof ATTACHMENT_EXTENSIONS)[number]

/**
 * Image extensions a vault may hold that this build has no reader for.
 *
 * The two lists answer two different questions and neither is wrong: the host's
 * `IMPORT_IMAGE_EXTENSIONS` (`apps/desktop/src-tauri/src/storage/attachment_store.rs`) is the set
 * the app is willing to COPY into a vault — these plus {@link ATTACHMENT_EXTENSIONS} — because a
 * vault is the reader's own folder and a `.tiff` in it is a legitimate file; this list is what this
 * build can display and attach. The delta is spelled out rather than derived: the Rust constant is
 * on the far side of the IPC boundary and cannot be read from here, so a change there has to be
 * mirrored here by hand — the same manual mirror `platform/gateways/memory.ts` keeps of the MIME
 * table.
 *
 * It exists so a caller can tell the two apart *before* reading anything. A `.tiff` is an image,
 * and handing it to the text reader is what made the app call a file it had imported itself
 * "unreadable": `read_to_string` refuses every image, so the reason it reported was the reader's
 * own shape rather than the file's format.
 */
export const UNSUPPORTED_IMAGE_EXTENSIONS = ['ico', 'tiff', 'tif'] as const

/** A path's extension, lowercased, with no dot. `''` when it has none. */
function fileExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
}

const MIME_TO_EXTENSION: Record<string, AttachmentExtension> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
}

const EXTENSION_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
}

const GENERIC_STEM = /^(image|blob|untitled|paste|screenshot)(\s*[-_]?\d+)?$/i

export function isAttachmentExtension(value: string): value is AttachmentExtension {
  return (ATTACHMENT_EXTENSIONS as readonly string[]).includes(value.toLowerCase())
}

export function extensionFromMime(mimeType: string): AttachmentExtension | null {
  return MIME_TO_EXTENSION[mimeType.trim().toLowerCase()] ?? null
}

export function mimeFromExtension(extension: string): string {
  return EXTENSION_TO_MIME[extension.toLowerCase()] ?? 'application/octet-stream'
}

export function extensionFromFileName(fileName: string): AttachmentExtension | null {
  const extension = fileExtension(fileName)
  return isAttachmentExtension(extension) ? extension : null
}

export function isImageFile(file: { name: string; type: string }): boolean {
  return Boolean(extensionFromMime(file.type) || extensionFromFileName(file.name))
}

export function isImagePath(path: string): boolean {
  return Boolean(extensionFromFileName(path.split(/[\\/]/).pop() ?? path))
}

/** True for a path whose extension is an image this build does not read — see
 *  {@link UNSUPPORTED_IMAGE_EXTENSIONS}. False for a supported image and for everything else. */
export function isUnsupportedImagePath(path: string): boolean {
  return (UNSUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(path))
}

export function sanitizeAttachmentFileName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop()?.trim() ?? ''
  let slug = ''
  let lastDash = false
  for (const character of base) {
    if (character === '.') {
      if (slug && !slug.endsWith('.')) slug += '.'
      lastDash = false
      continue
    }
    if (/\p{Letter}|\p{Number}|_/u.test(character)) {
      slug += character
      lastDash = false
      continue
    }
    if (!lastDash && slug) {
      slug += '-'
      lastDash = true
    }
  }
  return slug.replace(/^[.-]+|[.-]+$/g, '') || 'image'
}

export function formatStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function attachmentMonthDir(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function attachmentRelativePath(fileName: string, date = new Date()): string {
  return `${ATTACHMENTS_DIR}/${attachmentMonthDir(date)}/${fileName}`
}

/** Clipboard/screenshot blobs carry throwaway names (image, paste, …);
 * those become a timestamped name, real names are merely sanitized. */
export function suggestedPasteFileName(
  file: { name: string; type: string },
  now = new Date(),
): string {
  const extension = extensionFromMime(file.type) ?? extensionFromFileName(file.name) ?? 'png'
  const rawStem = file.name.replace(/\.[^.]+$/, '').trim()
  const generic = !rawStem || GENERIC_STEM.test(rawStem)
  const stem = generic ? `paste-${formatStamp(now)}` : sanitizeAttachmentFileName(rawStem)
  return `${stem}.${extension}`
}

export function escapeMarkdownAlt(value: string): string {
  return value.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim() || 'image'
}

/** A markdown image as a standalone block, padded with blank lines so it
 * survives being spliced into arbitrary document text. */
export function markdownImageBlock(alt: string, relPath: string): string {
  return `\n\n![${escapeMarkdownAlt(alt)}](${relPath})\n\n`
}

export function noteDirectory(notePath: string): string {
  // Either separator: note paths are absolute and native on Windows.
  const dir = dirName(notePath)
  return dir === notePath ? '' : dir
}

/** Resolve `rel` (`../attachments/…`, `attachments/…`) against `fromDir`,
 * clamping `..` at the vault root. Absolute/scheme'd inputs pass through. */
export function resolveRelativePath(fromDir: string, rel: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return rel
  const out = fromDir ? fromDir.split('/').filter(Boolean) : []
  for (const seg of rel.replace(/^\/+/, '').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join('/')
}

/** The markdown src a note should reference `targetPath` (a vault-relative
 * attachment path) by: a `../attachments/…` style reference for notes in
 * subdirectories, the plain vault-relative path for root-level notes, and
 * absolute/scheme'd paths unchanged. Posix separators throughout. */
export function relativePathFromNote(notePath: string, targetPath: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(targetPath) || targetPath.startsWith('/')) return targetPath
  const fromDirectory = noteDirectory(notePath)
  const fromParts = fromDirectory ? fromDirectory.split('/').filter(Boolean) : []
  const targetParts = targetPath.split('/').filter(Boolean)
  if (fromParts.length === 0) return targetPath
  let shared = 0
  while (
    shared < fromParts.length &&
    shared < targetParts.length - 1 &&
    fromParts[shared] === targetParts[shared]
  ) {
    shared += 1
  }
  const up = fromParts.length - shared
  const down = targetParts.slice(shared)
  return [...Array.from({ length: up }, () => '..'), ...down].join('/') || '.'
}

/** Absolute, OS-native path spellings: `/…`, `C:\…`, `C:/…`, `\\?\C:\…`
 * and `\\server\share\…`. Separator-agnostic on purpose: Windows paths cross
 * IPC with backslashes while every derived value in the app uses `/`. */
function isAbsoluteFsPath(p: string): boolean {
  return p.startsWith('/') || /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\')
}

/** True for a src/target addressed by a URL scheme (`https:`, `data:`,
 * `memoir:`). A Windows drive letter matches the generic scheme pattern while
 * being a filesystem path, so absolute paths are excluded explicitly. */
function hasUrlScheme(p: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(p) && !isAbsoluteFsPath(p)
}

/** Like {@link relativePathFromNote} but tolerant of an ABSOLUTE note path:
 * the note is first rebased onto the vault (via `stripVaultPrefix`), so the
 * computed reference is relative to the note's own directory rather than to
 * the absolute parent folders. Falls back to the plain relative form when
 * `notePath`/`vault` don't line up.
 *
 * A `targetPath` that is itself absolute-but-inside-the-vault is rebased too
 * (that is what the note's assets-dir helper used to produce on Windows), so
 * the returned reference is always vault-relative and never a `C:\…` string
 * that only works on the machine that wrote it. */
export function relativePathFromNoteVault(
  notePath: string,
  vault: string,
  targetPath: string,
): string {
  if (hasUrlScheme(targetPath)) return targetPath
  const target = isPathWithinVault(targetPath, vault) ? stripVaultPrefix(targetPath, vault) : targetPath
  // Still absolute after rebasing means it is a local path outside the vault:
  // not ours to rewrite, so pass it through (the old behaviour).
  if (isAbsoluteFsPath(target)) return target
  const p = stripVaultPrefix(notePath || '', vault)
  const fromDirectory = noteDirectory(p)
  const fromParts = fromDirectory ? fromDirectory.split('/').filter(Boolean) : []
  const targetParts = target.split('/').filter(Boolean)
  if (fromParts.length === 0) return target
  let shared = 0
  while (
    shared < fromParts.length &&
    shared < targetParts.length - 1 &&
    fromParts[shared] === targetParts[shared]
  ) {
    shared += 1
  }
  const up = fromParts.length - shared
  const down = targetParts.slice(shared)
  return [...Array.from({ length: up }, () => '..'), ...down].join('/') || '.'
}

/** Inverse of {@link relativePathFromNote} for the display resolver: turn a
 * document src back into a vault-relative path. Srcs that already point at
 * the vault-level attachments dir are taken as-is; `../…` forms are resolved
 * against the note's directory. */
export function vaultRelativeFromNote(notePath: string, src: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/')) return src
  const fromDir = noteDirectory(notePath)
  if (!src.startsWith('..') && src.startsWith(`${ATTACHMENTS_DIR}/`)) return src
  return resolveRelativePath(fromDir, src)
}

/** Vault-aware variant: rebase an absolute `notePath` onto the vault first,
 * so `../` bookkeeping is measured from the note's actual directory. The vault
 * prefix is stripped separator-agnostically (`stripVaultPrefix`): Windows note
 * paths carry backslashes, and the `/`-only test this used to do left them
 * looking unfiled, so `../` resolved against the vault root instead. */
export function vaultRelativeFromNoteVault(notePath: string, vault: string, src: string): string {
  if (hasUrlScheme(src) || isAbsoluteFsPath(src)) return src
  if (!src.startsWith('..') && src.startsWith(`${ATTACHMENTS_DIR}/`)) return src
  const p = stripVaultPrefix(notePath || '', vault)
  return resolveRelativePath(noteDirectory(p), src)
}

/** True when `candidate` (an absolute OS-native path, e.g. one returned by the
 * native save dialog) lies at or under `vault`. Both sides are normalized to
 * forward slashes and trailing separators stripped, so the test is agnostic to
 * the vault root spelling (with/without a trailing slash) and to Windows
 * backslashes. Lexical, not canonical: the Rust write still independently
 * proves a path stays inside the vault via `resolve_within`. */
export function isPathWithinVault(candidate: string, vault: string): boolean {
  if (!candidate || !vault) return false
  const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const target = normalize(candidate)
  const root = normalize(vault)
  if (target === root) return true
  return target.startsWith(`${root}/`)
}
