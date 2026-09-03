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

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#123;/g, '{')
    .replace(/&amp;/g, '&')
}

export function parseMdxTag(html: string): MdxComponentAttrs {
  const nameMatch = /^<([A-Za-z0-9]+)/.exec(html)
  const name = nameMatch ? nameMatch[1] : 'Component'
  const props: Record<string, string> = {}
  let attrSource = ''
  let body = ''
  if (nameMatch) {
    // Scan to the tag's closing '>' while respecting quoted attribute values
    // so a '>' inside a value does not truncate parsing (the previous
    // [^>]*? scan dropped every prop after it).
    let end = html.length
    for (let j = nameMatch[0].length; j < html.length; j++) {
      const ch = html[j]
      if (ch === '"' || ch === "'") {
        const close = html.indexOf(ch, j + 1)
        if (close === -1) break
        j = close
      } else if (ch === '>') {
        end = j
        break
      }
    }
    attrSource = html.slice(nameMatch[0].length, end)
    // Children are everything after the open tag, minus the closing tag.
    const rest = end + 1 <= html.length ? html.slice(end + 1) : ''
    const closeTag = `</${name}>`
    if (rest.toLowerCase().endsWith(closeTag.toLowerCase())) {
      body = rest.slice(0, rest.length - closeTag.length)
    }
  }
  const attrRe = /([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>/`]+))|([A-Za-z0-9_-]+)/g
  let match: RegExpExecArray | null
  while ((match = attrRe.exec(attrSource)) !== null) {
    const key = match[1] ?? match[5]
    // Boolean attrs (`<Tag disabled>`) decode to an empty string; unquoted
    // values are supported alongside single/double-quoted ones.
    props[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return { name, props, children: body.trim() }
}

const mdxNodeView: NodeViewConstructor = (node, view, getPos) => {
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
      app = createApp(
        h(component, { ...props, children, _getPos: getPos, _view: view }),
      )
      app.mount(dom)
    } else {
      dom.className = 'mdx-component mdx-component-placeholder'
      const source = document.createElement('div')
      source.className = 'mdx-component-source'
      source.textContent = mdxComponentToMarkdown({ name, props, children })
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
