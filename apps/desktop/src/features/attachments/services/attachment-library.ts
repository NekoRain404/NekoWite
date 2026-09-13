import type { ExportImageTarget } from '@nekowite/editor-core'
import { baseName } from '../../../services/paths'
import { fsService } from '../../../platform/gateways/fs'
import type { FileEntry, FsGateway } from '../../../platform/gateways/contracts'
import { t } from '../../../i18n'
import { MAX_ATTACHMENT_BYTES, formatAttachmentBytes } from './attachment-import'
import {
  ATTACHMENTS_DIR,
  extensionFromFileName,
  vaultRelativeFromNoteVault,
} from './attachment-paths'

/**
 * Attachment media reads and the vault attachment library.
 *
 * Two of §4's four concerns live in this one module because §3 gives the
 * feature three service files, and both of them read:
 *
 *   - media reads: a Blob as base64 for the IPC write (`fileToBase64`, the
 *     path the paste and chat intakes take) and an attachment src resolved to
 *     the `asset://` URL the app renders or the inlined `data:` URL an exported
 *     .html needs (`createImageSrcResolver`);
 *   - the library: recursive listing of the vault's `attachments/` tree
 *     (images only, newest first) plus the small formatting helpers the panel
 *     uses for size / relative-time captions, and deletion of an entry.
 *
 * `attachment-paths.ts` owns the path grammar and `attachment-import.ts` the
 * intake limits; neither of those reads bytes or touches a gateway.
 */

export interface AttachmentItem {
  path: string
  name: string
  size: number
  mtime: number
}

async function collectImagePaths(
  fs: FsGateway,
  vault: string,
  dir: string,
  out: string[],
): Promise<void> {
  let entries: FileEntry[]
  try {
    entries = await fs.list(vault, dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.is_dir) {
      if (entry.name.startsWith('.')) continue
      await collectImagePaths(fs, vault, entry.path, out)
    } else if (extensionFromFileName(entry.name) && !entry.name.startsWith('.')) {
      out.push(entry.path)
    }
  }
}

/** Every image under `<vault>/attachments/`, deepest month subdirs included,
 * sorted by mtime descending (newest first; ties fall back to path order).
 * Directories that fail to list are tolerated; files that vanish between
 * list and stat are skipped. */
export async function loadAttachmentLibrary(
  vault: string,
  fs: FsGateway = fsService,
): Promise<AttachmentItem[]> {
  const paths: string[] = []
  await collectImagePaths(fs, vault, ATTACHMENTS_DIR, paths)
  const items: AttachmentItem[] = []
  for (const path of paths) {
    try {
      const { size, mtime } = await fs.stat(vault, path)
      // Native paths (backslash-separated on Windows): a '/' split returned the
      // whole path as the name, which the panel then displayed and previewed.
      items.push({ path, name: baseName(path) || path, size, mtime })
    } catch {
      // The listing already aged; a stat miss just drops the entry.
    }
  }
  items.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
  return items
}

/** Move an attachment to the gateway trash. */
export async function deleteAttachment(
  vault: string,
  path: string,
  fs: FsGateway = fsService,
): Promise<void> {
  await fs.deleteFile(vault, path)
}

const KB = 1024
const MB = 1024 * KB
const GB = 1024 * MB

/** Human-readable byte size: `832 B`, `9.5 KB`, `42 KB`, `1.2 MB`, `3.4 GB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < KB) return `${Math.round(bytes)} B`
  if (bytes < MB) {
    const kb = bytes / KB
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  }
  if (bytes < GB) {
    const mb = bytes / MB
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  }
  return `${(bytes / GB).toFixed(1)} GB`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Compact relative time localised via `t()`: 刚刚 / N 分钟前 / N 小时前 / N 天前, then a
 * `YYYY-MM-DD` date. Zero/invalid mtimes (unknown) degrade gracefully. */
export function formatRelativeTime(mtime: number, now = Date.now()): string {
  if (!Number.isFinite(mtime) || mtime <= 0) return t('time.unknown')
  const delta = now - mtime
  if (delta < MINUTE) return t('time.justNow')
  if (delta < HOUR) return t('time.minutesAgo', { n: Math.floor(delta / MINUTE) })
  if (delta < DAY) return t('time.hoursAgo', { n: Math.floor(delta / HOUR) })
  if (delta < 7 * DAY) return t('time.daysAgo', { n: Math.floor(delta / DAY) })
  const d = new Date(mtime)
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
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

export interface ImageSrcResolverContext {
  getVault(): string | null
  getNotePath(): string | null
}

/** Build the display-URL resolver handed to the editor / export pipeline.
 *
 * Throws when the src cannot be turned into a display URL. That is deliberate:
 * returning the src unchanged would look like a successful resolution to the
 * caller, so a "no vault open yet" pass-through used to be memoized as if it
 * were the answer and the image stayed broken even after the vault arrived.
 * Failing lets the caller keep its own fallback and retry later. */
export function createImageSrcResolver(
  fs: Pick<FsGateway, 'resolveMediaPath'>,
  ctx: ImageSrcResolverContext,
): (src: string, target?: ExportImageTarget) => Promise<string> {
  return async (src, target = 'display') => {
    const vault = ctx.getVault()
    if (!vault) throw new Error('no vault open, cannot resolve an attachment path')
    const rel = vaultRelativeFromNoteVault(ctx.getNotePath() ?? '', vault, src)
    const url = await fs.resolveMediaPath(vault, rel)
    // `display` is the asset:// URL the app can render. A saved .html has to
    // work when opened anywhere, so the bytes are inlined instead — the same
    // reason the exported stylesheet inlines its fonts.
    if (target !== 'data' || url.startsWith('data:')) return url
    const response = await fetch(url)
    if (!response.ok) throw new Error(`attachment could not be read for export (${response.status})`)
    const blob = await response.blob()
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error ?? new Error('attachment could not be inlined'))
      reader.readAsDataURL(blob)
    })
  }
}
