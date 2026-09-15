import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { emitLifecycle } from '@nekowite/plugin-host'
import { configureTaskChecklistRendering } from '@nekowite/editor-core'
import type { NekoEditor } from '@nekowite/editor-core'
import { useAppearanceStore } from '../../../stores/appearance'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { clearRefusedDocument, setRenderedFlush } from '../../../services/editor-ownership'
import { createDocumentSession } from '../model/document-session'
import { createEditorController } from '../controller/editor-controller'
import { createEditorExternalSync } from '../controller/editor-external-sync'
import { createEditorPersistence } from '../controller/editor-persistence'
import { createEditorScrollSync } from '../controller/editor-scroll-sync'
import { createEditorSearchOverlay } from '../controller/editor-search-overlay'
import { createEditorSelection } from '../controller/editor-selection'
import { useEditorFocus } from './use-editor-focus'

/** The pane's own delegated events, registered by this composable because they
 *  go on in the same synchronous block as the rest of the mount — see the note
 *  on `mount` below. */
export interface RenderedEditorStackHandlers {
  /** A click anywhere in the editor subtree (links, spell squiggles). */
  onEditorClick: (e: MouseEvent) => void
  /** Keydown on the window while the pane is mounted (Escape, Ctrl/Cmd+F). */
  onKeydown: (e: KeyboardEvent) => void
}

export interface RenderedEditorStackOptions {
  /** The pane's scroll container: scroll sync and typewriter centering. */
  getScrollEl: () => HTMLElement | null
  /** The editor's mount element, inside that container. */
  getEditorEl: () => HTMLElement | null
  handlers: RenderedEditorStackHandlers
}

/**
 * The rendered pane's editor stack: the whole controller wiring the pane used to
 * hold inline, from construct to teardown.
 *
 * The session, the six controllers built on it and every store subscription
 * that re-configures them are one unit — none of them is useful without the
 * others, and the order they are built, subscribed and torn down in is the
 * contract this module exists to keep in one place. The pane is what is left
 * over: two DOM refs, its delegated events and the template.
 *
 * What the callers must not rearrange:
 *
 * - The controllers are built in dependency order (`externalSync` reads the
 *   search overlay it schedules), and `useEditorFocus` is called after them so
 *   the word-goal watcher keeps its creation order among the others'.
 * - The store watchers are registered in a fixed order (spell, focus mode,
 *   task-list, tab content, view mode). Vue runs watchers created in the same
 *   flush in creation order, so a settings change that moves several of them
 *   lands in the pane in the order it always has.
 * - Mount runs its steps in order, and the listeners go on AFTER the first
 *   content apply has resolved: the change listeners must not see the open that
 *   mount itself performs.
 * - Teardown's order is a contract too — the flush hook is withdrawn before the
 *   serialization it publishes is cancelled, the editor is destroyed last, and
 *   the doc-change timer is dropped in a `finally` so an exception above cannot
 *   leave it armed.
 */
