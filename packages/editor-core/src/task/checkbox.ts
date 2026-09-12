/**
 * Clicking a GFM task-list checkbox toggles it.
 *
 * Milkdown's GFM preset extends the list-item schema with a `checked`
 * attribute, but it ships no interaction for it: the box a reader sees is drawn
 * by our stylesheet (`editor-content.css`), so a click landed in the item's
 * left padding and did nothing at all. Checking a task off meant switching to
 * the source view and retyping `[ ]` as `[x]` by hand — for a checkbox the user
 * can see and click.
 *
 * This plugin gives the box a real click target in the rendered view. The
 * toggle goes through one transaction, so it is a single undo step, and it
 * refuses modifier presses so text selection is never hijacked.
 */

import { Plugin } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { $prose } from '@milkdown/utils'

const TASK_ITEM_SELECTOR = 'li[data-item-type="task"]'
/** Used when the stylesheet cannot be measured (e.g. a detached DOM in tests). */
const FALLBACK_BOX_WIDTH = 27
const LIST_ITEM = 'list_item'

/** The clickable checkbox zone is exactly the item's left padding, where the
 *  box is drawn. Reading it keeps the target in step with the stylesheet. */
function checkboxZoneWidth(li: HTMLElement): number {
  const styles = li.ownerDocument.defaultView?.getComputedStyle(li)
  const padding = Number.parseFloat(styles?.paddingLeft ?? '')
  return Number.isFinite(padding) && padding > 0 ? padding : FALLBACK_BOX_WIDTH
}

/**
 * Toggle the task item rendered as `li`, if the click really landed on its box.
 * Returns true when the document changed (or when the click was on the box),
 * so a caller can stop handling the event.
 */
export function toggleTaskAtDom(view: EditorView, li: HTMLElement, clientX: number): boolean {
  const rect = li.getBoundingClientRect()
  if (clientX - rect.left > checkboxZoneWidth(li)) return false

  const pos = taskItemPos(view, li)
  if (pos == null) return false
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.attrs.checked == null) return false

  const tr = view.state.tr.setNodeMarkup(pos, undefined, {
    ...node.attrs,
    checked: !node.attrs.checked,
  })
  view.dispatch(tr)
  return true
}

/** The document position of the list item rendered as `li`, or null when the
 *  DOM node does not belong to the current document. */
function taskItemPos(view: EditorView, li: HTMLElement): number | null {
  const inner = view.posAtDOM(li, 0)
  const $inner = view.state.doc.resolve(inner)
  // A position at the start of the item resolves to its first child, so the
  // item itself is the resolved parent.
  if ($inner.parent.type.name === LIST_ITEM && $inner.parent.attrs.checked != null) {
    return $inner.before($inner.depth)
  }
  // Fallback: match the DOM node exactly (covers an item whose first child is a
  // rendered node view rather than a plain paragraph).
  let found: number | null = null
  view.state.doc.descendants((node, pos) => {
    if (found != null) return false
    if (node.type.name === LIST_ITEM && node.attrs.checked != null && view.nodeDOM(pos) === li) {
      found = pos
      return false
    }
    return true
  })
  return found
}

export function taskCheckboxPlugin(): Plugin {
  return new Plugin({
    view(editorView) {
      const onClick = (event: MouseEvent): void => {
        // Only a plain left click toggles: a modifier click is a selection
        // gesture and must keep working.
        if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
          return
        }
        const target = event.target as HTMLElement | null
        const li = target?.closest?.(TASK_ITEM_SELECTOR)
        if (!li) return
        if (toggleTaskAtDom(editorView, li as HTMLElement, event.clientX)) {
          event.preventDefault()
          event.stopPropagation()
        }
      }
      editorView.dom.addEventListener('click', onClick)
      return {
        destroy: () => editorView.dom.removeEventListener('click', onClick),
      }
    },
  })
}

/** Registered like the other feature plugins. */
export const taskCheckbox = $prose(() => taskCheckboxPlugin())
