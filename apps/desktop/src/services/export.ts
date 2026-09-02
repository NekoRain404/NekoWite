import { renderDocument, type ExportRef, type RenderDocumentOptions } from '@nekowite/editor-core'
import { fsService } from './fs'
import { buildComponentRenderers } from './exportRenderers'

export { buildComponentRenderers }

export interface ExportUiOptions {
  title?: string
  refs?: Map<string, ExportRef>
  math?: 'katex' | 'text'
  savePath?: string
}

function toRenderOptions(opts: ExportUiOptions): RenderDocumentOptions {
  return {
    title: opts.title,
    refs: opts.refs,
    componentRenderers: buildComponentRenderers(),
    math: opts.math,
    includeCss: true,
  }
}

export async function exportHtml(source: string, vault: string, savePath: string, opts: ExportUiOptions): Promise<void> {
  const html = renderDocument(source, toRenderOptions(opts))
  await fsService.write(vault, savePath, html)
}

export function exportToPdf(source: string, opts: ExportUiOptions): void {
  if (typeof document === 'undefined') return
  const html = renderDocument(source, toRenderOptions(opts))
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
