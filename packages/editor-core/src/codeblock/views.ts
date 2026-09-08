import { $view } from '@milkdown/utils'
import { codeBlockSchema } from '@milkdown/preset-commonmark'
import type { NodeViewConstructor } from '@milkdown/prose/view'

import { copyText } from '../clipboard'

// UI-only enhancement for the commonmark `code_block`. Milkdown renders a
// fenced code block as `pre > code`; this view wraps it in a positioning
// context and mounts a corner "copy" button that copies the raw block text.
// It never touches the document model, so `editor.save()` round-trips
// byte-faithfully. The button is icon-only (locale-free) so editor-core
// carries no i18n dependency.

const COPY = 1200

const svg = (inner: string): string =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`

const COPY_ICON =
  '<rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>'
const CHECK_ICON = '<path d="M20 6 9 17l-5-5"></path>'

export const makeCodeBlockNodeView: NodeViewConstructor = (node) => {
  const dom = document.createElement('div')
  dom.className = 'nk-code-block'

  const pre = document.createElement('pre')
  const code = document.createElement('code')
  pre.appendChild(code)
  dom.appendChild(pre)

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'nk-code-copy'
  button.contentEditable = 'false'
  button.innerHTML = `${svg(COPY_ICON)}<span class="nk-code-copy-state">${svg(CHECK_ICON)}</span>`
  dom.appendChild(button)

  let copiedTimer: ReturnType<typeof setTimeout> | null = null

  const render = (): void => {
    const language = String(node.attrs.language ?? '')
    if (language) pre.dataset.language = language
    else delete pre.dataset.language
  }
  render()

  const markCopied = (): void => {
    dom.classList.add('nk-copied')
  }
  const clearCopied = (): void => {
    dom.classList.remove('nk-copied')
  }

  button.addEventListener('pointerdown', (event) => {
    // Keep the click from stealing the caret from the code block.
    event.preventDefault()
    event.stopPropagation()
  })
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    void copyText(node.textContent)
    markCopied()
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(clearCopied, COPY)
  })

  return {
    dom,
    contentDOM: code,
    ignoreMutation: (mutation) => {
      const target = mutation.target as Node | null
      // ProseMirror reconciles only the content DOM (<code>). Mutations on the
      // button/wrapper are ours — ignore them so a click cannot be rewritten.
      return !target || !code.contains(target)
    },
    update: (newNode) => {
      if (newNode.type !== node.type) return false
      node = newNode
      render()
      return true
    },
    destroy: () => {
      if (copiedTimer) clearTimeout(copiedTimer)
    },
  }
}

export const codeBlockCopyNodeView = $view(
  codeBlockSchema.node,
  () => makeCodeBlockNodeView,
)
