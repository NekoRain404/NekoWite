import { $node } from '@milkdown/utils'

export interface WikiLinkAttrs {
  target: string
  alias: string
}

export function wikiLinkToMarkdown(target: string, alias?: string): string {
  return alias ? `[[${target}|${alias}]]` : `[[${target}]]`
}

export const wikilink = $node('wikilink', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: {
    target: { default: '' },
    alias: { default: '' },
  },
  parseDOM: [{ tag: 'span[data-wikilink]' }],
  toDOM: (node) => {
    const el = document.createElement('span')
    el.setAttribute('data-wikilink', '')
    el.setAttribute('data-target', String(node.attrs.target ?? ''))
    el.textContent = String(node.attrs.alias || node.attrs.target || '')
    return el
  },
  parseMarkdown: {
    match: (n) => n.type === 'nekoWikiLink',
    runner: (state, node, type) => {
      state.addNode(type, {
        target: String((node as { target?: string }).target ?? ''),
        alias: String((node as { alias?: string }).alias ?? ''),
      })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'wikilink',
    runner: (state, node) => {
      state.addNode('html', undefined, wikiLinkToMarkdown(String(node.attrs.target ?? ''), String(node.attrs.alias ?? '')))
    },
  },
}))
