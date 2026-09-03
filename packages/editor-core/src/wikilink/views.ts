import { $view } from '@milkdown/utils'
import type { NodeViewConstructor } from '@milkdown/prose/view'

import { wikilink } from './node'

export type WikilinkClickHandler = (target: string, alias: string) => void

let wikilinkClickHandler: WikilinkClickHandler | null = null

/** Install the host-side handler invoked on Ctrl/Cmd+click of a wikilink chip.
 * When none is configured the chip renders as a no-op styled link. */
export function configureWikilinkHandler(handler: WikilinkClickHandler | null): void {
  wikilinkClickHandler = handler
}

const makeWikilinkNodeView: NodeViewConstructor = (node) => {
  const dom = document.createElement('span')
  dom.className = 'wikilink-chip'
  dom.setAttribute('data-wikilink', '')

  let target = ''
  let alias = ''

  const render = (): void => {
    target = String(node.attrs.target ?? '')
    alias = String(node.attrs.alias ?? '')
    dom.setAttribute('data-target', target)
    dom.setAttribute('data-href', target)
    dom.title = alias ? `${target} (${alias})` : target
    dom.textContent = alias || target
  }
  render()

  dom.addEventListener('click', (event) => {
    const handler = wikilinkClickHandler
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    handler?.(target, alias)
  })

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

export const wikilinkNodeView = $view(wikilink, () => makeWikilinkNodeView)
