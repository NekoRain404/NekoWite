/**
 * The export subject of the settings store: frontmatter, page size,
 * orientation, margin, and the long image's format and quality.
 *
 * One writer reads this and nothing else — the export pipeline — which is why
 * it is a file of its own rather than a corner of the AI settings.
 *
 * `createExportSettings()` is invoked by the store in `stores/settings.ts`,
 * which is the public API; import this module only to reach a constant or a
 * type.
 */

import { ref, watch } from 'vue'
import { persistence } from '../services/persistence'
import { EXPORT_MARGIN_MM_DEFAULT, clampMarginMm } from '../services/export-page'
import { readBool, readEnum, readNumber } from './settings-persist'

/** Paper sizes the office-format export offers. Wider than it was — A4 and
 *  Letter were the only two — but still a closed list: `@page{size:…}` accepts
 *  these five natively, and a free-text field would let a typo through to the
 *  print dialog as a silently ignored rule. */
export type ExportPdfPageSize = 'A3' | 'A4' | 'A5' | 'Letter' | 'Legal'
export type ExportPdfOrientation = 'portrait' | 'landscape'
/** The long image's format. WebP is deliberately absent: this webview's canvas
 *  cannot encode it — `toDataURL('image/webp')` answers with a PNG — so
 *  offering it would write a PNG under a `.webp` name. */
export type ExportImageFormat = 'png' | 'jpeg'

const LS_EXPORT_FRONTMATTER = 'nekowite.settings.exportFrontmatter'
const LS_EXPORT_PDF_PAGE = 'nekowite.settings.exportPageSize'
const LS_EXPORT_PDF_ORIENT = 'nekowite.settings.exportOrientation'
const LS_EXPORT_MARGIN_MM = 'nekowite.settings.exportMarginMm'
const LS_EXPORT_IMAGE_FORMAT = 'nekowite.settings.exportImageFormat'
const LS_EXPORT_IMAGE_QUALITY = 'nekowite.settings.exportImageQuality'

/** JPEG's quality knob. The bounds are the ones the encoder is worth using
 *  inside: below 0.5 a page of 16px text is visibly soft, and 1.0 disables the
 *  quantisation that is the only reason to choose JPEG over PNG at all — for a
 *  document image it is both larger and worse than the PNG. */
export const EXPORT_JPEG_QUALITY_MIN = 0.5
export const EXPORT_JPEG_QUALITY_MAX = 1
/** The default is the one the format's own documentation uses for "visually
 *  indistinguishable", and it is a compromise rather than a preference: a long
 *  image of a text note is legible at 0.8 and enormous at 1.0, and the user can
 *  see the size it produces next to the control before they commit to it. */
export const EXPORT_JPEG_QUALITY_DEFAULT = 0.92

function readQuality(key: string): number {
  const n = readNumber(key, EXPORT_JPEG_QUALITY_DEFAULT)
  return Math.min(EXPORT_JPEG_QUALITY_MAX, Math.max(EXPORT_JPEG_QUALITY_MIN, n))
}

export function createExportSettings() {
  const exportIncludeFrontmatter = ref<boolean>(readBool(LS_EXPORT_FRONTMATTER, true))
  // The values array is the widened one, but an install that stored 'A4' or
  // 'Letter' before still reads back its own choice — the union grew, the two
  // spellings it already held did not change.
  const exportPdfPageSize = ref<ExportPdfPageSize>(
    readEnum(LS_EXPORT_PDF_PAGE, ['A3', 'A4', 'A5', 'Letter', 'Legal'], 'A4'),
  )
  const exportPdfOrientation = ref<ExportPdfOrientation>(readEnum(LS_EXPORT_PDF_ORIENT, ['portrait', 'landscape'], 'portrait'))
  // The paper margin, in millimetres, uniform on all four sides. See
  // `services/export-page.ts` for why one number and why millimetres.
  const exportMarginMm = ref<number>(clampMarginMm(readNumber(LS_EXPORT_MARGIN_MM, EXPORT_MARGIN_MM_DEFAULT)))
  const exportImageFormat = ref<ExportImageFormat>(readEnum(LS_EXPORT_IMAGE_FORMAT, ['png', 'jpeg'], 'png'))
  const exportImageQuality = ref<number>(readQuality(LS_EXPORT_IMAGE_QUALITY))

  watch(exportIncludeFrontmatter, (v) => persistence.set(LS_EXPORT_FRONTMATTER, String(v)))
  watch(exportPdfPageSize, (v) => persistence.set(LS_EXPORT_PDF_PAGE, v))
  watch(exportPdfOrientation, (v) => persistence.set(LS_EXPORT_PDF_ORIENT, v))
  watch(exportMarginMm, (v) => persistence.set(LS_EXPORT_MARGIN_MM, String(clampMarginMm(v))))
  watch(exportImageFormat, (v) => persistence.set(LS_EXPORT_IMAGE_FORMAT, v))
  watch(exportImageQuality, (v) => persistence.set(LS_EXPORT_IMAGE_QUALITY, String(v)))

  return {
    exportIncludeFrontmatter,
    exportPdfPageSize,
    exportPdfOrientation,
    exportMarginMm,
    exportImageFormat,
    exportImageQuality,
  }
}
