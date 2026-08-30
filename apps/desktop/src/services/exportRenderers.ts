import type { ComponentRenderer } from '@nekowite/editor-core'

export function buildComponentRenderers(): Record<string, ComponentRenderer> {
  return {
    Callout: (props, childrenHtml) =>
      `<aside class="callout callout-${props.type ?? 'info'}"><div class="callout-body">${childrenHtml}</div></aside>`,
  }
}
