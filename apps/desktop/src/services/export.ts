import type { ExportImageTarget, ExportRef, RenderDocumentOptions } from '@nekowite/editor-core'
import { fsService } from '../platform/gateways/fs'
import { buildComponentRenderers } from './exportRenderers'
import { createImageSrcResolver } from './attachments'
import { splitFrontmatterRaw } from './noteMeta'
import { useTabsStore } from '../stores/tabs'
import { useSettingsStore } from '../stores/settings'
import type { ExportPdfPageSize, ExportPdfOrientation } from '../stores/settings'

export { buildComponentRenderers }

// The export implementation pulls in KaTeX (and the remark/cite parsing
// pipeline behind it) purely to render markdown to HTML/PDF, which only
// happens on explicit user export. Loading it on demand keeps the editor's
// startup bundle free of that ~1MB of math machinery.
async function renderDocumentAsync(
  markdown: string,
  opts?: RenderDocumentOptions,
): Promise<string> {
  const mod = await import('@nekowite/editor-core')
  return mod.renderDocumentAsync(markdown, opts)
}

export interface ExportUiOptions {
  title?: string
  refs?: Map<string, ExportRef>
  math?: 'katex' | 'text'
  savePath?: string
  /** Vault-relative path of the exported note; defaults to the active tab. */
  notePath?: string | null
}

function storeContext(): { getVault(): string | null; getNotePath(): string | null } {
  // The tabs store is read lazily per resolution so exports always see the
  // live vault/note, and contexts without an active pinia (tests) degrade.
  try {
    const tabs = useTabsStore()
    return {
      getVault: () => tabs.vault,
      getNotePath: () => tabs.activeTab?.path ?? null,
    }
  } catch {
    return { getVault: () => null, getNotePath: () => null }
  }
}

/** Read export params from the settings store, degrading to defaults outside
 * an active pinia (the export pipeline is also exercised by unit tests). */
function exportSettings(): {
  includeFrontmatter: boolean
  pageSize: ExportPdfPageSize
  orientation: ExportPdfOrientation
} {
  try {
    const settings = useSettingsStore()
    return {
      includeFrontmatter: settings.exportIncludeFrontmatter,
      pageSize: settings.exportPdfPageSize,
      orientation: settings.exportPdfOrientation,
    }
  } catch {
    return { includeFrontmatter: true, pageSize: 'A4', orientation: 'portrait' }
  }
}

/** Strip the YAML frontmatter block when the export should not include it. */
function prepareSource(source: string, includeFrontmatter: boolean): string {
  if (includeFrontmatter) return source
  return splitFrontmatterRaw(source).body
}

/** Add a print `@page` rule so the browser print dialog honors the configured
 * paper size and orientation for the PDF export. */
function injectPdfPageCss(
  html: string,
  size: ExportPdfPageSize,
  orientation: ExportPdfOrientation,
): string {
  const rule = `@page{size:${size} ${orientation};margin:1cm;}`
  const style = `<style>${rule}</style>`
  const idx = html.indexOf('</head>')
  if (idx === -1) return style + html
  return html.slice(0, idx) + style + html.slice(idx)
}

/**
 * `imageSrcTarget` is per destination: a saved .html has to be self-contained
 * (data URLs), while the in-app print/PDF path renders through the asset
 * protocol and keeps the cheap display URL.
 */
function toRenderOptions(
  opts: ExportUiOptions,
  imageSrcTarget: ExportImageTarget = 'display',
): RenderDocumentOptions {
  const ctx = storeContext()
  return {
    title: opts.title,
    refs: opts.refs,
    componentRenderers: buildComponentRenderers(),
    math: opts.math,
    includeCss: true,
    imageSrcTarget,
    resolveImage: createImageSrcResolver(fsService, {
      getVault: ctx.getVault,
      getNotePath: () => opts.notePath ?? ctx.getNotePath(),
    }),
  }
}

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

export async function exportToPdf(source: string, opts: ExportUiOptions): Promise<void> {
  if (typeof document === 'undefined') return
  const { includeFrontmatter, pageSize, orientation } = exportSettings()
  const html = await renderDocumentAsync(prepareSource(source, includeFrontmatter), toRenderOptions(opts))
  const iframe = document.createElement('iframe')
  iframe.style.display = 'none'
  iframe.srcdoc = injectPdfPageCss(html, pageSize, orientation)
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
