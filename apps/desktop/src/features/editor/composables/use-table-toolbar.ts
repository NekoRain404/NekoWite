import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { NekoEditor } from '@nekowite/editor-core'
import { placeTableToolbar, type Rect } from '../model/table-toolbar-placement'

type EditorView = NonNullable<ReturnType<NekoEditor['getView']>>

/**
 * The floating table toolbar: where it sits, and what it must know before it
 * may act.
 *
 * §4's constraint is the shape of this module: on scroll, resize and table
 * change **only the coordinates move**. Nothing here re-parses the document or
 * touches the editor's state for positioning — it reads two rects and a
 * measurement of the toolbar itself. The follow is not eased: a toolbar that
 * chases the table reads as lag on the thing the pointer is holding.
 *
 * §3's guarantee is the other half, and it is why the toolbar holds a
 * *bookmark* rather than a DOM reference: the table it acts on is identified by
 * DOCUMENT POSITION (`tableFrom`), taken when the caret entered the table or
 * when the toolbar was raised again for a caret that is in one, and re-validated
 * before every action. A re-parse, an undo or another window's write can move a
 * table; indices into a NodeList cannot survive that, a position plus a type
 * check can.
 *
 * Being on screen and being able to act are one fact to the user, so they are
 * one decision here: `place` is the only place `visible` is turned on, and it
 * turns on only for a bookmark that names a table.
 */
export interface TableToolbarOptions {
  /** The live editor, or null before the rendered pane has one. */
  getEditor: () => NekoEditor | null
  /** The panel the toolbar may never leave. Defaults to the rendered pane's
   *  own scroll container, found from the editor's DOM — it must not be read
   *  from the toolbar element, which only exists once there is a panel to
   *  place it in. */
  getPanelEl?: () => HTMLElement | null
  /** True while the caret is inside a table — the pane's existing signal. */
  inTable: Ref<boolean>
}

export interface TableToolbar {
  /** Whether the toolbar should be on screen at all. */
  visible: Ref<boolean>
  /** Its viewport position; only these change as the pane scrolls. */
  top: Ref<number>
  left: Ref<number>
  /** Measure the toolbar element once it is rendered (it is placed from its own
   *  size, which is only known after a first paint). */
  measure: (el: HTMLElement | null) => void
  /** The table this toolbar was raised for, as document positions. */
  anchor: () => { tableFrom: number; cellFrom: number } | null
  /** Whether the table is still where the toolbar left it (§3's re-validation:
   *  false means the action must not run). */
  stillValid: () => boolean
}

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
}

