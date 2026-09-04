import { $view } from '@milkdown/utils'
import type { NodeViewConstructor } from '@milkdown/prose/view'

import { resolveImageSrc } from './resolver'
import { imageDimSchema } from './schema'
import { nextWidth } from './resize'
import { advanceResizeDrag, beginResizeDrag, commitResizeDrag } from './drag'

/**
 * Node view for the commonmark `image` node.
 *
 * The schema's own toDOM already renders an <img> whose src attribute is the
 * raw document src (vault-relative path — kept faithful for serialization).
 * This node view renders the element and, when an async resolver has been
 * configured, swaps in the display URL (asset:/data:) without touching the
 * document model, so saving round-trips the original path byte-faithfully.
 *
 * Width (and optional alignment) is applied as a display style; dragging the
 * bottom-right corner resizes the image by updating the attrs through a
 * single dispatched transaction.
 */
export const makeImageNodeView: NodeViewConstructor = (node, view, getPos) => {
  const dom = document.createElement('img')
  // Bumped on every render and on destroy; only the latest render may apply
  // its async resolution result to the DOM.
  let version = 0

  const applyDims = (): void => {
    const width = Number(node.attrs.width)
    if (Number.isFinite(width) && width > 0) dom.style.width = `${width}px`
    else dom.style.width = ''

    const align = String(node.attrs.align ?? '')
    if (align === 'center') {
      dom.style.display = 'block'
      dom.style.marginLeft = 'auto'
      dom.style.marginRight = 'auto'
      dom.style.float = ''
    } else if (align === 'left') {
      dom.style.float = 'left'
      dom.style.display = ''
      dom.style.marginLeft = ''
      dom.style.marginRight = ''
    } else if (align === 'right') {
      dom.style.float = 'right'
      dom.style.display = ''
      dom.style.marginLeft = ''
      dom.style.marginRight = ''
    } else {
      dom.style.float = ''
      dom.style.display = ''
      dom.style.marginLeft = ''
      dom.style.marginRight = ''
    }
  }

  const render = (): void => {
    const src = String(node.attrs.src ?? '')
    if (node.attrs.alt) dom.setAttribute('alt', String(node.attrs.alt))
    else dom.removeAttribute('alt')
    if (node.attrs.title) dom.setAttribute('title', String(node.attrs.title))
    else dom.removeAttribute('title')
    applyDims()
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

  // Resize by dragging the bottom-right corner of the rendered img. The corner
  // detection is deliberately cheap (no separate handle element) so the node
  // view keeps `dom` as the bare <img>; the corner zone is ~16px.
  dom.addEventListener('pointerdown', (event) => {
    if (!view || typeof getPos !== 'function') return
    const rect = dom.getBoundingClientRect()
    const dx = rect.right - event.clientX
    const dy = rect.bottom - event.clientY
    if (dx > 16 || dy > 16 || dx < 0 || dy < 0) return
    event.preventDefault()
    const startWidth = Number(node.attrs.width) || dom.clientWidth || 0
    const startX = event.clientX
    // A drag is one atomic gesture: buffer every move and commit a single
    // transaction (a single undo step) when the pointer lifts. The live visual
    // tracks the drag by applying the width to the DOM directly; the model
    // catches up once, on pointerup.
    let drag = beginResizeDrag(startWidth)
    const onMove = (ev: PointerEvent): void => {
      const pos = getPos()
      if (typeof pos !== 'number') return
      const next = nextWidth(startWidth, ev.clientX - startX)
      drag = advanceResizeDrag(drag, pos, next)
      dom.style.width = `${next}px`
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const commit = commitResizeDrag(drag)
      if (commit) {
        const tr = view.state.tr.setNodeMarkup(commit.pos, undefined, {
          ...node.attrs,
          width: commit.width,
        })
        view.dispatch(tr)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  })

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

// `imageDimSchema` is the extended preset [$Ctx, $Node] tuple; `.node` is the
// $Node that $view expects (its runtime check routes by NodeType instance).
export const imageNodeView = $view(imageDimSchema.node, () => makeImageNodeView)
