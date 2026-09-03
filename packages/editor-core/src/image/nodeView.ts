import { $view } from '@milkdown/utils'
import { imageSchema } from '@milkdown/preset-commonmark'
import type { NodeViewConstructor } from '@milkdown/prose/view'

import { resolveImageSrc } from './resolver'

/**
 * Node view for the commonmark `image` node.
 *
 * The schema's own toDOM already renders an <img> whose src attribute is the
 * raw document src (vault-relative path — kept faithful for serialization).
 * This node view renders the element and, when an async resolver has been
 * configured, swaps in the display URL (asset:/data:) without touching the
 * document model, so saving round-trips the original path byte-faithfully.
 */
export const makeImageNodeView: NodeViewConstructor = (node) => {
  const dom = document.createElement('img')
  // Bumped on every render and on destroy; only the latest render may apply
  // its async resolution result to the DOM.
  let version = 0

  const render = (): void => {
    const src = String(node.attrs.src ?? '')
    if (node.attrs.alt) dom.setAttribute('alt', String(node.attrs.alt))
    else dom.removeAttribute('alt')
    if (node.attrs.title) dom.setAttribute('title', String(node.attrs.title))
    else dom.removeAttribute('title')
    const mine = ++version
    if (!src) {
      dom.removeAttribute('src')
      return
    }
    // Show the raw src immediately (it may already be displayable), then let
    // the resolver — when configured — replace it with the display URL.
    dom.setAttribute('src', src)
    void resolveImageSrc(src).then((display) => {
      if (version === mine) dom.setAttribute('src', display)
    })
  }
  render()

  return {
    dom,
    ignoreMutation: () => true,
    update: (newNode) => {
      if (newNode.type !== node.type) return false
      node = newNode
      render()
      return true
    },
    destroy: () => {
      version += 1
    },
  }
}

// `imageSchema` is the preset's [$Ctx, $Node] tuple; `.node` is the $Node
// that $view expects (its runtime check routes by NodeType instance).
export const imageNodeView = $view(imageSchema.node, () => makeImageNodeView)
