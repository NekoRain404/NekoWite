import type { ComponentRenderer } from '@nekowite/editor-core'

// Local attr escaper for interpolating dynamic values into class/attr
// positions. Kept local rather than importing editor-core's private
// escapeHtml so the renderer stays self-contained.
function attrEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;')
}

export function buildComponentRenderers(): Record<string, ComponentRenderer> {
  return {
    Callout: (props, childrenHtml) =>
      `<aside class="callout callout-${attrEscape(props.type ?? 'info')}"><div class="callout-body">${childrenHtml}</div></aside>`,
  }
}
