import { onBeforeUnmount, onMounted } from 'vue'
import { modalStack } from '../services/modalStack'
import { isComposingKey } from '../services/keyGuard'

/**
 * Close a dialog on Escape — but only when it is the dialog on top.
 *
 * Every modal in the app listens for Escape, and the listeners all sit on
 * `window`/`document`. Listeners registered on the same target cannot cancel
 * each other (`stopPropagation` only stops nodes further along the path), so
 * without arbitration one Escape press closed *every* open dialog at once. The
 * stack decides which one is actually on top; this composable is the shared
 * wiring for that, so a new dialog cannot forget it.
 *
 * The listener is global rather than scoped to the dialog element on purpose:
 * a modal must answer Escape even when nothing inside it has focus yet, which
 * is exactly the state a freshly opened dialog starts in.
 */
export function useModalEscape(label: string, onEscape: () => void): void {
  const token = modalStack.claimModal(label)

  function onKeydown(e: KeyboardEvent): void {
    // Let an IME dismiss its candidate list first.
    if (isComposingKey(e)) return
    if (e.key !== 'Escape') return
    if (!modalStack.isTopModal(token)) return
    e.preventDefault()
    onEscape()
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeydown, true)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown, true)
    modalStack.releaseModal(token)
  })
}
