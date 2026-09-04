import type { FsGateway } from './gateways/contracts'
import { notifyError } from './errors'

/**
 * Attachment pipeline helpers: MIME↔extension mapping for the supported
 * image formats, paste naming, clipboard extraction, base64 conversion and
 * the note↔vault path juggling used by paste/drop insertion and export.
 */

export const ATTACHMENTS_DIR = 'attachments'

/**
 * Frontend attachment limits, enforced BEFORE any base64 encode or IPC.
 *
 * The paste/drop pipeline reads a whole image into memory as base64 (≈4/3 the
 * byte size), ships it over IPC, and the Rust side decodes it again — so an
 * unbounded image or a large paste can spike memory on both processes. These
 * caps reject early: an oversize image, an over-count batch, and the running
 * per-session total. They are the single source of truth for the limits that
 * {@link classifyAttachmentFiles} and {@link fileToBase64} enforce.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 // 10 MiB per image
export const MAX_ATTACHMENTS_PER_BATCH = 10 // images accepted per single paste/drop
export const MAX_ATTACHMENTS_PER_SESSION = 50 // running total per app session

/** Per-vault attachment total cap (bytes). A vault accumulating an unbounded
 *  set of large images would bloat it; this is the ceiling for the whole vault. */
export const MAX_ATTACHMENTS_PER_VAULT_BYTES = 512 * 1024 * 1024 // 512 MB

/** Per-batch byte cap for a single paste/drop. Mirrors
 *  {@link MAX_ATTACHMENTS_PER_BATCH} but by bytes, so a drop of many large files
 *  is rejected before any IPC/copy rather than reading gigabytes into memory. */
export const MAX_ATTACHMENTS_PER_BATCH_BYTES = 100 * 1024 * 1024 // 100 MB

/** Minimum free disk the vault filesystem must retain after a write. Below this
 *  the import is refused up front (a clear error) instead of failing mid-copy. */
export const MIN_ATTACHMENT_FREE_DISK_BYTES = 25 * 1024 * 1024 // 25 MB

/** Files at or above this size take the streaming/file-path route (write the
 *  bytes out via the backend) instead of base64-over-IPC, so a large file never
 *  spills a full base64 copy into JS memory. Smaller files keep the existing
 *  low-copy base64 path. */
export const STREAM_IMPORT_MIN_BYTES = 8 * 1024 * 1024 // 8 MiB

/**
 * The exact backend command a true zero-base64 streaming/file-path import would
 * call.
 *
 * The current {@link FsPort} (`platform/gateways/contracts`) only exposes
 * `saveAttachment(vault, fileName, base64, dir)`, which ships bytes as base64
 * over IPC (≈4/3x the byte size plus a Rust decode). A genuine streaming
 * file-path import would instead copy from the OS path to the vault attachment
 * dir without a JS hop:
 *
 *   import_attachment(vault: string, src_abs_path: string, dir?: string)
 *     -> Promise<string>   // the vault-relative path written
 *
 * That command is OUT OF SCOPE here (no backend command exists and `src-tauri`
 * is off-limits), so the frontend implements the reject-before-write policy —
 * per-file, per-batch, per-vault-total and disk-free-space guards — and degrades
 * cleanly: small files keep the base64 path; large files are accepted (when the
 * policy permits) and routed to the streaming route, which would call the
 * not-yet-implemented command and falls back to base64 when it is unavailable.
 */
export const STREAM_IMPORT_BACKEND_COMMAND =
  'import_attachment(vault, src_abs_path, dir?) → Promise<string>'

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

/**
 * True streaming would avoid base64 entirely: the backend would read the image
 * from its on-disk path (returned by the save dialog / already-staged `.tmp`
 * file) via a path-confined `read_attachment(vault_root, path) -> Vec<u8>` and
 * write it to the target without a JS base64 hop. The current frontend still
 * base64-encodes then ships over IPC (≈4/3 the byte size, plus a Rust decode),
 * so this function keeps the encode path as cheap as possible: it rejects an
 * oversize image BEFORE reading bytes, and uses the host's native
 * `FileReader.readAsDataURL` (which produces base64 directly) instead of
 * allocating a JS-level intermediate binary string — a second full copy on the
 * hot path for a large-but-allowed image. If the streaming command is added
 * later, the frontend should fall back to it and only base64 as a last resort.
 */
/** Files at or above this size take the native `FileReader.readAsDataURL`
 * low-copy path (no JS intermediate binary string). Smaller images are cheap
 * either way and take the fast `arrayBuffer → btoa` path, which also resolves
 * synchronously within a microtask — keeping callers whose tests await a single
 * flush stable. */
export const LOW_COPY_ENCODE_MIN_BYTES = 1024 * 1024 // 1 MiB

