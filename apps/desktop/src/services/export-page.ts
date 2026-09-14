/**
 * The page: paper size, orientation and margin, and the CSS they produce.
 *
 * One module because these three are one decision. `@page` takes them in a
 * single rule, the preview has to know the same numbers to draw a page
 * boundary, and the two must not be computed twice or they will disagree —
 * a preview whose page line sits 4mm away from the printer's is worse than no
 * preview. So the numbers live here and every consumer reads them.
 *
 * The unit is the millimetre, everywhere. `@page` accepts `mm`, `cm` and `in`,
 * and a user reading the wrong convention's numbers is a defect nobody
 * reports: a paper size is quoted in mm in the ISO system and in inches in the
 * US one, so a single stored number plus one displayed unit is the only way the
 * label and the output cannot drift. CSS pixels are derived, never stored.
 */

/** The paper sizes offered. `@page { size: … }` accepts all five natively. */
export const EXPORT_PAGE_SIZES = ['A3', 'A4', 'A5', 'Letter', 'Legal'] as const
export type ExportPageSize = (typeof EXPORT_PAGE_SIZES)[number]

export type ExportOrientation = 'portrait' | 'landscape'

/** CSS pixels per millimetre at 96 dpi — the ratio `@page` and CSS lengths use. */
export const PX_PER_MM = 96 / 25.4

/** The printable area's margin, in millimetres, uniform on all four sides.
 *
 * It replaces a literal that was doing this job by accident: the old rule was
 * `@page{margin:1cm}` on top of the exported document's own `body{padding:2rem}`,
 * so the paper margin a user saw was 10mm + 8.47mm = 18.47mm and there was no
 * way to change either. 20mm is that number rounded to the conventional one. */
export const EXPORT_MARGIN_MM_DEFAULT = 20
export const EXPORT_MARGIN_MM_MIN = 0
export const EXPORT_MARGIN_MM_MAX = 50

/** Portraits, in millimetres: the size as it is quoted. Landscape swaps them. */
const PAPER_MM: Record<ExportPageSize, { width: number; height: number }> = {
  A3: { width: 297, height: 420 },
  A4: { width: 210, height: 297 },
  A5: { width: 148, height: 210 },
  Letter: { width: 215.9, height: 279.4 },
  Legal: { width: 215.9, height: 355.6 },
}

export interface PageBox {
  /** The whole sheet, borders included, in CSS pixels. */
  width: number
  height: number
  /** What is left for the document once the margin is taken off, in CSS pixels. */
  contentWidth: number
  contentHeight: number
}

export function pageSizeMm(size: ExportPageSize): { width: number; height: number } {
  return PAPER_MM[size]
}

/** Clamp rather than reject: a stored value outside the range came from an
 *  older build or a hand-edited store, and a whole export failing over a
 *  margin is a worse outcome than that margin being clamped. */
export function clampMarginMm(mm: number): number {
  if (!Number.isFinite(mm)) return EXPORT_MARGIN_MM_DEFAULT
  return Math.min(EXPORT_MARGIN_MM_MAX, Math.max(EXPORT_MARGIN_MM_MIN, mm))
}

/** The sheet and its content box in CSS pixels, for a given scale.
 *  Landscape is the portrait size with the two sides exchanged, which is what
 *  `@page { size: A4 landscape }` does — the paper is not re-quoted. */
export function pageBox(
  size: ExportPageSize,
  orientation: ExportOrientation,
  marginMm: number,
  scale = 1,
): PageBox {
  const portrait = PAPER_MM[size]
  const width = (orientation === 'landscape' ? portrait.height : portrait.width) * PX_PER_MM * scale
  const height = (orientation === 'landscape' ? portrait.width : portrait.height) * PX_PER_MM * scale
  const margin = clampMarginMm(marginMm) * PX_PER_MM * scale
  // A margin wider than half the sheet would make the content box negative and
  // the page boundary arithmetic nonsense; the document then has no content box
  // and the page still draws.
  return {
    width,
    height,
    contentWidth: Math.max(0, width - 2 * margin),
    contentHeight: Math.max(0, height - 2 * margin),
  }
}

/**
 * The rule that turns the settings into a printed page.
 *
 * `body` is reset here because the renderer's own stylesheet sizes the document
 * for a browser window (`max-width: 50rem; margin: 0 auto; padding: 2rem`) and
 * those two rules *stack* with the paper margin instead of replacing it. On
 * paper the page margin is the margin, so the window chrome has to come off or
 * the number the user chose is not the number they get.
 */
export function exportPageCss(
  size: ExportPageSize,
  orientation: ExportOrientation,
  marginMm: number,
): string {
  const margin = clampMarginMm(marginMm)
  return (
    `@page{size:${size} ${orientation};margin:${margin}mm;}` +
    `body{margin:0;padding:0;max-width:none;}`
  )
}

/** Put `css` at the END of the document's `<head>`, after the renderer's own
 *  `<style>`, so the `body` reset above wins on equal specificity without
 *  `!important`. Falls back to prefixing the document when there is no head to
 *  insert into. */
export function injectExportPageCss(html: string, css: string): string {
  const style = `<style data-neko-export-page>${css}</style>`
  const idx = html.indexOf('</head>')
  if (idx === -1) return style + html
  return html.slice(0, idx) + style + html.slice(idx)
}
