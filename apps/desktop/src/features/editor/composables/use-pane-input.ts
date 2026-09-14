import { watch } from 'vue'
import { getSourceView } from '../../../services/source-view'
import { noteFocusedPane } from '../../../services/editor-ownership'

export interface PaneInputHandlers {
  /** Image paste, registered in the capture phase (see below). */
  onPaste: (e: ClipboardEvent) => void
  onDrop: (e: DragEvent) => void
  onDragOver: (e: DragEvent) => void
}

/**
 * The pane container's shared input plumbing: paste / drop / dragover and the
 * focus bookkeeping that tells a command which pane the user is working in.
 *
 * The listeners go on the pane container rather than on either pane. It is
 * created together with the first tab, so they follow the element rather than
 * the mount order (an empty app has no `.panes` to attach to yet), and one set
 * covers both panes — the source pane used to have no handler at all, which is
 * why pasting an image in source mode fell through to the raw-text paste.
 */
export function usePaneInput(
  getPanesEl: () => HTMLElement | null,
  handlers: PaneInputHandlers,
): { attach: (el: HTMLElement | null) => void } {
  let listenersOn: HTMLElement | null = null

  function onFocusIn(e: FocusEvent): void {
    const target = e.target as Node | null
    if (!target) return
    const sourceDom = getSourceView()?.dom
    if (sourceDom && sourceDom.contains(target)) {
      noteFocusedPane('source')
      return
    }
    const renderedEl = getPanesEl()?.querySelector('.pane.rendered')
    if (renderedEl && renderedEl.contains(target)) noteFocusedPane('rendered')
  }

  function attach(el: HTMLElement | null): void {
    if (listenersOn === el) return
    if (listenersOn) {
      listenersOn.removeEventListener('paste', handlers.onPaste, true)
      listenersOn.removeEventListener('drop', handlers.onDrop, true)
      listenersOn.removeEventListener('dragover', handlers.onDragOver)
      listenersOn.removeEventListener('dragenter', handlers.onDragOver)
      listenersOn.removeEventListener('focusin', onFocusIn)
    }
    listenersOn = el
    if (!el) return
    // Capture phase, on an ancestor of both panes: this must run before
    // ProseMirror's and CodeMirror's own at-target handlers, or an image paste
    // would already have been consumed as HTML / a file path.
    el.addEventListener('paste', handlers.onPaste, true)
    el.addEventListener('drop', handlers.onDrop, true)
    el.addEventListener('dragover', handlers.onDragOver)
    el.addEventListener('dragenter', handlers.onDragOver)
    el.addEventListener('focusin', onFocusIn)
  }

  // The container appears with the first tab and stays, but the watcher is what
  // makes the listeners follow it rather than the pane's own mount order.
  watch(getPanesEl, (el) => attach(el))

  return { attach }
}
