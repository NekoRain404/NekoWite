import type { EditorView } from '@milkdown/prose/view'
import type { Node as ProseNode } from '@milkdown/prose/model'
import {
  setBlockType,
  toggleMark,
  wrapIn,
} from '@milkdown/prose/commands'
import { wrapInList } from '@milkdown/prose/schema-list'

import { getCommand, registerCommand, unregisterCommand } from './registry'

/**
 * Builtin formatting commands for the shared toolbar. The desktop toolbar
 * emits ids like `heading:h2` / `bold` and resolves them through
 * `getCommand`, so these must exist or the buttons silently no-op.
 *
 * Commands resolve the ProseMirror view lazily via the provider installed by
 * `createEditor`, so they operate on whichever editor instance is live (the
 * registry is process-global while editors can be created and destroyed).
 */

export const HEADING_IDS = ['heading:h1', 'heading:h2', 'heading:h3', 'heading:h4', 'heading:h5', 'heading:h6'] as const
export type HeadingId = (typeof HEADING_IDS)[number]

export const BUILTIN_COMMAND_IDS = [
  ...HEADING_IDS,
  'bold',
  'italic',
  'strike',
  'inline-code',
  'list-unordered',
  'list-ordered',
  'list-task',
  'quote',
  'link',
  'image',
  'code-block',
  'hr',
  'insert-component',
] as const
export type BuiltinCommandId = (typeof BUILTIN_COMMAND_IDS)[number]

let viewProvider: (() => EditorView | null) | null = null

export function setCommandViewProvider(provider: (() => EditorView | null) | null): void {
  viewProvider = provider
}

function withView(run: (view: EditorView) => void): void {
  const view = viewProvider?.()
  if (!view) return
  run(view)
}

/** Outermost node of `typeName` that the selection covers, if any. */
function coveringNode(view: EditorView, typeName: string): { node: ProseNode; from: number; to: number } | null {
  const { from, to } = view.state.selection
  let found: { node: ProseNode; from: number; to: number } | null = null
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (found) return false
    if (node.type.name === typeName) {
      found = { node, from: pos, to: pos + node.nodeSize }
      return false
    }
    return true
  })
  return found
}

/** Collect the plain block content of a wrapper, flattening list items. */
function wrapperBlocks(wrapper: ProseNode): ProseNode[] {
  const blocks: ProseNode[] = []
  wrapper.forEach((child) => {
    if (child.type.name === 'list_item') {
      child.forEach((block) => blocks.push(block))
    } else {
      blocks.push(child)
    }
  })
  return blocks
}

function unwrap(view: EditorView, typeName: string): boolean {
  const target = coveringNode(view, typeName)
  if (!target) return false
  const { node, from, to } = target as { node: ProseNode; from: number; to: number }
  view.dispatch(view.state.tr.replaceWith(from, to, wrapperBlocks(node)))
  return true
}

function runHeading(view: EditorView, level: number): void {
  const schema = view.state.schema
  const heading = schema.nodes.heading
  const paragraph = schema.nodes.paragraph
  if (!heading || !paragraph) return
  // If the selection anchors in (or covers) a heading of this level, fall
  // back to a paragraph; otherwise promote to (or re-level) the heading.
  const covering = coveringNode(view, 'heading')
  const currentLevel = covering ? (covering.node as ProseNode).attrs.level as number : null
  if (currentLevel === level) {
    setBlockType(paragraph)(view.state, view.dispatch)
    return
  }
  setBlockType(heading, { level })(view.state, view.dispatch)
}

function runToggleWrap(view: EditorView, typeName: string): void {
  const type = view.state.schema.nodes[typeName]
  if (!type) return
  if (!unwrap(view, typeName)) wrapIn(type)(view.state, view.dispatch)
}

function runToggleList(view: EditorView, typeName: 'bullet_list' | 'ordered_list'): void {
  const type = view.state.schema.nodes[typeName]
  if (!type) return
  if (!unwrap(view, typeName)) wrapInList(type)(view.state, view.dispatch)
}

function runToggleTaskList(view: EditorView): void {
  const schema = view.state.schema
  const bullet = schema.nodes.bullet_list
  const itemType = schema.nodes.list_item
  if (!bullet || !itemType) return
  const list = coveringNode(view, 'bullet_list')
  if (list) {
    const items: { node: ProseNode; pos: number }[] = []
    let hasChecked = false
    view.state.doc.nodesBetween(list.from, list.to, (node, pos) => {
      if (node.type === itemType) {
        items.push({ node, pos })
        if (node.attrs.checked != null) hasChecked = true
        return false
      }
      return true
    })
    const tr = view.state.tr
    const nextChecked = hasChecked ? null : false
    for (const { node, pos } of items) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: nextChecked })
    }
    view.dispatch(tr)
    return
  }
  wrapInList(bullet)(view.state, (next) => {
    view.dispatch(next)
    const markTr = view.state.tr
    const { from, to } = view.state.selection
    view.state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type === itemType) {
        markTr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false })
        return false
      }
      return true
    })
    view.dispatch(markTr)
  })
}

