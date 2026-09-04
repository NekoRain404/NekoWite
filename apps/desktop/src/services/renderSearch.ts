// Find/replace + spell decorations for the rendered (Milkdown/ProseMirror)
// pane.
//
// Highlights are non-persistent, purely visual overlays. We render them with
// ProseMirror's own decoration pipeline (`Decoration.inline` + a
// `DecorationSet` that the view reads from its `decorations` editor prop)
// instead of hand-editing the `.ProseMirror` DOM. ProseMirror owns the DOM and
// keeps it mirrored to the model, so wrapping text in spans by hand silently
// desynced the viewer's `posAtDOM` mapping (dropping every hit after the first
// in the same text node) and corrupted the model↔DOM read-back that
// `editor.save()` relies on. Decorations are applied by ProseMirror itself, so
// multiple hits render correctly and `save()` serializes the untouched model.
//
// Every replacement goes through the ProseMirror model (`tr.insertText`) so
// Milkdown's change pipeline (markDirty → autosave) fires exactly as with a
// user edit.

import type { NekoEditor } from '@nekowite/editor-core'
import { reactive } from 'vue'
import type { EditorState } from '@milkdown/prose/state'
import {
  Decoration,
  DecorationSet,
  type DecorationSource,
} from '@milkdown/prose/view'
import { findMisspelled, suggestions } from './spellcheck'
import { editorBridge } from './editorBridge'
import { debounce } from './timing'

type EditorView = NonNullable<ReturnType<NekoEditor['getView']>>

export interface FindRange {
  from: number
  to: number
}

export interface RenderSearchState {
  open: boolean
  query: string
  replace: string
  caseSensitive: boolean
  ranges: FindRange[]
  active: number
  spellEnabled: boolean
}

export const renderSearchState = reactive<RenderSearchState>({
  open: false,
  query: '',
  replace: '',
  caseSensitive: false,
  ranges: [],
  active: 0,
  spellEnabled: true,
})

export function setRenderSearchState(patch: Partial<RenderSearchState>): void {
  Object.assign(renderSearchState, patch)
}

export function getView(): EditorView | null {
  return editorBridge.getView()
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Locate every occurrence of `query` inside a document's model. Matches are
 *  found per text node, so a query never spans a mark/block boundary. */
function findRangesInterior(
  state: EditorState,
  query: string,
  caseSensitive: boolean,
): FindRange[] {
  if (!query) return []
  const re = new RegExp(escapeRegExp(query), caseSensitive ? 'g' : 'gi')
  const ranges: FindRange[] = []
  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(node.text)) !== null) {
      const from = pos + match.index
      const to = from + match[0].length
      ranges.push({ from, to })
      if (match[0].length === 0) re.lastIndex += 1
    }
  })
  return ranges
}

/** Locate every occurrence of `query` inside the document, returning absolute
 *  ProseMirror positions that feed straight into `tr.insertText`. */
export function findRangesInDoc(
  view: EditorView,
  query: string,
  caseSensitive: boolean,
): FindRange[] {
  return findRangesInterior(view.state, query, caseSensitive)
}

/** Compute misspelled ranges from the model's text, excluding inline code. */
function findMisspellingsInterior(state: EditorState): Array<{
  word: string
  from: number
  to: number
}> {
  const out: Array<{ word: string; from: number; to: number }> = []
  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    if (node.marks.some((mark) => mark.type.name === 'inlineCode')) return
    for (const { word, offset } of findMisspelled(node.text)) {
      out.push({ word, from: pos + offset, to: pos + offset + word.length })
    }
  })
  return out
}

export function findMisspellingsInDoc(view: EditorView): Array<{
  word: string
  from: number
  to: number
}> {
  return findMisspellingsInterior(view.state)
}

interface WrapEntry {
  from: number
  to: number
  cls: string
  attrs?: Record<string, string>
}

/** Build the overlay entries for a given document state from the current
 *  panel state. Pure: never mutates reactive state, so it can run inside the
 *  view's render pass. */
function computeEntries(state: EditorState): WrapEntry[] {
  const entries: WrapEntry[] = []
  if (renderSearchState.open && renderSearchState.query) {
    const ranges = findRangesInterior(
      state,
      renderSearchState.query,
      renderSearchState.caseSensitive,
    )
    if (ranges.length) {
      const active = Math.min(Math.max(renderSearchState.active, 0), ranges.length - 1)
      ranges.forEach((range, index) => {
        entries.push({
          from: range.from,
          to: range.to,
          cls: index === active ? 'nw-find-hit nw-find-active' : 'nw-find-hit',
        })
      })
    }
  }

  if (renderSearchState.spellEnabled) {
    for (const miss of findMisspellingsInterior(state)) {
      const sugg = suggestions(miss.word)
      entries.push({
        from: miss.from,
        to: miss.to,
        cls: 'nkw-spell',
        attrs: {
          'data-word': miss.word,
          'data-from': String(miss.from),
          'data-to': String(miss.to),
          'data-suggestions': sugg.join('|'),
        },
      })
    }
  }

  return entries
}

/** Turn overlay entries into a ProseMirror `DecorationSet` for a state. */
function buildDecorationSet(state: EditorState, entries: WrapEntry[]): DecorationSet {
  if (!entries.length) return DecorationSet.empty
  const size = state.doc.content.size
  const decos: Decoration[] = []
  for (const entry of entries) {
    if (entry.from < 0 || entry.to > size || entry.to <= entry.from) continue
    const attrs: Record<string, string> = { class: entry.cls }
    if (entry.attrs) {
      for (const [key, value] of Object.entries(entry.attrs)) attrs[key] = value
    }
    decos.push(Decoration.inline(entry.from, entry.to, attrs))
  }
  return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty
}

