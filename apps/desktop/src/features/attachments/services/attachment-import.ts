import { MAX_IMAGES_PER_MESSAGE } from '../../../stores/chatSession'
import { notifyError } from '../../../services/errors'
import { isImageFile } from './attachment-paths'

/**
 * Attachment intake: the frontend limits enforced BEFORE any base64 encode or
 * IPC, the classification/planning that decides what a paste, drop or pick may
 * bring into the vault, the clipboard extraction that feeds them, and the
 * message the user gets about whatever was refused.
 *
 * Nothing here reads image bytes or touches the filesystem — the media reads
 * live in `attachment-library.ts` and the path/name grammar in
 * `attachment-paths.ts`.
 */

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

/** Images allowed in ONE chat message.
 *
 *  The chat panel keeps its attachments in memory and base64-encodes all of
 *  them into a single request, so the batch cap alone is not enough: a user can
 *  add images one at a time and reach any count.
 *
 *  This is the SESSION's limit, not a second opinion: a message may carry only
 *  as many images as the store will keep for it. Letting the composer accept
 *  more meant the extra ones vanished from the conversation at send time (the
 *  store trims the list) with nothing on screen to say which. */
export const MAX_ATTACHMENTS_PER_MESSAGE = MAX_IMAGES_PER_MESSAGE

/** Total bytes one chat message may carry. The count cap is not a size cap:
 *  images are added one at a time, so six of them can each sit just under
 *  {@link MAX_ATTACHMENT_BYTES} - 60 MiB raw, which the send path base64-encodes
 *  (~4/3 the size) into ONE IPC request whose text is held by both processes.
 *  20 MiB raw is already ~27 MB of JSON per turn; past that the request is
 *  refused by the provider, and the renderer pays for the encode first. */
export const MAX_ATTACHMENTS_PER_MESSAGE_BYTES = 20 * 1024 * 1024 // 20 MiB
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
 *  a pasted image would prefer a path-based import over base64.
 *
 *  NOT enforced today: only the image PICKER has real filesystem paths, and it
 *  already uses `import_attachment` at every size. A pasted clipboard image has
 *  no path, so the paste path always base64-encodes. See
 *  {@link STREAM_IMPORT_BACKEND_COMMAND}. */
export const STREAM_IMPORT_MIN_BYTES = 8 * 1024 * 1024 // 8 MiB

/**
 * The backend command that copies a file the user picked, with no base64 hop:
 *
 *   import_attachment(vault: string, src_abs_path: string, dir?: string)
 *     -> Promise<string>   // the vault-relative path written
 *
 * It IS implemented (`storage::file_store::import_attachment` plus the
 * `import_attachment` command) and is what the image picker uses, so a
 * file-picked image never becomes base64 in JS at all.
 *
 * The PASTE path still goes through `saveAttachment` (base64 over IPC): the
 * clipboard hands the webview `File` objects, not filesystem paths, so there is
 * no path for a path-based command to read. The constants below only describe
 * that paste path.
 */
export const STREAM_IMPORT_BACKEND_COMMAND =
  'import_attachment(vault, src_abs_path, dir?) → Promise<string>'

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
  // The batch byte cap needs nothing but the file sizes, so it is enforced here
  // rather than only in the context-aware policy. Without it a drop of ten
  // near-limit images passes the count check and then base64-encodes ~133 MB
  // into JS memory at once.
  let acceptedBytes = 0
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
    if (acceptedBytes + file.size > MAX_ATTACHMENTS_PER_BATCH_BYTES) {
      rejected.push({ file, reason: 'batch-total' })
      continue
    }
    accepted.push(file)
    acceptedBytes += file.size
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
 * The paste path calls this WITHOUT a context (a clipboard image has no
 * filesystem path, so there is nothing to stat), so the guarantees there are:
 * per-file size, per-batch count, per-batch BYTES and the per-session count.
 * The per-vault total and the free-disk guard need backend data and are only
 * applied by `planAttachmentImport` when a context is supplied — no production
 * caller does that today, so treat those two as unenforced.
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
