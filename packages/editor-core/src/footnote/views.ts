import { $view } from '@milkdown/utils'
import { footnoteReferenceSchema } from '@milkdown/preset-gfm'
import type { NodeViewConstructor } from '@milkdown/prose/view'

// gfm already parses/serializes footnotes; this node view only adds visual
// styling for the inline reference chip. Styling lives inline (via CSS vars)
// because editor-core ships no stylesheet of its own.
const makeFootnoteReferenceNodeView: NodeViewConstructor = (node) => {
  const dom = document.createElement('sup')
  dom.className = 'footnote-ref'
  dom.style.color = 'var(--app-accent, #6e8bd6)'
  dom.style.fontSize = '0.75em'
  dom.style.lineHeight = '1'
  dom.style.marginLeft = '0.15em'
  dom.style.cursor = 'default'

  const render = (): void => {
    const label = String(node.attrs.label ?? '')
    dom.setAttribute('data-label', label)
    dom.textContent = label
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
    destroy: () => undefined,
  }
}

export const footnoteReferenceNodeView = $view(
  footnoteReferenceSchema.node,
  () => makeFootnoteReferenceNodeView,
)
