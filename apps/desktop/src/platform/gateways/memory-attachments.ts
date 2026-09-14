/**
 * The memory fs's attachment area: where pasted or picked image bytes land, and
 * how a vault-relative key becomes a URL the webview can render.
 *
 * Stored in the same key space as notes (`files`) *and* in the attachment
 * index, because the two are read differently: `list()`'s virtual-directory
 * derivation surfaces the attachments tree for free from `files`, while the
 * index is what `resolveMediaPath` may serve and what `renameEntry` moves as a
 * unit. A key in `files` that is not in the index is a note, not an image.
 *
 * It takes those maps rather than owning them: trash, history and rename all
 * operate on the same vault, so the maps belong to the gateway that composes
 * this area with them.
 *
 * Saving and importing are one path with two front doors — both end at
 * `store()` — because they differ only in where the bytes come from (a paste
 * payload vs. the demo pick registry) and in how the file is named.
 */

import type { FsPort } from './contracts'
import { pickedFilePayload } from './memory-picked-files'

/** The three {@link FsPort} members this area implements. */
export type AttachmentArea = Pick<
  FsPort,
  'saveAttachment' | 'importAttachment' | 'resolveMediaPath'
>

export interface AttachmentAreaDeps {
  /** Every key in the vault — notes and attachments alike. */
  files: Map<string, string>
  /** Attachment bytes by vault-relative path. */
  attachments: Map<string, string>
  /** Write times, so a stored attachment stats like any other file. */
  modified: Map<string, number>
}

// Inlined from services/attachments so `platform` never depends back on a
// service module (docs/dev.md §5.3 forbids platform → service).
const ATTACHMENT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
}

function mimeFromExtension(extension: string): string {
  return ATTACHMENT_MIME[extension.toLowerCase()] ?? 'application/octet-stream'
}

function attachmentMonthDir(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function createAttachmentArea(deps: AttachmentAreaDeps): AttachmentArea {
  /** Put `payload` in the vault under `dir` (or the legacy `attachments/{YYYY-MM}`
   *  layout when none is given), returning the vault-relative path. An existing
   *  name is never overwritten: the first free `-N` suffix wins, so importing the
   *  same file twice keeps both copies — the same rule the Rust command applies. */
  function store(dir: string | undefined, fileName: string, payload: string): string {
    const cleanDir = dir && dir.trim() ? dir.trim().replace(/^\/+|\/+$/g, '') : ''
    const targetDir = cleanDir || `attachments/${attachmentMonthDir()}`
    const dot = fileName.lastIndexOf('.')
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName
    const ext = dot > 0 ? fileName.slice(dot) : ''
    let relPath = `${targetDir}/${fileName}`
    let n = 0
    while (deps.files.has(relPath) || deps.attachments.has(relPath)) {
      n += 1
      relPath = `${targetDir}/${stem}-${n}${ext}`
    }
    deps.files.set(relPath, payload)
    deps.attachments.set(relPath, payload)
    deps.modified.set(relPath, Date.now())
    return relPath
  }

  return {
    saveAttachment: async (_vault, fileName, base64, dir) => store(dir, fileName, base64),
    // The demo has no real filesystem, so the picked "path" is the file name
    // and the payload is whatever the harness stashed for it. This mirrors the
    // real command's contract (absolute source path in, vault-relative out)
    // closely enough for the UI flow to be exercised in a browser.
    importAttachment: async (_vault, sourcePath, dir) => {
      const name = sourcePath.replace(/\\/g, '/').split('/').pop() ?? ''
      if (!name) throw new Error(`Picked file has no usable name: ${sourcePath}`)
      const payload = pickedFilePayload(sourcePath)
      if (payload === undefined) {
        throw new Error(`No such picked file in demo vault: ${sourcePath}`)
      }
      return store(dir, name, payload)
    },
    resolveMediaPath: async (_vault, relPath) => {
      const base64 = deps.attachments.get(relPath) ?? deps.files.get(relPath)
      if (base64 === undefined) {
        throw new Error(`No such attachment in demo vault: ${relPath}`)
      }
      const ext = relPath.split('.').pop() ?? ''
      return `data:${mimeFromExtension(ext)};base64,${base64}`
    },
  }
}
