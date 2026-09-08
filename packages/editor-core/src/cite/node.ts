import { $node } from '@milkdown/utils'

export interface CiteAttrs {
  key: string
}

export function citeToMarkdown(key: string): string {
  return `[@${key}]`
}

export const cite = $node('cite', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: { key: { default: '' } },
  parseDOM: [{ tag: 'cite[data-cite-key]' }],
  toDOM: (node) => {
    const el = document.createElement('cite')
    el.setAttribute('data-cite-key', String(node.attrs.key))
    el.textContent = citeToMarkdown(String(node.attrs.key))
    return el
  },
  parseMarkdown: {
    match: (n) => n.type === 'nekoCite' && typeof n.value === 'string',
    runner: (state, node, type) => {
      const key = String(node.value ?? '')
        .replace(/^\[@/, '')
        .replace(/\]$/, '')
      state.addNode(type, { key })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'cite',
    runner: (state, node) => {
      state.addNode('html', undefined, citeToMarkdown(String(node.attrs.key ?? '')))
    },
  },
}))
