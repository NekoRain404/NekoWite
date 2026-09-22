import { $view } from '@milkdown/utils'
import type { NodeViewConstructor } from '@milkdown/prose/view'
import { mathDisplay, mathInline } from './nodes'
import { mathLiveReady, renderLatexMarkup, warmMathLive, whenMathLiveReady } from './atoms'
import { openMathDialog } from './dialog'

const makeMathNodeView =
  (mode: 'inline' | 'display'): NodeViewConstructor =>
  (node, view, getPos) => {
    const dom = document.createElement(mode === 'inline' ? 'span' : 'div')
    dom.className = `math-node math-${mode}`

    const render = () => {
      dom.innerHTML = renderLatexMarkup(String(node.attrs.latex ?? ''))
    }
    render()

    /**
     * Render again when MathLive arrives, because the first render may have been too early.
     *
     * `renderLatexMarkup` falls back to the escaped LaTeX while the library is still being imported, and
     * this view renders on create and on update only — an update arrives with a document change. So a note
     * opened before the import finished showed its formulas as source text (`x^2 + y^2 = z^2`) for as long
     * as it stayed open, and rendered correctly the moment it was left and opened again. Measured in the
     * built application at 4 s, 12 s and 24 s and again after a round trip
     * (`apps/desktop/e2e/webkit/probe-egress.mjs`).
     *
     * Asked of `mathLiveReady` first, so a note opened once the library is loaded renders **once**, and
     * subscribed rather than bound to one promise because the loader retries: a failed import clears its
     * cache, and a promise this view already held could never resolve to that later success.
     */
    const stopWaiting = mathLiveReady() ? null : whenMathLiveReady(render)
    // A view that had to fall back is itself the reason to load the library, and the import is what
    // eventually tells the listeners above. It is *not* the only attempt: the loader clears its cache on
    // failure, so the next math node — or the next open of this note — starts a fresh one, and this view
    // is still on the list when that attempt succeeds.
    if (stopWaiting) void warmMathLive()

    const onClick = (e: Event): void => {
      e.preventDefault()
      e.stopPropagation()
      const pos = typeof getPos === 'function' ? getPos() : null
      openMathDialog(view, {
        mode,
        latex: String(node.attrs.latex ?? ''),
        existingPos: pos,
        schema: view.state.schema,
      })
    }
    dom.addEventListener('click', onClick)

    return {
      dom,
      ...(mode === 'inline' ? { inline: true } : {}),
      update: (newNode) => {
        if (newNode.type !== node.type) return false
        node = newNode
        render()
        return true
      },
      destroy: () => {
        stopWaiting?.()
        dom.removeEventListener('click', onClick)
      },
    }
  }

export const mathInlineNodeView = $view(mathInline, () => makeMathNodeView('inline'))
export const mathDisplayNodeView = $view(mathDisplay, () => makeMathNodeView('display'))
