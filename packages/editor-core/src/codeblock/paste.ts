import type { MilkdownPlugin } from '@milkdown/ctx'
import { SchemaReady, prosePluginsCtx } from '@milkdown/core'
import type { Node as ProseNode } from '@milkdown/prose/model'
import { Plugin } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

/**
 * Inside a code block, a paste is plain text — whatever the clipboard carries.
 *
 * A `code_block` only accepts text, so a pasted `text/html` slice parses into
 * block nodes that fit nowhere: the fitter lifts them out of the fence and the code
 * block breaks apart, with the text that followed it turned into ordinary
 * paragraphs. The whitespace of the HTML fallback is not the code either — the
 * blank lines between source paragraphs came along and changed the code the next
 * time the file was opened. Code is plain text by definition, so the slice is
 * replaced by the clipboard TEXT, with runs of blank lines collapsed to a single
 * newline.
 *
 * `transformPasted` runs before ProseMirror picks between the clipboard flavors, so
 * a paste that starts in a code block never reaches the HTML path.
 */
export function isInCodeBlock(view: EditorView | undefined, pos?: number): boolean {
  // `posAtCoords` is the tell-tale of a real EditorView. A bare `view.state` check
  // is not enough: ProseMirror's paste path calls this hook as `(slice, event)` in
  // one of its branches, and a DOM event also has a `.state`, so an event would
  // pass the check and then blow up on `state.doc`.
  if (!view || typeof view.posAtCoords !== 'function') return false
  const state = view.state
  const node = nodeAtPos(state, pos ?? state.selection.from)
  return node?.type.spec.code === true
}

/**
 * The innermost node containing `pos`.
 *
 * Walks down from the document instead of using `doc.resolve()`: the position
 * lookup is a simple containment test, and it keeps this hook from depending on
 * helpers of the ProseMirror build the editor is running against (the paste hook
 * is also called with a plain object in some branches, where a missing helper
 * would throw mid-paste). Returns null when the position is out of range, so
 * "cannot tell" becomes "not a code block" rather than an exception.
 */
function nodeAtPos(state: EditorView['state'], pos: number): ProseNode | null {
  if (pos < 0 || pos > state.doc.content.size) return null
  let node: ProseNode = state.doc
  let start = 0
  // 8 is the deepest structure a GFM cell with a table can nest in this schema,
  // with room to spare; the guard keeps a malformed document from spinning.
  for (let guard = 0; guard < 32; guard++) {
    let next: ProseNode | null = null
    let nextStart = start
    node.forEach((child, offset) => {
      if (next) return
      const from = start + offset
      if (pos >= from && pos < from + child.nodeSize) {
        next = child
        nextStart = from
      }
    })
    if (!next) return node
    const child = next as ProseNode
    if (child.isTextblock || child.isLeaf) return child
    start = nextStart
    node = child
  }
  return node
}

/** The plain text a paste carries, with blank-line runs collapsed. */
export function plainPasteText(event: ClipboardEvent, fallback: string): string {
  const text = event.clipboardData?.getData('text/plain') || fallback
  return text.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n')
}

export const codeBlockPastePlugin: MilkdownPlugin = (ctx) => {
  return async () => {
    await ctx.wait(SchemaReady)
    const plugin = new Plugin({
      props: {
        handlePaste: (view, event, slice) => {
          if (!isInCodeBlock(view)) return false
          const text = plainPasteText(event, slice.content.textBetween(0, slice.content.size, '\n'))
          if (!text) return false
          view.dispatch(view.state.tr.insertText(text).scrollIntoView())
          return true
        },
      },
    })
    ctx.update(prosePluginsCtx, (plugins) => [...plugins, plugin])
    return () => {
      ctx.update(prosePluginsCtx, (plugins) => plugins.filter((entry) => entry !== plugin))
    }
  }
}
