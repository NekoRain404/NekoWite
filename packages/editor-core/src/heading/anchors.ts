import { $view } from '@milkdown/utils'
import { headingSchema } from '@milkdown/preset-commonmark'
import type { NodeViewConstructor } from '@milkdown/prose/view'

import { copyText } from '../clipboard'
import { headingAnchorIds } from '../slugify'

// UI-only enhancement for the commonmark `heading` node: a trailing "#" anchor
// that copies a deep-link fragment for the heading on click. The heading's
// inline content is kept directly inside the heading element so ProseMirror
// sees the full h1-h6 as its content DOM. The anchor button lives inside the
// heading but is non-editable and ignored by mutation sync, purely decorative.
// The URL is built by an injectable builder (default: `#slug`) so the host app
// can prefix it with the vault/path. Never mutates the document model, so
// saving is byte-faithful.

export type HeadingAnchorUrlBuilder = (slug: string) => string

const defaultUrl = (slug: string): string => `#${slug}`

let buildUrl: HeadingAnchorUrlBuilder = defaultUrl

export function configureHeadingAnchorUrl(builder: HeadingAnchorUrlBuilder | null): void {
  buildUrl = builder ?? defaultUrl
}

export const makeHeadingAnchorNodeView: NodeViewConstructor = (node, view, getPos) => {
  const level = Number(node.attrs.level ?? 1)
  // A heading node view must keep ALL editable pixels inside ProseMirror's
  // content DOM. The anchor button is therefore an absolutely-positioned UI
  // element outside the h1, so clicking the blank space after short heading
  // text always lands inside contentDOM. If it were inline, Chromium could
  // place the DOM caret on the h1 (outside contentDOM) after Enter/Backspace,
  // making the model and DOM diverge and later keys (e.g. "/") land in the
  // wrong node.
  const wrapper = document.createElement('div')
  wrapper.className = 'nk-heading'
  wrapper.dataset.headingLevel = String(level)
  const headingEl = document.createElement(`h${level}`)
  headingEl.className = 'nk-heading-content'
  wrapper.appendChild(headingEl)

  const anchor = document.createElement('button')
  anchor.type = 'button'
  anchor.className = 'nk-heading-anchor'
  anchor.contentEditable = 'false'
  anchor.setAttribute('aria-label', 'Copy link')
  wrapper.appendChild(anchor)

  /**
   * The id this heading owns, resolved at click time.
   *
   * Ids are a document-wide list (see `headingAnchorIds`), so a heading cannot
   * know its own from its text alone: the second "Same" is `same-1`, not
   * `same`. Computing it lazily keeps the cost off every render — a click is
   * the only moment it matters — and makes the copied link resolve to THIS
   * heading instead of the first one with the same title.
   */
  const idAt = (): string => {
    const doc = view?.state.doc
    const pos = typeof getPos === 'function' ? getPos() : undefined
    if (!doc || pos === undefined) return headingAnchorIds([node.textContent])[0]
    const texts: string[] = []
    let mine = 0
    doc.descendants((child, childPos) => {
      if (child.type.name !== 'heading') return true
      if (childPos === pos) mine = texts.length
      texts.push(child.textContent)
      return true
    })
    return headingAnchorIds(texts)[mine]
  }

  anchor.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  anchor.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    void copyText(buildUrl(idAt()))
  })

  return {
    dom: wrapper,
    contentDOM: headingEl,
    ignoreMutation: (mutation) => {
      // Mutations in the anchor button are presentational and must never feed
      // back into the model. Mutations in the editable h1 are the real
      // document and must be observed.
      const target = mutation.target as Node | null
      return !target || !headingEl.contains(target)
    },
    update: (newNode) => {
      if (newNode.type !== node.type) return false
      node = newNode
      // The id is derived on demand, so an update only has to adopt the node.
      return true
    },
    destroy: () => undefined,
  }
}

export const headingAnchorNodeView = $view(
  headingSchema.node,
  () => makeHeadingAnchorNodeView,
)