export function useTableToolbar(options: TableToolbarOptions): TableToolbar {
  const visible = ref(false)
  const top = ref(0)
  const left = ref(0)
  const toolbarSize = { width: 0, height: 0 }
  const anchor = ref<{ tableFrom: number; cellFrom: number } | null>(null)
  let frame = 0
  let observer: ResizeObserver | null = null
  let root: HTMLElement | null = null

  /** The panel: the pane's scroll container (`.rendered-pane`), which is what
   *  the toolbar may never leave and what its scroll events come from. */
  function panelEl(): HTMLElement | null {
    const explicit = options.getPanelEl?.()
    if (explicit) return explicit
    const dom = view()?.dom ?? null
    return (dom?.closest('.rendered-pane') as HTMLElement | null) ?? null
  }

  function view(): EditorView | null {
    try {
      return options.getEditor()?.getView() ?? null
    } catch {
      return null
    }
  }

  /** The DOM nodes the caret is inside: the table and its cell.
   *
   *  Read from the selection's position and the view's own node DOM — the
   *  document says WHICH table, the DOM only says where it is on screen. */
  function nodesInCaret(): { tableEl: HTMLElement; cellEl: HTMLElement } | null {
    const v = view()
    if (!v || !panelEl()) return null
    let cellEl: HTMLElement | null = null
    try {
      // `domAtPos` and not `nodeDOM`: the caret is usually INSIDE a text node,
      // where `nodeDOM` answers null (it names the node a position starts, not
      // the one it is in) — which is how this shipped hidden in the app while
      // the unit test's own selection happened to land on a boundary.
      const at = v.domAtPos(v.state.selection.from)
      const start = at.node instanceof HTMLElement ? at.node : (at.node?.parentElement ?? null)
      // The CELL, not the paragraph the caret sits in: the rules ask whether the
      // toolbar would cover the cell the user is editing, and a paragraph's rect
      // is a fraction of its cell's.
      cellEl = (start?.closest('td, th') as HTMLElement | null) ?? null
    } catch {
      return null
    }
    const tableEl = cellEl?.closest('table') ?? null
    return cellEl && tableEl ? { tableEl, cellEl } : null
  }

  /** Capture the bookmark: the table's position in the document, and the caret. */
  function capture(): void {
    const v = view()
    const nodes = nodesInCaret()
    if (!v || !nodes) {
      anchor.value = null
      return
    }
    try {
      const $pos = v.state.doc.resolve(v.state.selection.from)
      for (let depth = $pos.depth; depth > 0; depth -= 1) {
        if ($pos.node(depth).type.name === 'table') {
          anchor.value = { tableFrom: $pos.before(depth), cellFrom: v.state.selection.from }
          return
        }
      }
    } catch {
      // A selection that cannot be resolved is not an anchor.
    }
    anchor.value = null
  }

  function stillValid(): boolean {
    const v = view()
    const held = anchor.value
    if (!v || !held) return false
    const node = v.state.doc.nodeAt(held.tableFrom)
    return node?.type.name === 'table'
  }

  /** One frame of positioning — and the one place the toolbar decides whether it
   *  may be on screen at all.
   *
   *  The coordinates are the DOM's (§4: nothing here re-parses for them). The
   *  TARGET is not, and must not be: a toolbar placed from live boxes alone can
   *  come back holding nothing, which is a row of buttons that refuses everything
   *  it offers. That state is reachable without the caret moving — an outside
   *  press releases the bookmark (`onPointerDown`) and the press back into the
   *  same cell crosses no in-table edge, because the caret never left the table.
   *  So a missing bookmark is taken again here, from the caret's own document
   *  position, and `capture` reads the state rather than the DOM node. */
  function place(): void {
    const panel = panelEl()
    const nodes = nodesInCaret()
    if (!panel || !nodes) {
      visible.value = false
      return
    }
    if (!anchor.value) capture()
    if (!stillValid()) {
      // A bookmark that no longer names a table is not a target, and it is not
      // kept: the next placement takes a fresh one from the caret, which is the
      // only thing that cannot itself go stale.
      anchor.value = null
      visible.value = false
      return
    }
    const placement = placeTableToolbar({
      table: rectOf(nodes.tableEl),
      panel: rectOf(panel),
      cell: rectOf(nodes.cellEl),
      toolbar: toolbarSize,
    })
    if (!placement) {
      visible.value = false
      return
    }
    top.value = placement.top
    left.value = placement.left
    visible.value = true
  }

  function schedule(): void {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      place()
    })
  }

  function measure(el: HTMLElement | null): void {
    root = el
    if (!el) return
    const rect = el.getBoundingClientRect()
    toolbarSize.width = rect.width
    toolbarSize.height = rect.height
    place()
  }

  // Entering the table captures the bookmark and starts watching the two boxes
  // whose changes can move the toolbar: the panel and the table.
  watch(options.inTable, (on) => {
    if (!on) {
      visible.value = false
      anchor.value = null
      observer?.disconnect()
      observer = null
      return
    }
    capture()
    const panel = panelEl()
    const nodes = nodesInCaret()
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => schedule())
      if (panel) observer.observe(panel)
      if (nodes) observer.observe(nodes.tableEl)
    }
    panel?.addEventListener('scroll', schedule, { passive: true })
    // A click or a keystroke inside the pane can move the caret to another cell
    // (or to another table) without the in-table signal flipping, and the
    // toolbar belongs to the cell the caret is in. Both are cheap: they only
    // ask for a re-place, one per frame (§4).
    panel?.addEventListener('click', schedule, true)
    panel?.addEventListener('keyup', schedule, true)
    // Placed in the same tick the caret enters the table, and again on the next
    // frame: the signal arrives from the editor's transaction, which can be a
    // tick before the caret's own cell is measurable — and a placement that
    // found nothing must not be the last word, because the signal will not fire
    // again while the caret stays in the table.
    place()
    schedule()
  })

  /** A press outside both the table and the toolbar dismisses it. A press that
   *  came from a cell (or from the toolbar itself) never does: the toolbar is
   *  raised for the table the user is working in, and clicking another cell of
   *  it is still that work.
   *
   *  The dismiss is this toolbar's own business (`visible`) and it does NOT
   *  write `options.inTable`, which it used to. That ref belongs to the pane and
   *  is published by the editor: `TableMenu.vue` sets it from
   *  `onTableCursorChange`, whose publisher speaks only when its own answer
   *  CHANGES. A false written here while the caret is still in a table is
   *  therefore never taken back — no later transaction reports a change it can
   *  see — and the pane spends the rest of the visit believing the caret is
   *  outside the table it is sitting in. */
  function onPointerDown(event: PointerEvent): void {
    if (!visible.value) return
    const target = event.target as Element | null
    if (!target) return
    if (root?.contains(target)) return
    if (target.closest('table')) return
    visible.value = false
    anchor.value = null
  }
  document.addEventListener('pointerdown', onPointerDown, true)

  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    panelEl()?.removeEventListener('scroll', schedule)
    panelEl()?.removeEventListener('click', schedule, true)
    panelEl()?.removeEventListener('keyup', schedule, true)
    observer?.disconnect()
    observer = null
    if (frame) cancelAnimationFrame(frame)
    frame = 0
  })

  return { visible, top, left, measure, anchor: () => anchor.value, stillValid }
}