export async function fileToBase64(file: Blob): Promise<string> {
  // Last line of defense before we read the whole file into memory: reject an
  // oversize attachment before Buffering it, so a direct caller (e.g. the chat
  // drop path that bypasses collectClipboardImages) cannot blow up memory.
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment exceeds the ${formatAttachmentBytes(MAX_ATTACHMENT_BYTES)} limit`)
  }
  // Large-but-allowed images: native readAsDataURL yields the base64 string
  // directly in the host, avoiding the manual arrayBuffer → binary-string →
  // btoa pipeline that allocates an extra full-size (≈file-size) string — a
  // second copy on the hot path for a 10MB image.
  if (
    file.size >= LOW_COPY_ENCODE_MIN_BYTES &&
    typeof FileReader !== 'undefined' &&
    typeof FileReader.prototype.readAsDataURL === 'function'
  ) {
    const dataUrl = await readBlobAsDataUrl(file)
    if (dataUrl) {
      const comma = dataUrl.indexOf(',')
      return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
    }
  }
  // Small images / runtimes without FileReader: arrayBuffer → binary string →
  // btoa (the extra copy is negligible at this size).
  const bytes = new Uint8Array(await file.arrayBuffer())
  const chunkSize = 0x8000
  let binary = ''
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

/** Read a Blob/File as a `data:` URL via FileReader (wrapped so the encode path
 * can feature-test FileReader without duplicating the async-onload plumbing).
 * Resolves to '' on error so the caller falls back to the arrayBuffer path. */
function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => resolve('')
    reader.readAsDataURL(blob)
  })
}

export type AttachmentLimitReason =
  | 'too-large'
  | 'too-many'
  | 'session-full'
  | 'vault-total'
  | 'batch-total'
  | 'low-disk'

export interface AttachmentRejection {
  file: File
  reason: AttachmentLimitReason
}

export interface AttachmentLimitResult {
  accepted: File[]
  rejected: AttachmentRejection[]
}

/**
 * Context for the streaming/file-path import policy: how much the vault already
 * hold and how much free disk the vault's filesystem has. The caller gathers
 * this once per import (list + stat the attachments dir / read the free-space)
 * and passes it so the policy can reject before any write.
 */
export interface AttachmentImportContext {
  /** Bytes already stored in the vault's attachment dirs. */
  vaultTotalBytes: number
  /** Remaining free bytes on the vault filesystem. */
  freeDiskBytes: number
}

export interface AttachmentImportPlan {
  /** Files persisted through the streaming/file-path route (no base64 read). */
  stream: File[]
  /** Files persisted through the existing base64 route. */
  base64: File[]
  /** Accepted files in input order (a union of `stream` and `base64`). */
  accepted: File[]
  rejected: AttachmentRejection[]
  /** Total bytes the accepted files would consume. */
  acceptedBytes: number
  /** True when at least one accepted file must take the streaming route. */
  requiresStreaming: boolean
}

// Running count of attachment files accepted into the paste/drop pipeline this
// app session. Reset by the app on a fresh session and, under test, between
// cases via {@link resetAttachmentSession}.
let attachmentSessionUsed = 0

/** How many attachment files have been accepted this session. */
export function attachmentSessionCount(): number {
  return attachmentSessionUsed
}

/** Clear the per-session attachment budget (used when a session/vault is reset). */
export function resetAttachmentSession(): void {
  attachmentSessionUsed = 0
}

/** Human-readable size, e.g. `10 MB`, for user-facing limit messages. */
export function formatAttachmentBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

/**
 * Classify `files` against the attachment limits, reserving a session slot for
 * every file that passes. Pure w.r.t. output — it returns the accepted list and
 * a structured list of rejections so callers and tests can act on each reason
 * (size vs. per-batch count vs. per-session total).
 *
 * Order matters: a file is culled for size first, then the per-batch cap, then
 * the per-session cap. That keeps the "too many in one paste" message accurate
 * while still bounding the running session total.
 */
export function classifyAttachmentFiles(files: File[]): AttachmentLimitResult {
  const accepted: File[] = []
  const rejected: AttachmentRejection[] = []
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push({ file, reason: 'too-large' })
      continue
    }
    if (accepted.length >= MAX_ATTACHMENTS_PER_BATCH) {
      rejected.push({ file, reason: 'too-many' })
      continue
    }
    if (attachmentSessionUsed + accepted.length >= MAX_ATTACHMENTS_PER_SESSION) {
      rejected.push({ file, reason: 'session-full' })
      continue
    }
    accepted.push(file)
  }
  attachmentSessionUsed += accepted.length
  return { accepted, rejected }
}

function describeAttachmentRejections(rejected: AttachmentRejection[]): string {
  const tooLarge = rejected.filter((r) => r.reason === 'too-large').length
  const tooMany = rejected.filter((r) => r.reason === 'too-many').length
  const sessionFull = rejected.filter((r) => r.reason === 'session-full').length
  const vaultTotal = rejected.filter((r) => r.reason === 'vault-total').length
  const batchTotal = rejected.filter((r) => r.reason === 'batch-total').length
  const lowDisk = rejected.filter((r) => r.reason === 'low-disk').length
  const parts: string[] = []
  if (tooLarge) {
    parts.push(`${tooLarge} too large (max ${formatAttachmentBytes(MAX_ATTACHMENT_BYTES)})`)
  }
  if (tooMany) {
    parts.push(`${tooMany} over the ${MAX_ATTACHMENTS_PER_BATCH}-per-paste limit`)
  }
  if (sessionFull) {
    parts.push(`${sessionFull} over the ${MAX_ATTACHMENTS_PER_SESSION}-per-session limit`)
  }
  if (batchTotal) {
    parts.push(
      `${batchTotal} over the ${formatAttachmentBytes(MAX_ATTACHMENTS_PER_BATCH_BYTES)}-per-paste byte limit`,
    )
  }
  if (vaultTotal) {
    parts.push(
      `${vaultTotal} over the ${formatAttachmentBytes(MAX_ATTACHMENTS_PER_VAULT_BYTES)}-vault limit`,
    )
  }
  if (lowDisk) {
    parts.push(
      `${lowDisk} over the free-disk headroom (needs ${formatAttachmentBytes(
        MIN_ATTACHMENT_FREE_DISK_BYTES,
      )} free)`,
    )
  }
  return `Some images skipped: ${parts.join('; ')}`
}

/**
 * Filter `files` through the limits, notifying the user about any rejections,
 * and return only the survivors. The paste/drop/rename pipeline keeps working
 * on the accepted files while the user is told why the rest were dropped
 * (rather than silently discarding or risking a memory blowup).
 *
 * When `context` is supplied the full streaming policy is applied (per-batch /
 * per-vault byte caps + free-disk guard); otherwise the count-based limits
 * remain (back-compat for callers that cannot gather the disk context).
 */
export function applyAttachmentLimits(files: File[], context?: AttachmentImportContext): File[] {
  if (context) {
    const plan = planAttachmentImport(files, context)
    if (plan.rejected.length) notifyError(describeAttachmentRejections(plan.rejected))
    return plan.accepted
  }
  const { accepted, rejected } = classifyAttachmentFiles(files)
  if (rejected.length) notifyError(describeAttachmentRejections(rejected))
  return accepted
}

/** True when `file` is large enough that it should be written out via the
 *  backend streaming/file-path route rather than base64-encoded over IPC. */
export function shouldStreamImport(file: File, minBytes = STREAM_IMPORT_MIN_BYTES): boolean {
  return file.size >= minBytes
}

/**
 * Plan an attachment import against the FULL policy:
 *   - per-single-file cap (the existing 10 MiB),
 *   - per-batch count cap (the existing 10 per paste),
 *   - per-batch byte cap,
 *   - per-vault total cap,
 *   - disk-free-space guard.
 *
 * It is pure w.r.t. the filesystem: it reads no bytes and issues no write. It
 * returns the accepted set split into the streaming route (`stream`, files at or
 * above {@link STREAM_IMPORT_MIN_BYTES}) and the base64 route (`base64`), plus
 * structured rejections so the caller can surface each reason — nothing is ever
 * silently dropped. Rejection order: per-file size, per-batch count, per-batch
 * bytes, per-vault total, free-disk (the most specific first).
 */
export function planAttachmentImport(
  files: File[],
  context: AttachmentImportContext,
  opts: {
    maxFileBytes?: number
    maxBatchBytes?: number
    maxVaultTotalBytes?: number
    minFreeBytes?: number
  } = {},
): AttachmentImportPlan {
  const maxFile = opts.maxFileBytes ?? MAX_ATTACHMENT_BYTES
  const maxBatchBytes = opts.maxBatchBytes ?? MAX_ATTACHMENTS_PER_BATCH_BYTES
  const maxVaultTotal = opts.maxVaultTotalBytes ?? MAX_ATTACHMENTS_PER_VAULT_BYTES
  const minFree = opts.minFreeBytes ?? MIN_ATTACHMENT_FREE_DISK_BYTES

  const stream: File[] = []
  const base64: File[] = []
  const accepted: File[] = []
  const rejected: AttachmentRejection[] = []
  let acceptedBytes = 0

  for (const file of files) {
    if (file.size > maxFile) {
      rejected.push({ file, reason: 'too-large' })
      continue
    }
    if (stream.length + base64.length >= MAX_ATTACHMENTS_PER_BATCH) {
      rejected.push({ file, reason: 'too-many' })
      continue
    }
    if (acceptedBytes + file.size > maxBatchBytes) {
      rejected.push({ file, reason: 'batch-total' })
      continue
    }
    if (context.vaultTotalBytes + acceptedBytes + file.size > maxVaultTotal) {
      rejected.push({ file, reason: 'vault-total' })
      continue
    }
    if (context.freeDiskBytes - file.size < minFree) {
      rejected.push({ file, reason: 'low-disk' })
      continue
    }
    acceptedBytes += file.size
    accepted.push(file)
    if (shouldStreamImport(file)) stream.push(file)
    else base64.push(file)
  }

  return {
    stream,
    base64,
    accepted,
    rejected,
    acceptedBytes,
    requiresStreaming: stream.length > 0,
  }
}

export function collectClipboardImages(data: DataTransfer | null): File[] {
  if (!data) return []
  const fromItems: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' && !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file && isImageFile(file)) fromItems.push(file)
  }
  if (fromItems.length) return applyAttachmentLimits(uniqueFiles(fromItems))
  return applyAttachmentLimits(uniqueFiles(Array.from(data.files ?? []).filter(isImageFile)))
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
