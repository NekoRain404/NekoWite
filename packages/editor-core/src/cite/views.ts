import { $view, $prose } from '@milkdown/utils'
import { Plugin } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import type { NodeViewConstructor } from '@milkdown/prose/view'
import { cite } from './node'
import { citeToMarkdown } from './node'

/** How the app answers "does the library hold this cite key?".
 *
 *  editor-core owns the document, not the reference library, so the host
 *  publishes its lookup here. Without it a citation whose key is NOT in the
 *  library rendered exactly like a resolved one — `[3]`, in the same numbering
 *  sequence — so neither the writer nor a reader could tell that the number
 *  pointed at nothing. */
let citeKeyResolver: ((key: string) => boolean) | null = null

/** `0` marks a key the resolver rejected: the chip and the panel show `[?]`,
 *  and the numbered sequence counts only references that resolve, so a citation
 *  number never points at a missing entry. */
export const CITE_UNRESOLVED = 0

/** The class a missing-key chip carries, so the host's stylesheet can call it
 *  out without editor-core owning the wording. */
export const CITE_MISSING_CLASS = 'cite-chip-missing'

export function setCiteKeyResolver(resolver: ((key: string) => boolean) | null): void {
  citeKeyResolver = resolver
  // Numbering depends on the resolver, so a library that just changed must not
  // be answered from the previous document's cached order.
  cachedDoc = null
  chipRenderers.forEach((render) => render())
}

/** Re-render every live chip (and the numbering the references panel reads)
 *  after the library changed while the document did not. */
export function refreshCiteChips(): void {
  cachedDoc = null
  chipRenderers.forEach((render) => render())
}

export function computeCiteOrder(view: EditorView): Map<string, number> {
  return citeOrderFor(view)
}

function orderForDoc(doc: EditorView['state']['doc']): Map<string, number> {
  const order = new Map<string, number>()
  let n = 0
  doc.descendants((node) => {
    if (node.type.name === 'cite') {
      const key = String(node.attrs.key ?? '')
      if (!order.has(key)) {
        const resolves = citeKeyResolver ? citeKeyResolver(key) : true
        if (resolves) n += 1
        order.set(key, resolves ? n : CITE_UNRESOLVED)
      }
    }
    return true
  })
  return order
}

/**
 * Cite numbering cache, keyed by the ProseMirror document.
 *
 * Numbering a cite means walking the whole document to find the first occurrence
 * of every key. That is O(document) work, and it used to happen once PER CHIP in
 * every doc-changing transaction: 400 cites measured ~28ms per keystroke and 800
 * cites ~96ms, because each transaction re-rendered every chip and each chip
 * re-walked the document. Documents are immutable, so the map only has to be
 * computed once per document version and can be shared by every chip that reads
 * it — which is what this cache does. `countCiteOrderComputations` exposes the
 * work for the regression test.
 */
let cachedDoc: EditorView['state']['doc'] | null = null
let cachedOrder: Map<string, number> = new Map()
let computations = 0

/** The numbering for the document, computing it only when the document changed. */
function citeOrderFor(view: EditorView): Map<string, number> {
  if (cachedDoc !== view.state.doc) {
    cachedOrder = orderForDoc(view.state.doc)
    cachedDoc = view.state.doc
    computations += 1
  }
  return cachedOrder
}

/** How many full-document order walks have happened (test hook). */
export function countCiteOrderComputations(): number {
  return computations
}

/** Reset the computation counter (test hook). */
export function resetCiteOrderComputationCount(): void {
  computations = 0
}

const chipRenderers = new Set<() => void>()

function registerChipRenderer(render: () => void): () => void {
  chipRenderers.add(render)
  return () => {
    chipRenderers.delete(render)
  }
}

// ProseMirror does not call `update` on node views whose position merely shifts,
// so chips go stale when a cite is inserted before existing ones. This prose
// plugin re-renders every live chip on a doc-changing transaction — the renders
// all read the ONE numbering map built for the new document.
export const citeOrderSyncPlugin = $prose(
  () =>
    new Plugin({
      view: () => ({
        update: (view, prevState) => {
          if (view.state.doc === prevState.doc) return
          // `render` reads the cache, so this has to be refreshed before the chips
          // are asked for their new numbers.
          citeOrderFor(view)
          chipRenderers.forEach((render) => render())
        },
      }),
    }),
)

const makeCiteNodeView: NodeViewConstructor = (node, view, getPos) => {
  const dom = document.createElement('span')
  dom.className = 'cite-chip'
  dom.setAttribute('data-cite-key', String(node.attrs.key ?? ''))

  const render = () => {
    const pos = typeof getPos === 'function' ? getPos() : null
    let number = '?'
    if (pos != null) {
      const order = citeOrderFor(view)
      number = String(order.get(String(node.attrs.key ?? '')) ?? '?')
    }
    const unresolved = number === String(CITE_UNRESOLVED)
    dom.textContent = `[${unresolved ? '?' : number}]`
    dom.classList.toggle(CITE_MISSING_CLASS, unresolved)
    if (unresolved) dom.setAttribute('data-cite-missing', 'true')
    else dom.removeAttribute('data-cite-missing')
    dom.title = citeToMarkdown(String(node.attrs.key ?? ''))
  }
  render()
  const unregister = registerChipRenderer(render)

  return {
    dom,
    inline: true,
    update: (newNode) => {
      if (newNode.type !== node.type) return false
      node = newNode
      render()
      return true
    },
    destroy: () => {
      unregister()
    },
  }
}

export const citeNodeView = $view(cite, () => makeCiteNodeView)
