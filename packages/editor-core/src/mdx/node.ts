import { $node } from '@milkdown/utils'
import type { EditorView } from '@milkdown/prose/view'

import { escapeMdxText } from '../serialize'

export interface MdxComponentAttrs {
  name: string
  props: Record<string, string>
  children: string
}

export const mdxComponent = $node('mdxComponent', () => ({
  group: 'block',
  atom: true,
  attrs: {
    name: { default: 'Component' },
    props: { default: {} as Record<string, string> },
    children: { default: '' },
  },
  parseDOM: [{ tag: 'div[data-mdx-component]' }],
  toDOM: (node) => {
    const { name, children } = node.attrs
    const el = document.createElement('div')
    el.setAttribute('data-mdx-component', name)
    el.textContent = children
    return el
  },
  parseMarkdown: {
    match: (node) =>
      node.type === 'html' &&
      typeof node.value === 'string' &&
      /^<[A-Z][A-Za-z0-9]*/.test(node.value),
    runner: (state, node, type) => {
      const attrs = parseMdxTag(node.value as string)
      state.addNode(type, attrs)
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'mdxComponent',
    runner: (state, node) => {
      const attrs: MdxComponentAttrs = {
        name: node.attrs.name,
        props: node.attrs.props,
        children: node.attrs.children,
      }
      state.addNode('html', undefined, mdxComponentToMarkdown(attrs))
    },
  },
}))

export function mdxComponentToMarkdown(attrs: MdxComponentAttrs): string {
  const { name, props, children } = attrs
  const propStr = Object.entries(props)
    .map(([k, v]) => ` ${k}="${escapeMdxText(v)}"`)
    .join('')
  if (!children) return `<${name}${propStr} />`
  return `<${name}${propStr}>\n\n${children}\n\n</${name}>`
}

export function insertMdxComponent(
  view: EditorView,
  attrs: MdxComponentAttrs
): void {
  const { state } = view
  const node = state.schema.nodes.mdxComponent.create(attrs)
  view.dispatch(state.tr.replaceSelectionWith(node))
}

export function parseMdxTag(html: string): MdxComponentAttrs {
  const tagMatch = /^<([A-Za-z0-9]+)([^>]*?)\/?>/.exec(html)
  const name = tagMatch ? tagMatch[1] : 'Component'
  const props: Record<string, string> = {}
  if (tagMatch) {
    const attrRe = /([A-Za-z0-9_-]+)="([^"]*)"/g
    let match: RegExpExecArray | null
    while ((match = attrRe.exec(tagMatch[2])) !== null) {
      props[match[1]] = match[2]
    }
  }
  const bodyMatch = new RegExp(`<${name}[^>]*>([\\s\\S]*)<\\/${name}>`).exec(html)
  const children = bodyMatch ? bodyMatch[1].trim() : ''
  return { name, props, children }
}
