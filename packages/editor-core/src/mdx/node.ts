import { $node, $view } from '@milkdown/utils'
import type { EditorView, NodeViewConstructor } from '@milkdown/prose/view'
import { createApp, h, type App } from 'vue'

import { escapeMdxText } from '../serialize'
import { getComponent } from '../registry'

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
      node.type === 'mdxJsxFlowElement' &&
      typeof node.value === 'string',
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

const mdxNodeView: NodeViewConstructor = (node) => {
  const dom = document.createElement('div')
  let app: App | null = null

  const render = (): void => {
    const { name, props, children } = node.attrs as MdxComponentAttrs
    const component = getComponent(name)
    if (app) {
      app.unmount()
      app = null
    }
    dom.replaceChildren()
    if (component) {
      dom.className = 'mdx-component'
      app = createApp(h(component, { ...props, children }))
      app.mount(dom)
    } else {
      dom.className = 'mdx-component mdx-component-placeholder'
      const source = document.createElement('div')
      source.className = 'mdx-component-source'
      source.textContent = `<${name}>${children}</${name}>`
      dom.appendChild(source)
    }
  }

  render()

  return {
    dom,
    update: (newNode) => {
      if (newNode.type !== node.type) return false
      node = newNode
      render()
      return true
    },
    destroy: () => {
      if (app) {
        app.unmount()
        app = null
      }
    },
  }
}

export const mdxComponentNodeView = $view(mdxComponent, () => mdxNodeView)
