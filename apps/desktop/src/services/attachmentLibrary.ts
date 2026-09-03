import { ATTACHMENTS_DIR, extensionFromFileName } from './attachments'
import { fsService } from './fs'
import type { FileEntry, FsGateway } from './gateways/contracts'

/**
 * Attachment library: recursive listing of the vault's `attachments/` tree
 * (images only, newest first) plus the small formatting helpers the panel
 * uses for size / relative-time captions.
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
      items.push({ path, name: path.split('/').pop() ?? path, size, mtime })
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

/** Compact Chinese relative time: 刚刚 / N 分钟前 / N 小时前 / N 天前, then a
 * `YYYY-MM-DD` date. Zero/invalid mtimes (unknown) degrade gracefully. */
export function formatRelativeTime(mtime: number, now = Date.now()): string {
  if (!Number.isFinite(mtime) || mtime <= 0) return '未知时间'
  const delta = now - mtime
  if (delta < MINUTE) return '刚刚'
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} 分钟前`
  if (delta < DAY) return `${Math.floor(delta / HOUR)} 小时前`
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)} 天前`
  const d = new Date(mtime)
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
