import { $view } from '@milkdown/utils'
import type { NodeViewConstructor } from '@milkdown/prose/view'

import { resolveImageSrc } from './resolver'
import { imageDimSchema } from './schema'
import { nextWidth, proportionalSize } from './resize'
import { advanceResizeDrag, beginResizeDrag, commitResizeDrag } from './drag'

/**
 * Node view for the commonmark `image` node.
 *
 * The schema's own toDOM already renders an <img> whose src attribute is the
 * raw document src (vault-relative path — kept faithful for serialization).
 * This node view wraps the element in a `<figure>` and:
 *  - renders the <img> (display URL resolved async without touching the model);
 *  - shows a selected state (outline + a visible resize handle) when the node
 *    is under a NodeSelection;
 *  - drags the bottom-right handle to resize width (or width+height
 *    proportionally with Shift held), coalescing the whole drag into ONE
 *    transaction (one undo step);
 *  - shows a recoverable error placeholder when the image fails to load.
 */
export const makeImageNodeView: NodeViewConstructor = (node, view, getPos) => {
  const dom = document.createElement('figure')
  dom.className = 'neko-image'
  dom.setAttribute('data-selected', 'false')

  const img = document.createElement('img')
  const handle = document.createElement('span')
  handle.className = 'neko-image-handle'
  handle.setAttribute('aria-hidden', 'true')
  handle.setAttribute('data-testid', 'neko-image-handle')

  const errorBox = document.createElement('div')
  errorBox.className = 'neko-image-error'
  const errorMsg = document.createElement('span')
  errorMsg.className = 'neko-image-error-msg'
  const retryBtn = document.createElement('button')
  retryBtn.className = 'neko-image-error-retry'
  retryBtn.type = 'button'
  retryBtn.textContent = 'Retry'
  errorBox.appendChild(errorMsg)
  errorBox.appendChild(retryBtn)
  errorBox.setAttribute('hidden', '')

  dom.appendChild(img)
  dom.appendChild(handle)
  dom.appendChild(errorBox)

  // Bumped on every render and on destroy; only the latest render may apply
  // its async resolution result to the DOM.
  let version = 0
  let failedSrc: string | null = null

  const applyDims = (): void => {
    const width = Number(node.attrs.width)
    if (Number.isFinite(width) && width > 0) img.style.width = `${width}px`
    else img.style.width = ''

    const height = Number(node.attrs.height)
    if (Number.isFinite(height) && height > 0) img.style.height = `${height}px`
    else img.style.height = ''

    const align = String(node.attrs.align ?? '')
    if (align === 'center') {
      img.style.display = 'block'
      img.style.marginLeft = 'auto'
      img.style.marginRight = 'auto'
      img.style.float = ''
    } else if (align === 'left') {
      img.style.float = 'left'
      img.style.display = ''
      img.style.marginLeft = ''
      img.style.marginRight = ''
    } else if (align === 'right') {
      img.style.float = 'right'
      img.style.display = ''
      img.style.marginLeft = ''
      img.style.marginRight = ''
    } else {
      img.style.float = ''
      img.style.display = ''
      img.style.marginLeft = ''
      img.style.marginRight = ''
    }
  }

  const applyFailed = (failed: boolean): void => {
    if (failed) {
      dom.setAttribute('data-failed', 'true')
      errorBox.removeAttribute('hidden')
    } else {
      dom.setAttribute('data-failed', 'false')
      errorBox.setAttribute('hidden', '')
    }
  }

  const render = (): void => {
    const src = String(node.attrs.src ?? '')
    const alt = String(node.attrs.alt ?? '')
    if (alt) img.setAttribute('alt', alt)
    else img.removeAttribute('alt')
    if (node.attrs.title) img.setAttribute('title', String(node.attrs.title))
    else img.removeAttribute('title')
    applyDims()
    const mine = ++version
    // a11y: expose the image role + the alt/aria label on the wrapper so screen
    // readers announce it even when the layout wraps it in a figure.
    dom.setAttribute('role', 'img')
    if (alt) dom.setAttribute('aria-label', alt)
    else dom.removeAttribute('aria-label')
    if (!src) {
      img.removeAttribute('src')
      applyFailed(true)
      errorMsg.textContent = 'Missing image source'
      return
    }
    applyFailed(false)
    failedSrc = src
    // Show the raw src immediately (it may already be displayable), then let
    // the resolver — when configured — replace it with the display URL.
    img.setAttribute('src', src)
    void resolveImageSrc(src).then((display) => {
      if (version === mine) img.setAttribute('src', display)
    })
  }
  render()

  img.addEventListener('error', () => {
    if (version === 0) return
    applyFailed(true)
    errorMsg.textContent = 'Image failed to load'
  })

  retryBtn.addEventListener('pointerdown', (e) => e.stopPropagation())
  retryBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!failedSrc) return
    applyFailed(false)
    const mine = ++version
    img.setAttribute('src', `${failedSrc}?retry=${Date.now()}`)
    void resolveImageSrc(failedSrc).then((display) => {
      if (version === mine) img.setAttribute('src', display)
    })
  })

  // The resize handle plus the bottom-right corner of the image both initiate
  // a drag. The handle is the clear affordance; the corner keeps the legacy
  // behavior (and the existing drag test) working.
  const startDrag = (event: PointerEvent): void => {
    if (!view || typeof getPos !== 'function') return
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const w = Number(node.attrs.width) || img.clientWidth || 0
    const naturalW = img.naturalWidth || 0
    const naturalH = img.naturalHeight || 0
    const startWidth = w || naturalW || 1
    const startHeight = Number(node.attrs.height) || naturalH || Math.round(startWidth * 0.75)
    const startX = event.clientX
    let drag = beginResizeDrag(startWidth)
    let proportional = event.shiftKey
    const onMove = (ev: PointerEvent): void => {
      const pos = getPos()
      if (typeof pos !== 'number') return
      const target = nextWidth(startWidth, ev.clientX - startX)
      proportional = ev.shiftKey
      if (ev.shiftKey) {
        const { width, height } = proportionalSize(startWidth, startHeight, target)
        drag = advanceResizeDrag(drag, pos, width)
        img.style.width = `${width}px`
        img.style.height = `${height}px`
      } else {
        drag = advanceResizeDrag(drag, pos, target)
        img.style.width = `${target}px`
        img.style.height = ''
      }
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const commit = commitResizeDrag(drag)
      if (commit) {
        const attrs: Record<string, unknown> = { ...node.attrs, width: commit.width }
        if (proportional) {
          const { height } = proportionalSize(startWidth, startHeight, commit.width)
          attrs.height = height
        } else {
          attrs.height = null
        }
        const tr = view.state.tr.setNodeMarkup(commit.pos, undefined, attrs)
        view.dispatch(tr)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  handle.addEventListener('pointerdown', startDrag)
  img.addEventListener('pointerdown', startDrag)
  // Clicking the wrapper selects the node via the editor's selection; the
  // handle/error button must never bubble into a drag or a selection reset.
  handle.addEventListener('click', (e) => e.stopPropagation())
  img.addEventListener('click', (e) => e.stopPropagation())

  return {
    dom,
    ignoreMutation: () => true,
    selectNode: () => dom.setAttribute('data-selected', 'true'),
    deselectNode: () => dom.setAttribute('data-selected', 'false'),
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
