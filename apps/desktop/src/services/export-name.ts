/** How an export is named, and what its extension is.
 *
 * The extension lives here rather than at each call site because the format is
 * what decides it, and a call site that concatenates its own is a call site
 * that can drift from the bytes: a `.png` holding JPEG data — or the reverse —
 * opens in this app and fails in the next one, which is the kind of defect the
 * user finds days later in a different program. `IMAGE_MIME` in
 * `export-image.ts` is the other half of the pair, and the two are keyed by the
 * same format name so a mismatch is a type error rather than a runtime one.
 */
import type { ExportImageFormat } from './export-image'

export type ExportFileFormat = 'html' | 'pdf' | 'txt' | 'csv' | ExportImageFormat

/** The format the user is exporting as, and the extension that follows from it.
 *  `jpeg` encodes as `.jpg`: the user asked for JPG, and both spellings open
 *  everywhere, so the one to write is the one to say. */
export const EXPORT_EXTENSIONS: Record<ExportFileFormat, string> = {
  html: 'html',
  pdf: 'pdf',
  txt: 'txt',
  csv: 'csv',
  png: 'png',
  jpeg: 'jpg',
}

export function exportBaseName(path: string | null | undefined): string {
  if (!path) return 'untitled'
  const base = path.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.[^.]+$/, '') || 'untitled'
}

/** The default file name offered in the save dialog for a note and a format. */
export function exportFileName(path: string | null | undefined, format: ExportFileFormat): string {
  return `${exportBaseName(path)}.${EXPORT_EXTENSIONS[format]}`
}

/**
 * Force `path`'s extension to the one `format` encodes as, whatever the save
 * dialog returned.
 *
 * The name offered in the dialog is already right, but the dialog is a text
 * field: a user who types `note.png` while JPEG is selected would otherwise get
 * a `.png` holding JPEG bytes — a file that opens here, opens as a broken image
 * in the next program, and is found days later in a different application. The
 * bytes and the extension are decided by the same format, so they cannot
 * disagree.
 */
export function forceExportExtension(path: string, format: ExportFileFormat): string {
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dir = sep === -1 ? '' : path.slice(0, sep + 1)
  const base = (sep === -1 ? path : path.slice(sep + 1)).replace(/\.[^.]*$/, '')
  return `${dir}${base || 'untitled'}.${EXPORT_EXTENSIONS[format]}`
}