/** Flatten a decoration source (set or group) into its individual decor. */
function flattenSource(source: DecorationSource): Decoration[] {
  const out: Decoration[] = []
  source.forEachSet((set) => out.push(...set.find()))
  return out
}

/** Compute the overlay decorations for a state during the view's render pass.
 *  A top-level `decorations` editor prop shadows `props.decorations` from
 *  state plugins, so we merge our find/spell marks in on top of whatever the
 *  plugins contribute (e.g. the AI suggestion ghost widget). */
function decorationsProvider(state: EditorState): DecorationSet {
  let combined = buildDecorationSet(state, computeEntries(state))
  for (const plugin of state.plugins) {
    const deco = plugin.spec.props?.decorations
    if (typeof deco !== 'function') continue
    const source = deco.call(plugin, state)
    if (source && source !== DecorationSet.empty) {
      combined = combined.add(state.doc, flattenSource(source))
    }
  }
  return combined
}

/** Re-apply find + spell overlays for the current state. Idempotent: resolves
 *  the live model ranges, updates the reactive panel state, then asks the view
 *  to re-render with the fresh decoration set. */
export function refreshOverlays(): void {
  const view = getView()
  if (!view) return

  if (renderSearchState.open && renderSearchState.query) {
    const ranges = findRangesInDoc(view, renderSearchState.query, renderSearchState.caseSensitive)
    renderSearchState.ranges = ranges
    if (ranges.length) {
      if (renderSearchState.active >= ranges.length) renderSearchState.active = 0
    } else {
      renderSearchState.active = 0
    }
  } else {
    renderSearchState.ranges = []
    renderSearchState.active = 0
  }

  view.setProps({ decorations: decorationsProvider })
}

/** Idle window (ms) after the last model change before overlays refresh. */
const OVERLAY_REFRESH_IDLE_MS = 90

// Coalesce the burst of changes that a typing run produces into ONE refresh
// shortly after input settles. The final call is scheduled on the next
// animation frame so ProseMirror has already synced the DOM. `refreshOverlays`
// itself stays synchronous for explicit, user-driven calls (query, toggle,
// navigate); this is the deferred companion the editor's change listener uses.
const overlayRefresh = debounce(() => {
  requestAnimationFrame(() => refreshOverlays())
}, OVERLAY_REFRESH_IDLE_MS)

/** Defer an overlay refresh: bursty model changes become a single refresh. */
export function scheduleOverlayRefresh(): void {
  overlayRefresh.run()
}

/** Drop a scheduled (not-yet-run) overlay refresh. */
export function cancelOverlayRefresh(): void {
  overlayRefresh.cancel()
}

export function scrollRangeIntoView(view: EditorView, range: FindRange): void {
  const coords = view.coordsAtPos(range.from)
  if (!coords) return
  const scroller = (view.dom as HTMLElement).closest('.rendered-pane') as HTMLElement | null
  if (!scroller) return
  const scrollerRect = scroller.getBoundingClientRect()
  const target = scroller.scrollTop + (coords.top - scrollerRect.top) - scroller.clientHeight / 2
  scroller.scrollTop = Math.max(0, target)
}

export function moveActive(direction: 1 | -1): void {
  const { ranges, active } = renderSearchState
  const count = ranges.length
  if (!count) return
  renderSearchState.active = (active + direction + count) % count
  const view = getView()
  if (!view) return
  refreshOverlays()
  const range = ranges[renderSearchState.active]
  if (range) scrollRangeIntoView(view, range)
}

export function replaceCurrent(): void {
  const view = getView()
  if (!view) return
  const { ranges, active, replace } = renderSearchState
  const range = ranges[active]
  if (!range) return
  view.dispatch(view.state.tr.insertText(replace, range.from, range.to))
  refreshOverlays()
}

export function replaceAll(): void {
  const view = getView()
  if (!view) return
  const { ranges, replace } = renderSearchState
  if (!ranges.length) return
  const tr = view.state.tr
  // Apply back-to-front so earlier positions stay valid as the doc shifts.
  for (let i = ranges.length - 1; i >= 0; i--) {
    tr.insertText(replace, ranges[i].from, ranges[i].to)
  }
  view.dispatch(tr)
  renderSearchState.ranges = []
  renderSearchState.active = 0
  refreshOverlays()
}

/** Replace the model range of a clicked spell mark via `tr.insertText`. */
export function applySpellReplacement(view: EditorView, from: number, to: number, text: string): void {
  view.dispatch(view.state.tr.insertText(text, from, to))
  refreshOverlays()
}

export function setQuery(query: string): void {
  renderSearchState.query = query
  if (!renderSearchState.open || !query) {
    renderSearchState.active = 0
  }
  refreshOverlays()
}

export function setCaseSensitive(value: boolean): void {
  renderSearchState.caseSensitive = value
  renderSearchState.active = 0
  refreshOverlays()
}

export function setSpellEnabled(value: boolean): void {
  renderSearchState.spellEnabled = value
  refreshOverlays()
}

export function openPanel(): void {
  renderSearchState.open = true
  refreshOverlays()
}

export function closePanel(): void {
  renderSearchState.open = false
  renderSearchState.ranges = []
  renderSearchState.active = 0
  refreshOverlays()
}

/** Parse the pipe-joined suggestion list stored on a spell span. */
export function suggestionsFromAttr(attr: string | null): string[] {
  if (!attr) return []
  return attr.split('|').filter(Boolean)
}

export function formatCount(): string {
  const { ranges, active } = renderSearchState
  if (!ranges.length) return ''
  return `${active + 1} / ${ranges.length}`
}
