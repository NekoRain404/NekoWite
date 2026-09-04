import { $view } from '@milkdown/utils'
import { headingSchema } from '@milkdown/preset-commonmark'
import type { NodeViewConstructor } from '@milkdown/prose/view'

import { copyText } from '../clipboard'
import { slugify } from '../slugify'

// UI-only enhancement for the commonmark `heading` node: a trailing "#" anchor
// that copies a deep-link fragment for the heading on click. The heading's
// inline content is kept inside a content DOM so ProseMirror still manages
// editing; the anchor button lives outside it, purely decorative. The URL is
// built by an injectable builder (default: `#slug`) so the host app can prefix
// it with the vault/path. Never mutates the document model, so saving is
// byte-faithful.

export type HeadingAnchorUrlBuilder = (slug: string) => string

const defaultUrl = (slug: string): string => `#${slug}`

let buildUrl: HeadingAnchorUrlBuilder = defaultUrl

export function configureHeadingAnchorUrl(builder: HeadingAnchorUrlBuilder | null): void {
  buildUrl = builder ?? defaultUrl
}

export const makeHeadingAnchorNodeView: NodeViewConstructor = (node) => {
  const level = Number(node.attrs.level ?? 1)
  const headingEl = document.createElement(`h${level}`)
  headingEl.className = 'nk-heading'

  const content = document.createElement('span')
  content.className = 'nk-heading-content'
  headingEl.appendChild(content)

  const anchor = document.createElement('button')
  anchor.type = 'button'
  anchor.className = 'nk-heading-anchor'
  anchor.contentEditable = 'false'
  anchor.setAttribute('aria-label', 'Copy link')
  // The "#" glyph is rendered by the host stylesheet (::before) rather than as
  // a real text node, so the heading's own textContent stays clean (the copy
  // link is presentational, not part of the heading text). The aria-label keeps
  // the button accessible for screen readers regardless of visual state.
  headingEl.appendChild(anchor)

  let slug = ''

  const render = (): void => {
    slug = slugify(node.textContent)
  }
  render()

  anchor.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  anchor.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    void copyText(buildUrl(slug))
  })

  return {
    dom: headingEl,
    contentDOM: content,
    ignoreMutation: (mutation) => {
      const target = mutation.target as Node | null
      return !target || !content.contains(target)
    },
    update: (newNode) => {
      if (newNode.type !== node.type) return false
      node = newNode
      render()
      return true
    },
    destroy: () => undefined,
  }
}

export const headingAnchorNodeView = $view(
  headingSchema.node,
  () => makeHeadingAnchorNodeView,
)
