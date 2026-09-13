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
 *
 * It also owns the "render task-list checkboxes" setting. With the boxes off the
 * item carries `TASK_PLAIN_CLASS` and its markdown marker as a data attribute,
 * which the stylesheet paints in front of the text, and it stops being
 * clickable, so a checked task never turns into a silently unchecked one.
 */

import { Plugin, PluginKey } from '@milkdown/prose/state'
import type { EditorState } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { Decoration, DecorationSet } from '@milkdown/prose/view'
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

/** Class a task item carries while it is rendered as text instead of as a
 *  checkbox. The stylesheet keys the plain-text variant off it. */
export const TASK_PLAIN_CLASS = 'neko-task-plain'

const renderingKey = new PluginKey<boolean>('nekoTaskChecklistRendering')

/** Whether task items are drawn as clickable checkboxes (the default). */
let renderCheckboxes = true

/** Every live editor, so a setting change can re-decorate the ones already open. */
const liveViews = new Set<EditorView>()

/**
 * Switch the checkbox rendering of every open editor.
 *
 * This is module state rather than an editor-construction option on purpose: the
 * pane keeps one editor alive while the user flips the setting, and rebuilding
 * it would throw away the undo stack and the caret. Each live view gets a
 * meta-only transaction, which re-runs the decoration computation.
 */
export function configureTaskChecklistRendering(enabled: boolean): void {
  if (renderCheckboxes === enabled) return
  renderCheckboxes = enabled
  for (const view of liveViews) {
    view.dispatch(view.state.tr.setMeta(renderingKey, enabled))
  }
}

/** The marker an item carries when the boxes are off, spelled like the markdown
 *  the source pane shows for the same item. */
function markerText(checked: boolean): string {
  return checked ? '[x]' : '[ ]'
}

/** Attribute the stylesheet reads the plain marker from (`content: attr(...)`),
 *  so the marker does not need a widget of its own. */
export const TASK_MARKER_ATTR = 'data-neko-task-marker'

/**
 * Decorations for the task items of `state`.
 *
 * With the boxes on this contributes nothing: the box is the stylesheet's
 * `::before` and the interaction is the click handler. With them off each item
 * gets the plain class (which drops the box, its padding and the checked
 * styling) plus the markdown marker, so a reader can still tell a checked item
 * from an unchecked one.
 *
 * Everything here has to be idempotent. The host's find/spell overlay merges
 * plugin decorations into its own provider and ProseMirror then collects both,
 * so this set can be applied twice; a class and an attribute survive that, a
 * widget that inserts text does not (it renders `[ ] [ ] todo`).
 */
function taskDecorations(state: EditorState): DecorationSet {
  if (renderingKey.getState(state) ?? true) return DecorationSet.empty
  const decorations: Decoration[] = []
  state.doc.descendants((node, pos) => {
    if (node.type.name !== LIST_ITEM || node.attrs.checked == null) return true
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: TASK_PLAIN_CLASS,
        [TASK_MARKER_ATTR]: markerText(node.attrs.checked === true),
      }),
    )
    // Keep descending: a nested list inside the item has task rows of its own.
    return true
  })
  return DecorationSet.create(state.doc, decorations)
}

export function taskCheckboxPlugin(): Plugin {
  return new Plugin({
    key: renderingKey,
    state: {
      init: () => renderCheckboxes,
      apply: (tr, value) => tr.getMeta(renderingKey) ?? value,
    },
    props: {
      decorations: (state) => taskDecorations(state),
    },
    view(editorView) {
      liveViews.add(editorView)
      const onClick = (event: MouseEvent): void => {
        // Only a plain left click toggles: a modifier click is a selection
        // gesture and must keep working.
        if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
          return
        }
        // ...and only while the box is actually drawn: with the plain rendering
        // on, a click in the item must not flip the markdown behind the text.
        if (!renderingKey.getState(editorView.state)) return
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
        destroy: () => {
          liveViews.delete(editorView)
          editorView.dom.removeEventListener('click', onClick)
        },
      }
    },
  })
}

/** Registered like the other feature plugins. */
export const taskCheckbox = $prose(() => taskCheckboxPlugin())
