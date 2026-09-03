import type { FsGateway } from './gateways/contracts'

/**
 * Attachment pipeline helpers: MIME↔extension mapping for the supported
 * image formats, paste naming, clipboard extraction, base64 conversion and
 * the note↔vault path juggling used by paste/drop insertion and export.
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
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  if (!match) return null
  return isAttachmentExtension(match[1]) ? match[1] : null
}

export function isImageFile(file: { name: string; type: string }): boolean {
  return Boolean(extensionFromMime(file.type) || extensionFromFileName(file.name))
}

export function isImagePath(path: string): boolean {
  return Boolean(extensionFromFileName(path.split(/[\\/]/).pop() ?? path))
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

export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const chunkSize = 0x8000
  let binary = ''
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

export function collectClipboardImages(data: DataTransfer | null): File[] {
  if (!data) return []
  const fromItems: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' && !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file && isImageFile(file)) fromItems.push(file)
  }
  if (fromItems.length) return uniqueFiles(fromItems)
  return uniqueFiles(Array.from(data.files ?? []).filter(isImageFile))
}

function uniqueFiles(files: File[]): File[] {
  const seen = new Set<string>()
  return files.filter((file) => {
    const key = `${file.name}:${file.size}:${file.type}:${file.lastModified}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function noteDirectory(notePath: string): string {
  if (!notePath.includes('/')) return ''
  return notePath.slice(0, notePath.lastIndexOf('/'))
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

/** Like {@link relativePathFromNote} but tolerant of an ABSOLUTE note path:
 * the note is first rebased onto the vault (via `dirRelativeToVault`), so the
 * computed reference is relative to the note's own directory rather than to
 * the absolute parent folders. Falls back to the plain relative form when
 * `notePath`/`vault` don't line up. */
export function relativePathFromNoteVault(
  notePath: string,
  vault: string,
  targetPath: string,
): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(targetPath) || targetPath.startsWith('/')) return targetPath
  const v = (vault || '').replace(/\/+$/, '')
  let p = notePath || ''
  if (v !== '' && (p === v || p.startsWith(`${v}/`))) {
    p = p.slice(v.length).replace(/^\/+/, '')
  } else if (p.startsWith('/')) {
    // An absolute path that isn't under the vault: keep only the trailing
    // directories, which is the best approximation of the note's location.
    p = p.replace(/^\/+/, '')
  }
  const fromDirectory = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
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
 * so `../` bookkeeping is measured from the note's actual directory. */
export function vaultRelativeFromNoteVault(notePath: string, vault: string, src: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/')) return src
  if (!src.startsWith('..') && src.startsWith(`${ATTACHMENTS_DIR}/`)) return src
  const v = (vault || '').replace(/\/+$/, '')
  let p = notePath || ''
  if (v !== '' && (p === v || p.startsWith(`${v}/`))) {
    p = p.slice(v.length).replace(/^\/+/, '')
  } else if (p.startsWith('/')) {
    p = p.replace(/^\/+/, '')
  }
  const fromDir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
  return resolveRelativePath(fromDir, src)
}

export interface ImageSrcResolverContext {
  getVault(): string | null
  getNotePath(): string | null
}

/** Build the display-URL resolver handed to the editor / export pipeline.
 * Returns the raw src untouched when no vault is open or resolution fails,
 * so a broken pipeline degrades to today's behavior instead of hiding images. */
export function createImageSrcResolver(
  fs: Pick<FsGateway, 'resolveMediaPath'>,
  ctx: ImageSrcResolverContext,
): (src: string) => Promise<string> {
  return async (src) => {
    const vault = ctx.getVault()
    if (!vault) return src
    try {
      const rel = vaultRelativeFromNoteVault(ctx.getNotePath() ?? '', vault, src)
      return await fs.resolveMediaPath(vault, rel)
    } catch {
      return src
    }
  }
}