function runCodeBlock(view: EditorView): void {
  const schema = view.state.schema
  const codeBlock = schema.nodes.code_block
  const paragraph = schema.nodes.paragraph
  if (!codeBlock || !paragraph) return
  if (coveringNode(view, 'code_block')) setBlockType(paragraph)(view.state, view.dispatch)
  else setBlockType(codeBlock)(view.state, view.dispatch)
}

function runLink(view: EditorView): void {
  const schema = view.state.schema
  const link = schema.marks.link
  if (!link) return
  const { from, to, empty } = view.state.selection
  const hasLink = !empty && view.state.doc.rangeHasMark(from, to, link)
  if (hasLink) {
    toggleMark(link)(view.state, view.dispatch)
    return
  }
  // Placeholder href so the mark round-trips; the user edits the URL after.
  toggleMark(link, { href: 'https://' })(view.state, view.dispatch)
}

/**
 * Host hook for the `image` command.
 *
 * Inserting an image needs bytes from outside the editor (a clipboard payload
 * or a file the user picks), which editor-core cannot reach. The host app
 * registers a handler that runs the picker + import + insert flow; without one
 * the command still produces a visible placeholder instead of silently doing
 * nothing, so an embedder gets a node it can then point at a real file.
 */
let imageInsertHandler: (() => void) | null = null

export function setImageInsertHandler(handler: (() => void) | null): void {
  imageInsertHandler = handler
}

function runImage(view: EditorView): void {
  if (imageInsertHandler) {
    imageInsertHandler()
    return
  }
  const schema = view.state.schema
  const image = schema.nodes.image
  if (!image) return
  // An empty `src` renders as a broken image with nothing to click; a visible
  // alt plus a placeholder URL makes the inserted node editable in the image
  // panel.
  view.dispatch(view.state.tr.replaceSelectionWith(image.create({ src: 'https://', alt: 'image' })))
}

function runHr(view: EditorView): void {
  const schema = view.state.schema
  const hr = schema.nodes.hr
  if (!hr) return
  view.dispatch(view.state.tr.replaceSelectionWith(hr.create()))
}

function runInsertComponent(view: EditorView): void {
  const schema = view.state.schema
  const mdx = schema.nodes.mdxComponent
  if (!mdx) return
  view.dispatch(view.state.tr.replaceSelectionWith(mdx.create({ name: 'Component' })))
}

/**
 * Register (or refresh) the builtin toolbar commands. Safe to call again —
 * existing entries are replaced, so repeated editor creations and HMR
 * reloads never trip the registry's duplicate guard.
 */
export function registerBuiltinCommands(): void {
  const handlers: Record<string, (view: EditorView) => void> = {
    bold: (view) => {
      const mark = view.state.schema.marks.strong
      if (mark) toggleMark(mark)(view.state, view.dispatch)
    },
    italic: (view) => {
      const mark = view.state.schema.marks.emphasis
      if (mark) toggleMark(mark)(view.state, view.dispatch)
    },
    strike: (view) => {
      const mark = view.state.schema.marks.strike_through
      if (mark) toggleMark(mark)(view.state, view.dispatch)
    },
    'inline-code': (view) => {
      const mark = view.state.schema.marks.inlineCode
      if (mark) toggleMark(mark)(view.state, view.dispatch)
    },
    'list-unordered': (view) => runToggleList(view, 'bullet_list'),
    'list-ordered': (view) => runToggleList(view, 'ordered_list'),
    'list-task': (view) => runToggleTaskList(view),
    quote: (view) => runToggleWrap(view, 'blockquote'),
    'code-block': (view) => runCodeBlock(view),
    link: (view) => runLink(view),
    image: (view) => runImage(view),
    hr: (view) => runHr(view),
    'insert-component': (view) => runInsertComponent(view),
  }
  for (const id of HEADING_IDS) {
    // `heading:h2` → 2 (Number('h2') would be NaN — slice past the prefix).
    const level = Number(id.slice('heading:h'.length))
    handlers[id] = (view) => runHeading(view, level)
  }
  for (const id of BUILTIN_COMMAND_IDS) {
    unregisterCommand(id)
    registerCommand({ id, run: () => withView(handlers[id]) })
  }
}

/** Test helper: run a builtin command against an explicit view. */
export function runBuiltinCommandOn(id: string, view: EditorView): void {
  const cmd = getCommand(id)
  if (!cmd) return
  const prev = viewProvider
  setCommandViewProvider(() => view)
  try {
    cmd.run()
  } finally {
    viewProvider = prev
  }
}
