import { imageSchema } from '@milkdown/preset-commonmark'

export interface ImageDimAttrs {
  width: number | null
  height: number | null
  align: 'left' | 'center' | 'right' | null
}

/** Serialize image dimension attrs into a trailing `{width=300 align=center}`
 * block. `height` is emitted second when present, but a width-only resize (the
 * common case) still produces the legacy `{width=300}` / `{width=300 align=center}`
 * byte sequence — round-trip fidelity for existing docs is preserved. */
export function imageDimMarkdown(
  width: number | null,
  align: string | null,
  height: number | null = null,
): string {
  if (width == null && !align && height == null) return ''
  let out = '{'
  let first = true
  if (width != null && Number.isFinite(width)) {
    out += `width=${width}`
    first = false
  }
  if (height != null && Number.isFinite(height)) {
    if (!first) out += ' '
    out += `height=${height}`
    first = false
  }
  if (align) {
    if (!first) out += ' '
    out += `align=${align}`
  }
  return `${out}}`
}

export const imageDimSchema = imageSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    attrs: {
      ...base.attrs,
      width: { default: null, validate: 'number|null' },
      height: { default: null, validate: 'number|null' },
      align: { default: null, validate: 'string|null' },
    },
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (dom: HTMLElement) => {
          const width = Number(dom.getAttribute('data-width'))
          const height = Number(dom.getAttribute('data-height'))
          return {
            src: dom.getAttribute('src') || '',
            alt: dom.getAttribute('alt') || '',
            title: dom.getAttribute('title') || dom.getAttribute('alt') || '',
            width: Number.isFinite(width) && width > 0 ? width : null,
            height: Number.isFinite(height) && height > 0 ? height : null,
            align: dom.getAttribute('data-align') || null,
          }
        },
      },
    ],
    toDOM: (node) => {
      const { width, height, align, ...rest } = node.attrs
      const attrs: Record<string, string> = { ...rest }
      if (width != null && Number.isFinite(width)) attrs['data-width'] = String(width)
      if (height != null && Number.isFinite(height)) attrs['data-height'] = String(height)
      if (align) attrs['data-align'] = String(align)
      return ['img', attrs]
    },
    parseMarkdown: {
      match: ({ type }) => type === 'image',
      runner: (state, node, type) => {
        state.addNode(type, {
          src: String(node.url ?? ''),
          alt: String(node.alt ?? ''),
          title: String(node.title ?? ''),
          width: (node as { width?: number }).width ?? null,
          height: (node as { height?: number }).height ?? null,
          align: (node as { imageAlign?: string }).imageAlign ?? null,
        })
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === 'image',
      runner: (state, node) => {
        const width = node.attrs.width ?? null
        const height = node.attrs.height ?? null
        const align = node.attrs.align ?? null
        state.addNode('image', undefined, undefined, {
          title: node.attrs.title,
          url: node.attrs.src,
          alt: node.attrs.alt,
        })
        const dims = imageDimMarkdown(width, align, height)
        if (dims) state.addNode('html', undefined, dims)
      },
    },
  }
})
