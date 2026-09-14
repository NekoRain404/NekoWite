import { $node, $view } from '@milkdown/utils'
import type { EditorView, NodeViewConstructor } from '@milkdown/prose/view'
import { createApp, h, type App } from 'vue'

import { escapeMdxText } from '../serialize'
import { getComponent } from '../registry'

/** Which construct of MDX the source is. A component is the only kind that has
 *  a structured form (`name` / `props` / `children`) to fall back on when its
 *  source no longer describes the node; an expression and an ESM statement are
 *  their source and nothing else. */
export type MdxKind = 'component' | 'expression' | 'esm'

export interface MdxComponentAttrs {
  name: string
  props: Record<string, string>
  children: string
  /** Exact source text of the MDX construct, captured on parse. An unknown /
   * uneditable element keeps its raw source so an unmodified document
   * round-trips byte-for-byte (expressions, attribute order, and inline vs
   * block form are all preserved verbatim). */
  raw?: string
  /** Defaults to `component`, so every existing node — and every node a
   *  caller builds without naming a kind — keeps its meaning. */
  kind?: MdxKind
}

/** The mdast node types that are a whole block of MDX source, and what each one
 *  is. They are one node in the model because they are one thing to it: source
 *  that has to be written back untouched. */
const BLOCK_MDX: Record<string, MdxKind> = {
  mdxJsxFlowElement: 'component',
  mdxFlowExpression: 'expression',
  mdxjsEsm: 'esm',
}

export const mdxComponent = $node('mdxComponent', () => ({
  // The node is a block atom (a non-editable source placeholder). It was NOT
  // made `inline`/grouped 'inline': ProseMirror separates block vs inline nodes
  // via `spec.inline` (an `inline` group member is still `isBlock`), so a node
  // in both groups fails schema validation with "Mixing inline and block
  // content". Whole-block components therefore stay block atoms; components
  // inside a GFM table cell (whose content is a paragraph) are left as raw HTML
  // by mdxJsxMdast so they are preserved, not dropped/corrupted on open.
  group: 'block',
  atom: true,
  attrs: {
    name: { default: 'Component' },
    props: { default: {} as Record<string, string> },
    children: { default: '' },
    raw: { default: undefined },
    kind: { default: 'component' as MdxKind },
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
    match: (node) => BLOCK_MDX[node.type] !== undefined && typeof node.value === 'string',
    runner: (state, node, type) => {
      const source = node.value as string
      const kind = BLOCK_MDX[node.type]
      const attrs = kind === 'component' ? parseMdxTag(source) : { name: '', props: {}, children: '' }
      state.addNode(type, { ...attrs, kind, raw: source })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'mdxComponent',
    runner: (state, node) => {
      const attrs: MdxComponentAttrs = {
        name: node.attrs.name,
        props: node.attrs.props,
        children: node.attrs.children,
        raw: node.attrs.raw,
        kind: node.attrs.kind,
      }
      state.addNode('html', undefined, mdxComponentToMarkdown(attrs))
    },
  },
}))

export function mdxComponentToMarkdown(attrs: MdxComponentAttrs): string {
  const { name, props, children, raw, kind = 'component' } = attrs
  // A `{ … }` expression and an ESM statement have no structured form: the
  // source is the whole node, so it is written as it was read, always.
  if (raw && kind !== 'component') return raw
  // An element parsed from source carries its captured raw source. Emit it
  // verbatim so JSX attribute expressions, attribute order, self-closing form,
  // and inline-vs-block layout all round-trip byte-for-byte (the structured
  // attrs below only hold strings and would mangle `{expr}`/reorder attrs) —
  // as long as it still describes this node. See `rawIsCurrent`.
  if (raw && rawIsCurrent(raw, attrs)) return raw
  if (kind !== 'component') return raw ?? ''
  const propStr = Object.entries(props)
    .map(([k, v]) => ` ${k}="${escapeMdxText(v)}"`)
    .join('')
  if (!children) return `<${name}${propStr} />`
  return `<${name}${propStr}>\n\n${children}\n\n</${name}>`
}

/**
 * Whether `raw` still says what the node says.
 *
 * The edit paths that move a FloatBox (drag, resize, rotate, retext, z-order) go
 * through `setNodeMarkup` with the new attributes, which leaves `raw` — the
 * source the node was parsed from — untouched. Emitting it regardless wrote the
 * ORIGINAL geometry back over the edit, so every drag was discarded on the next
 * save and the box snapped back on reload. The source is therefore used only
 * while it still parses to the same name, props and children; a node that has been
 * edited is re-serialized from its attributes instead.
 */
function rawIsCurrent(raw: string, attrs: MdxComponentAttrs): boolean {
  const parsed = parseMdxTag(raw)
  if (parsed.name !== attrs.name || parsed.children !== (attrs.children ?? '')) return false
  return propsMatch(parsed.props, attrs.props ?? {})
}

function propsMatch(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
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
    let braceDepth = 0
    for (let j = nameMatch[0].length; j < html.length; j++) {
      const ch = html[j]
      if (ch === '"' || ch === "'") {
        const close = html.indexOf(ch, j + 1)
        if (close === -1) break
        j = close
      } else if (ch === '{') {
        braceDepth += 1
      } else if (ch === '}' && braceDepth > 0) {
        braceDepth -= 1
      } else if (ch === '>' && braceDepth === 0) {
        end = j
        break
      }
    }
    // A '{' that is never closed (a truncated tag, or a brace inside an
    // unparsed string) would otherwise leave `end` at the end of the input:
    // the whole remaining document becomes the attribute source, the component's
    // children are dropped, and every `k="v"` found later in the note is
    // harvested as a prop. Fall back to the first '>' so a malformed tag cannot
    // swallow the document.
    if (braceDepth > 0 && end === html.length) {
      const firstClose = html.indexOf('>', nameMatch[0].length)
      if (firstClose !== -1) end = firstClose
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
    const { name, props, children, raw, kind } = node.attrs as MdxComponentAttrs
    // Only a component can have a registered Vue component behind it; an
    // expression or an ESM statement is source and renders as source.
    const component = kind === undefined || kind === 'component' ? getComponent(name) : undefined
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
      // Unregistered / unknown component: render a non-editable source
      // placeholder showing the exact JSX so the author sees what will be
      // written back, and the node serializes the raw source verbatim.
      dom.className = 'mdx-component mdx-component-placeholder'
      const source = document.createElement('div')
      source.className = 'mdx-component-source'
      source.textContent = mdxComponentToMarkdown({ name, props, children, raw, kind })
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
