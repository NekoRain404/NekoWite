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
  iframe.onload = () => {
    iframe.contentWindow?.focus()
    try {
      iframe.contentWindow?.print()
    } catch {
      iframe.remove()
    }
  }
  setTimeout(() => iframe.remove(), 60000)
}
