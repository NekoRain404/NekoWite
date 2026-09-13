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
import { Decoration, DecorationSet } from '@milkdown/prose/view'
import { findMisspelled, suggestions } from './spellcheck'
import { editorSessionManager } from '../features/editor/sessionManager'
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
  return editorSessionManager.getView()
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
  // A very long query makes V8 reject the pattern outright ("Regular expression
  // too large"), and that SyntaxError escaped out of the input handler: the
  // panel stopped updating, kept the PREVIOUS query's ranges, and "Replace all"
  // then replaced matches of a search the user had already replaced. Escaping
  // the metacharacters does not help — the limit is on the pattern's length.
  // A plain scan is the honest fallback: no match can span a text node, so
  // `indexOf` finds exactly what the regex would.
  if (query.length > MAX_QUERY_LENGTH) return findRangesByScan(state, query, caseSensitive)
  let re: RegExp
  try {
    re = new RegExp(escapeRegExp(query), caseSensitive ? 'g' : 'gi')
  } catch {
    return findRangesByScan(state, query, caseSensitive)
  }
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

/** Longest query matched with a regex; longer ones are scanned literally.
 *  Well above any realistic search term and far below V8's pattern limit. */
const MAX_QUERY_LENGTH = 4096

/** Literal substring scan with the same semantics as the regex path
 *  (per text node, all occurrences, `caseSensitive` respected). */
function findRangesByScan(
  state: EditorState,
  query: string,
  caseSensitive: boolean,
): FindRange[] {
  const needle = caseSensitive ? query : query.toLowerCase()
  const ranges: FindRange[] = []
  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const haystack = caseSensitive ? node.text : node.text.toLowerCase()
    let index = haystack.indexOf(needle)
    while (index !== -1) {
      ranges.push({ from: pos + index, to: pos + index + needle.length })
      index = haystack.indexOf(needle, index + needle.length)
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

/** The last find/spell entries computed by `refreshOverlays`. The decorations
 *  provider reads this cache instead of re-scanning the model on every
 *  ProseMirror update, so a typing burst never re-traverses the whole doc. */
let cachedEntries: WrapEntry[] = []

/** Build the overlay entries for a given document state from the current
 *  panel state. Pure: never mutates reactive state. This is the only function
 *  that traverses the document, so it runs solely in the coalesced refresh
 *  path — never per-render. */
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

/**
 * Our find/spell marks for the view's render pass, read from the entries the
 * last coalesced `refreshOverlays` computed (cheap: no doc scan here).
 *
 * This deliberately does NOT fold in the plugins' own `props.decorations`.
 * ProseMirror collects decorations from every source it can find -
 * `viewDecorations()` runs `someProp('decorations', …)`, which visits the
 * top-level prop AND each plugin's own prop - so a set that already contains
 * the plugins' decorations gets counted twice. Inline marks survive that
 * (painting a span twice looks like painting it once) but a WIDGET does not:
 * the AI suggestion ghost was rendered as two identical spans, and the same
 * merge made the task-checkbox marker appear twice.
 */
function decorationsProvider(state: EditorState): DecorationSet {
  return buildDecorationSet(state, cachedEntries)
}

/** Re-apply find + spell overlays for the current state. Idempotent: this is
 *  the one place the model is scanned, and it caches the resulting entries so
 *  the per-render decorations provider stays cheap. It resolves the live model
 *  ranges, updates the reactive panel state, then asks the view to re-render
 *  with the fresh decoration set. */
export function refreshOverlays(): void {
  const view = getView()
  if (!view) return

  const entries = computeEntries(view.state)
  cachedEntries = entries

  if (renderSearchState.open && renderSearchState.query) {
    const ranges = entries
      .filter((e) => e.cls.startsWith('nw-find-hit'))
      .map((e) => ({ from: e.from, to: e.to }))
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
// animation frame so ProseMirror has already synced the DOM. The rAF is
// coalesced behind a single id so a scan never overlaps a pending scan.
// `refreshOverlays` itself stays synchronous for explicit, user-driven calls
// (query, toggle, navigate); this is the deferred companion the editor's
// change listener uses.
let overlayRafId = 0

function runOverlayRefresh(): void {
  if (overlayRafId) cancelAnimationFrame(overlayRafId)
  overlayRafId = requestAnimationFrame(() => {
    overlayRafId = 0
    refreshOverlays()
  })
}

const overlayRefresh = debounce(runOverlayRefresh, OVERLAY_REFRESH_IDLE_MS)

/** Defer an overlay refresh: bursty model changes become a single refresh. */
export function scheduleOverlayRefresh(): void {
  overlayRefresh.run()
}

/** Drop a scheduled overlay refresh and any pending rAF scan. */
export function cancelOverlayRefresh(): void {
  overlayRefresh.cancel()
  if (overlayRafId) {
    cancelAnimationFrame(overlayRafId)
    overlayRafId = 0
  }
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

/**
 * The ranges that still describe THIS document.
 *
 * `renderSearchState.ranges` is a cache refreshed on a debounce, and the
 * document can be replaced wholesale in between (switching notes, an external
 * reload). The replace actions trusted it: replacing in note B used note A's
 * offsets, so unrelated text in the new note was overwritten — and the note was
 * autosaved — and a shorter document threw an uncaught `RangeError` from
 * `tr.insertText`, which looked like the button doing nothing.
 *
 * A range is kept only when it lies inside the document, still contains the
 * queried text, and does not overlap a range already accepted (overlaps cannot
 * come from a fresh scan, so they mean the cache is stale).
 */
function validRanges(view: EditorView, ranges: FindRange[], query: string): FindRange[] {
  if (!query) return []
  const size = view.state.doc.content.size
  const kept: FindRange[] = []
  for (const range of ranges) {
    if (range.from < 0 || range.to > size || range.from >= range.to) continue
    if (range.to > view.state.doc.content.size) continue
    let text: string
    try {
      text = view.state.doc.textBetween(range.from, range.to)
    } catch {
      continue
    }
    if (text.toLowerCase() !== query.toLowerCase()) continue
    if (kept.length > 0 && kept[kept.length - 1].to > range.from) continue
    kept.push(range)
  }
  return kept
}

export function replaceCurrent(): void {
  const view = getView()
  if (!view) return
  const { active, replace, query } = renderSearchState
  const ranges = validRanges(view, renderSearchState.ranges, query)
  if (ranges.length !== renderSearchState.ranges.length) {
    // The cache did not describe this document: rescan rather than rewrite at
    // positions that mean something else here.
    renderSearchState.ranges = ranges
  }
  const range = ranges[Math.min(active, ranges.length - 1)]
  if (!range) {
    refreshOverlays()
    return
  }
  view.dispatch(view.state.tr.insertText(replace, range.from, range.to))
  refreshOverlays()
}

export function replaceAll(): void {
  const view = getView()
  if (!view) return
  const { replace, query } = renderSearchState
  const ranges = validRanges(view, renderSearchState.ranges, query)
  if (!ranges.length) {
    renderSearchState.ranges = []
    renderSearchState.active = 0
    refreshOverlays()
    return
  }
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