export function useRenderedEditorStack(options: RenderedEditorStackOptions) {
  const tabs = useTabsStore()
  const view = useViewStore()
  const appearance = useAppearanceStore()

  const session = createDocumentSession()
  /** The live editor, for the panels that decorate the document (image, table).
   *  Shallow: the editor is a large non-reactive object it must not be walked. */
  const editorForPanel = shallowRef<NekoEditor | null>(null)
  /** How many documents this pane's model has been given. Non-zero only while
   *  the apply landed for the tab that is still active: an apply that lost a
   *  race with a tab switch describes a document no tab is showing, and a
   *  position written on the strength of it would be a line of the wrong note.
   *  Published through the pane (see `RenderedPaneHandoff`) because the reading
   *  position cannot be written until the model holds the note. */
  const documentVersion = ref(0)

  const editorController = createEditorController({
    session,
    getEditorEl: () => options.getEditorEl(),
  })
  const persistence = createEditorPersistence({ session })
  const searchOverlay = createEditorSearchOverlay({
    session,
    getEditor: () => session.editor,
  })
  const externalSync = createEditorExternalSync({
    session,
    getEditor: () => session.editor,
    scheduleOverlayRefresh: () => searchOverlay.scheduleRefresh(),
    // The document switch's hand-off: a whole-document serialization of the
    // document the model is still holding, published to that document's tab
    // before `open()` replaces the model. The persistence layer owns both
    // halves (what the model holds, and where a serialization may land), so it
    // is handed over rather than reimplemented here.
    handOffPendingEdits: () => persistence.flush(),
    onDocumentApplied: (content) => {
      // The selection the model came with is not a caret the user placed (see
      // `getCaretLine`): recorded here, at the one moment that is true.
      scrollSync.markDocumentLoaded()
      if (tabs.activeTab?.content === content) documentVersion.value += 1
    },
  })
  const scrollSync = createEditorScrollSync({
    getScrollEl: () => options.getScrollEl(),
    getEditorEl: () => options.getEditorEl(),
    // The caret lives in the model, not in the scroll box: the pane's own
    // line↔offset mapping needs the view to read one and place the other.
    getEditor: () => session.editor,
  })
  const selection = createEditorSelection({ getEditor: () => session.editor })

  const { searchOpen, spellPopup } = searchOverlay

  // Focus/typewriter centering + the word-count goal live in a composable so the
  // pane owns less. The calls read the live `editor`/`scrollEl` via closures.
  const {
    wordCount,
    wordGoalMet,
    wordProgressPct,
    queueCenterCursor,
    onFocusKeydown,
    onFocusPointerdown,
    cancelFocusRaf,
  } = useEditorFocus({
    getEditor: () => session.editor,
    getScrollEl: () => options.getScrollEl(),
  })

  let unlistenChange: (() => void) | null = null
  let unlistenOverlayRefresh: (() => void) | null = null

  /** Put the keyboard in the document. The editor keeps its own selection across
   *  a mode switch (the model is never rebuilt for one), so this only has to hand
   *  the focus back — the pane the user came from was a button. */
  function focus(): void {
    editorController.getView()?.focus()
  }

  function onContainerPointerDownCapture(e: PointerEvent): void {
    selection.handlePointerDown(e)
  }

  onMounted(async () => {
    const el = options.getEditorEl()
    if (!el) return
    editorController.mount()
    editorForPanel.value = session.editor
    const current = tabs.activeTab
    if (current) await externalSync.applyContent(current.content)

    emitLifecycle('onEditorReady', session.editor)

    el.addEventListener('pointerdown', onContainerPointerDownCapture, true)
    el.addEventListener('click', options.handlers.onEditorClick)
    window.addEventListener('keydown', options.handlers.onKeydown)
    el.addEventListener('keydown', onFocusKeydown)
    el.addEventListener('pointerdown', onFocusPointerdown)

    unlistenChange = persistence.attachChangeListener()
    unlistenOverlayRefresh = searchOverlay.attachChangeListener()
    // Published so a one-shot document read (save, export, sending the note to
    // the model) can publish this pane's pending serialization first.
    setRenderedFlush(() => persistence.flush())

    // Spell check is a reactive setting: sync the live toggle (default true) so
    // the renderSearch overlay honors it on open, and re-apply on change.
    searchOverlay.syncSpellEnabled(appearance.spellCheckEnabled)
  })

  watch(
    () => appearance.spellCheckEnabled,
    (enabled) => {
      searchOverlay.syncSpellEnabled(enabled)
    },
  )

  watch(
    () => appearance.focusMode,
    (on) => {
      if (on) queueCenterCursor()
    },
  )

  // The task-list switch is a rendering choice of the live editor: the pane keeps
  // one editor per document, and rebuilding it to flip a decoration would throw
  // away the undo stack and the caret. editor-core re-decorates the open views
  // instead, so `immediate` also seeds the first editor with the stored value.
  watch(
    () => appearance.renderTaskChecklist,
    (enabled) => configureTaskChecklistRendering(enabled),
    { immediate: true },
  )

  onBeforeUnmount(() => {
    try {
      setRenderedFlush(null)
      // The session dies with this mount; a refusal it published must die with
      // it too, or the write path would keep refusing saves of a document no
      // editor is holding any more (the vault-switch teardown, where the tab
      // set is replaced and the next mount is a different vault).
      clearRefusedDocument()
      persistence.cancel()
      searchOverlay.cancelRefresh()
      cancelFocusRaf()
      if (tabs.activeId) tabs.cancelAutosave(tabs.activeId)
      editorForPanel.value = null
      // Re-read the element rather than closing over the mount's: teardown
      // unregisters exactly what it registered, on whatever the ref holds now.
      const el = options.getEditorEl()
      el?.removeEventListener('pointerdown', onContainerPointerDownCapture, true)
      el?.removeEventListener('click', options.handlers.onEditorClick)
      el?.removeEventListener('keydown', onFocusKeydown)
      el?.removeEventListener('pointerdown', onFocusPointerdown)
      window.removeEventListener('keydown', options.handlers.onKeydown)
      unlistenChange?.()
      unlistenOverlayRefresh?.()
      scrollSync.cancel()
      editorController.destroy()
    } finally {
      if (session.docChangeTimer) {
        clearTimeout(session.docChangeTimer)
        session.docChangeTimer = null
      }
    }
  })

  watch(
    // The document, not just its text (L06/L04): `activeId` moves when the user
    // switches notes, and two notes can hold identical text — for those the
    // content watcher alone never fires, so the model kept the note being left
    // (undo history included) and the switch's hand-off had no boundary to run
    // at. The array is re-created per evaluation, which is exactly what makes a
    // change to either half fire it.
    () => [tabs.activeId, tabs.activeTab?.content] as const,
    ([, content]) => {
      externalSync.onContentChanged(content)
    },
  )

  watch(
    () => view.mode,
    (mode) => {
      externalSync.onModeChanged(mode)
    },
  )

  return {
    editorForPanel,
    documentVersion,
    searchOpen,
    spellPopup,
    searchOverlay,
    externalSync,
    scrollSync,
    focus,
    wordCount,
    wordGoalMet,
    wordProgressPct,
  }
}
