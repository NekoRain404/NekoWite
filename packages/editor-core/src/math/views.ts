import { $view } from '@milkdown/utils'
import type { NodeViewConstructor } from '@milkdown/prose/view'
import { mathDisplay, mathInline } from './nodes'
import { renderLatexMarkup, warmMathLive } from './atoms'
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
     * Render again once MathLive is here, because the first render may have been too early.
     *
     * `renderLatexMarkup` falls back to the escaped LaTeX while the library is still being imported, and
     * this view renders on create and on update only — an update arrives with a document change. So a note
     * opened before the import finished showed its formulas as source text (`x^2 + y^2 = z^2`) for as long
     * as it stayed open, and rendered correctly the moment it was left and opened again. Measured in the
     * built application at 4 s, 12 s and 24 s and again after a round trip
     * (`apps/desktop/e2e/webkit/probe-egress.mjs`); the case in `views.test.ts` is the same sequence with
     * the import gated.
     *
     * The flag rather than a listener: this promise outlives the view whenever the note is closed while
     * the library is still loading, and writing into a detached element afterwards would be a leak with a
     * render in it.
     */
    let destroyed = false
    void warmMathLive().then(() => {
      if (!destroyed) render()
    })

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
        destroyed = true
        dom.removeEventListener('click', onClick)
      },
    }
  }

export const mathInlineNodeView = $view(mathInline, () => makeMathNodeView('inline'))
export const mathDisplayNodeView = $view(mathDisplay, () => makeMathNodeView('display'))
