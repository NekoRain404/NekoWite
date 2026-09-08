import { $view } from '@milkdown/utils'
import type { NodeViewConstructor } from '@milkdown/prose/view'
import { mathDisplay, mathInline } from './nodes'
import { renderLatexMarkup, warmMathLive } from './atoms'
import { openMathDialog } from './dialog'

const makeMathNodeView =
  (mode: 'inline' | 'display'): NodeViewConstructor =>
  (node, view, getPos) => {
    warmMathLive()
    const dom = document.createElement(mode === 'inline' ? 'span' : 'div')
    dom.className = `math-node math-${mode}`

    const render = () => {
      dom.innerHTML = renderLatexMarkup(String(node.attrs.latex ?? ''))
    }
    render()

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
      destroy: () => dom.removeEventListener('click', onClick),
    }
  }

export const mathInlineNodeView = $view(mathInline, () => makeMathNodeView('inline'))
export const mathDisplayNodeView = $view(mathDisplay, () => makeMathNodeView('display'))
