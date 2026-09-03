import { imageSchema } from '@milkdown/preset-commonmark'

export interface ImageDimAttrs {
  width: number | null
  align: 'left' | 'center' | 'right' | null
}

/** Serialize image dimension attrs into a trailing `{width=300 align=center}` block. */
export function imageDimMarkdown(width: number | null, align: string | null): string {
  if (width == null && !align) return ''
  let out = '{'
  let first = true
  if (width != null && Number.isFinite(width)) {
    out += `width=${width}`
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
      align: { default: null, validate: 'string|null' },
    },
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (dom: HTMLElement) => {
          const width = Number(dom.getAttribute('data-width'))
          return {
            src: dom.getAttribute('src') || '',
            alt: dom.getAttribute('alt') || '',
            title: dom.getAttribute('title') || dom.getAttribute('alt') || '',
            width: Number.isFinite(width) && width > 0 ? width : null,
            align: dom.getAttribute('data-align') || null,
          }
        },
      },
    ],
    toDOM: (node) => {
      const { width, align, ...rest } = node.attrs
      const attrs: Record<string, string> = { ...rest }
      if (width != null && Number.isFinite(width)) attrs['data-width'] = String(width)
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
          align: (node as { imageAlign?: string }).imageAlign ?? null,
        })
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === 'image',
      runner: (state, node) => {
        const width = node.attrs.width ?? null
        const align = node.attrs.align ?? null
        state.addNode('image', undefined, undefined, {
          title: node.attrs.title,
          url: node.attrs.src,
          alt: node.attrs.alt,
        })
        const dims = imageDimMarkdown(width, align)
        if (dims) state.addNode('html', undefined, dims)
      },
    },
  }
})
