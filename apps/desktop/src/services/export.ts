import type { ExportRef, RenderDocumentOptions } from '@nekowite/editor-core'
import { fsService } from './fs'
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

function toRenderOptions(opts: ExportUiOptions): RenderDocumentOptions {
  const ctx = storeContext()
  return {
    title: opts.title,
    refs: opts.refs,
    componentRenderers: buildComponentRenderers(),
    math: opts.math,
    includeCss: true,
    resolveImage: createImageSrcResolver(fsService, {
      getVault: ctx.getVault,
      getNotePath: () => opts.notePath ?? ctx.getNotePath(),
    }),
  }
}

export async function exportHtml(source: string, vault: string, savePath: string, opts: ExportUiOptions): Promise<void> {
  const { includeFrontmatter } = exportSettings()
  const html = await renderDocumentAsync(prepareSource(source, includeFrontmatter), toRenderOptions(opts))
  await fsService.write(vault, savePath, html)
}

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

  // Safety net: never leave a hidden export iframe attached longer than this,
  // even if onload never fires (e.g. srcdoc failed to load).
  cleanupTimer = setTimeout(cleanup, 60000)

  iframe.onload = () => {
    iframe.contentWindow?.focus()
    try {
      iframe.contentWindow?.print()
    } catch {
      // print failures are not actionable; cleanup below still runs.
    } finally {
      // window.print() blocks while the print dialog is open in the target
      // desktop webviews, so this point is only reached once the print flow
      // has finished; remove the iframe promptly and cancel the fallback.
      cleanup()
    }
  }
}
