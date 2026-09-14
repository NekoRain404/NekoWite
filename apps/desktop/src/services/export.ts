/**
 * The exporters, one function per destination.
 *
 * This file is the orchestration only: read the source, render it, hand the
 * bytes to the vault. The pieces that are worth testing on their own live in
 * the siblings — `export-render` (the settings and render options every
 * exporter shares), `export-page` (paper size, orientation, margin and the
 * `@page` rule they produce), `export-image` (the long image),
 * `export-text` (plain text and CSV) and `export-name` (what the file is
 * called). It was 181 lines with two exporters and would have been past the
 * 300-line planning rung with six; splitting now is cheaper than splitting
 * after.
 */
import { fsService } from '../platform/gateways/fs'
import { buildComponentRenderers } from './export-renderers'
import { exportPageCss, injectExportPageCss } from './export-page'
import { IMAGE_MIME, renderHtmlToImage, type ExportImageFormat } from './export-image'
import { htmlTablesToCsv, htmlToPlainText } from './export-text'
import {
  exportSettings,
  prepareSource,
  renderDocumentAsync,
  toRenderOptions,
  type ExportUiOptions,
} from './export-render'

export { buildComponentRenderers }
export type { ExportUiOptions } from './export-render'
export type { ExportImageFormat } from './export-image'
export { EXPORT_EXTENSIONS, exportBaseName, exportFileName } from './export-name'
export type { ExportFileFormat } from './export-name'
export {
  EXPORT_MARGIN_MM_DEFAULT,
  EXPORT_MARGIN_MM_MAX,
  EXPORT_MARGIN_MM_MIN,
  EXPORT_PAGE_SIZES,
  PX_PER_MM,
  exportPageCss,
  pageBox,
  pageSizeMm,
  type ExportOrientation,
  type ExportPageSize,
  type PageBox,
} from './export-page'

export async function exportHtml(source: string, vault: string, savePath: string, opts: ExportUiOptions): Promise<void> {
  const { includeFrontmatter } = exportSettings()
  // A file the user saves has to stand on its own, images included.
  const html = await renderDocumentAsync(
    prepareSource(source, includeFrontmatter),
    toRenderOptions(opts, 'data'),
  )
  await fsService.write(vault, savePath, html)
}

/// How long to wait for the export frame's `srcdoc` to load before giving up
/// on it. Only reached when `onload` never fires.
const LOAD_SAFETY_MS = 60_000

/// How long the export frame may outlive a print that never reported
/// `afterprint`. Generous on purpose: the user may leave the print dialog open,
/// and removing the frame underneath it cancels their print.
const PRINT_BACKSTOP_MS = 300_000

/** The document as the printer should see it: rendered, with the configured
 *  paper size, orientation and margin as its `@page` rule. Shared with the
 *  preview so what the user is shown and what they print are the same bytes. */
export async function renderForPrint(source: string, opts: ExportUiOptions): Promise<string> {
  const { includeFrontmatter, pageSize, orientation, marginMm } = exportSettings()
  const html = await renderDocumentAsync(prepareSource(source, includeFrontmatter), toRenderOptions(opts))
  return injectExportPageCss(html, exportPageCss(pageSize, orientation, marginMm))
}

export async function exportToPdf(source: string, opts: ExportUiOptions): Promise<void> {
  if (typeof document === 'undefined') return
  const html = await renderForPrint(source, opts)
  const iframe = document.createElement('iframe')
  iframe.style.display = 'none'
  iframe.srcdoc = html
  document.body.appendChild(iframe)

  let cleanupTimer: ReturnType<typeof setTimeout> | undefined
  const cleanup = (): void => {
    if (cleanupTimer !== undefined) {
      clearTimeout(cleanupTimer)
      cleanupTimer = undefined
    }
    iframe.remove()
  }

  // Safety net for the case onload never fires at all (a srcdoc that failed to
  // load): never leave a hidden export iframe attached forever.
  cleanupTimer = setTimeout(cleanup, LOAD_SAFETY_MS)

  iframe.onload = () => {
    const win = iframe.contentWindow
    if (!win) {
      cleanup()
      return
    }
    // `window.print()` does NOT block — measured: it returns in ~0 ms and the
    // preview is rendered afterwards. Removing the frame on the next line (what
    // this used to do) therefore detached the document the preview was still
    // reading, and the export silently did nothing. `afterprint` is the real
    // "the user is finished" signal; until it arrives the frame has to stay.
    win.addEventListener('afterprint', cleanup, { once: true })
    win.focus()
    try {
      win.print()
    } catch {
      // A webview that refuses to print at all: there is nothing to wait for.
      cleanup()
      return
    }
    // Backstop for a webview that never fires `afterprint`. It replaces the
    // load-safety timer rather than adding to it, because the user may sit in
    // the print dialog for as long as they like.
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer)
    cleanupTimer = setTimeout(cleanup, PRINT_BACKSTOP_MS)
  }
}

/** Render the document the way the printers do, so every exporter and the
 *  preview agree about what the document is before they disagree about what to
 *  do with it. Only the image path asks for inlined images; the others keep the
 *  cheap display URL. */
async function renderExportDocument(
  source: string,
  opts: ExportUiOptions,
  imageSrcTarget: 'display' | 'data',
): Promise<string> {
  const { includeFrontmatter } = exportSettings()
  return renderDocumentAsync(
    prepareSource(source, includeFrontmatter),
    toRenderOptions(opts, imageSrcTarget),
  )
}

export interface ExportImageResult {
  /** The encoded bytes, base64 — what `saveAttachment` takes, because it is the
   *  vault's only binary write path (`fs.write` takes a string, and a data URL
   *  in a `.png` is not a PNG). */
  base64: string
  /** The MIME actually produced, read back from the data URL rather than
   *  assumed, so the caller can refuse to write JPEG bytes into a `.png`. */
  mime: string
  width: number
  height: number
  /** Encoded size in bytes, so the caller can say how big it came out and
   *  check it against the vault's own limit before shipping it over IPC. */
  bytes: number
}

/** The long image: one picture of the whole document, PNG or JPEG. */
export async function exportImage(
  source: string,
  format: ExportImageFormat,
  quality: number,
  opts: ExportUiOptions,
): Promise<ExportImageResult> {
  const html = await renderExportDocument(source, opts, 'data')
  const image = await renderHtmlToImage(html, format, quality)
  return {
    base64: image.base64,
    mime: image.mime,
    width: image.width,
    height: image.height,
    bytes: base64Bytes(image.base64),
  }
}

function base64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

/** The document as plain text, for pasting where markup is not welcome. */
export async function renderPlainText(source: string, opts: ExportUiOptions): Promise<string> {
  const html = await renderExportDocument(source, opts, 'display')
  return htmlToPlainText(html)
}

/** The document's tables as CSV, or `null` when it has none — writing an empty
 *  file and calling it an export is worse than saying there is nothing to
 *  export. */
export async function renderCsv(source: string, opts: ExportUiOptions): Promise<string | null> {
  const html = await renderExportDocument(source, opts, 'display')
  return htmlTablesToCsv(html)
}

/** The MIME of an image export, so a caller can label what it is about to
 *  write without a second table of formats. */
export function imageMime(format: ExportImageFormat): string {
  return IMAGE_MIME[format]
}
