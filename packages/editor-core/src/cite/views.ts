import { $view, $prose } from '@milkdown/utils'
import { Plugin } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import type { NodeViewConstructor } from '@milkdown/prose/view'
import { cite } from './node'
import { citeToMarkdown } from './node'

export function computeCiteOrder(view: EditorView): Map<string, number> {
  const order = new Map<string, number>()
  let n = 0
  view.state.doc.descendants((node) => {
    if (node.type.name === 'cite') {
      const key = String(node.attrs.key ?? '')
      if (!order.has(key)) order.set(key, ++n)
    }
    return true
  })
  return order
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
// plugin re-renders every live chip on any doc-changing transaction.
export const citeOrderSyncPlugin = $prose(
  () =>
    new Plugin({
      view: () => ({
        update: (view, prevState) => {
          if (view.state.doc !== prevState.doc) {
            chipRenderers.forEach((render) => render())
          }
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
      const order = computeCiteOrder(view)
      number = String(order.get(String(node.attrs.key ?? '')) ?? '?')
    }
    dom.textContent = `[${number}]`
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
