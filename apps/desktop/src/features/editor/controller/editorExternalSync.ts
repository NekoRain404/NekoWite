import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { useFloatStore } from '../../../stores/float'
import { setCalloutView } from '../../../plugins/callout'
import { notifyError } from '../../../services/errors'
import { consumeSuppressReapply } from '../../../services/suppressReapply'
import { t } from '../../../i18n'
import type { DocumentSession } from '../model/documentSession'

export interface EditorExternalSyncDeps {
  session: DocumentSession
  getEditor: () => DocumentSession['editor']
  /** Ask the search overlay to re-scan the model after a content swap. */
  scheduleOverlayRefresh: () => void
}

export interface EditorExternalSync {
  /** Apply external content to the editor (open/first-load, disk reload,
   *  history restore). Guards against stale generations and mid-apply writes. */
  applyContent(content: string): Promise<void>
  /** Handle an external tab-content change (watch on `activeTab.content`). */
  onContentChanged(content: string | undefined): void
  /** Recover from a failed parse when the user switches back to rendered. */
  onModeChanged(mode: string): void
}

/**
 * Detect and apply externally-originated document writes (a fresh open, a
 * reload-from-disk, a history restore, or a watcher-driven change), and decide
 * whether to re-open the editor or ignore the echo of our own serialization.
 *
 * It returns no UI decisions of its own — conflict selection is surfaced by the
 * tab store / sidebar via the `ConflictDialog`. This module only reconciles the
 * editor model with the tab content.
 */
export function createEditorExternalSync(deps: EditorExternalSyncDeps): EditorExternalSync {
  const tabs = useTabsStore()
  const view = useViewStore()
  const floatStore = useFloatStore()

  async function applyContent(content: string): Promise<void> {
    const editor = deps.getEditor()
    if (!editor) return
    // Idempotence guard: the editor already holds this exact canonical text.
    // Re-opening it now would replace the live model, wiping undo history,
    // stored caret/scroll and interrupting typing. A failed parse stays
    // eligible so switching back to rendered mode can retry.
    if (content === deps.session.appliedContent && !deps.session.parseFailed) return
    deps.session.applyingExternal = true
    try {
      await editor.open(content)
      // Mark the exact content as applied immediately after open() succeeds.
      // Later canonicalization (save()) can change the tab's text, but the
      // editor model is now loaded; another open of this same source must be
      // skipped or it would reset the user's selection/undo/scroll.
      deps.session.appliedContent = content
      floatStore.select(null)
      // Capture the editor's canonical serialization immediately. The
      // debounced markdownUpdated emit would otherwise arrive later and — for
      // files needing canonicalization (e.g. CRLF) — mark a freshly opened
      // tab dirty, causing an autosave rewrite with no user edit.
      const initial = await editor.save()
      deps.session.lastLocalMarkdown = initial
      const active = tabs.activeTab
      // Only adopt the serializer's canonicalization when the tab still holds the
      // text we just opened. While `open()` was in flight an external write may
      // have replaced it with newer content (the async disk read that fills a
      // placeholder tab). Overwriting that here would drop the real document and
      // leave the editor permanently empty; respecting the newer content lets the
      // content watcher re-open with it instead.
      if (active && active.content !== initial && active.content === content) {
        active.content = initial
        if (!active.dirty) active.savedContent = initial
      }
      if (!deps.session.calloutViewSet) {
        try {
          setCalloutView(editor.getView())
          deps.session.calloutViewSet = true
        } catch {
          // The editor view is expected to be ready once open() resolves.
          deps.session.parseFailed = true
          notifyError(t('rendered.parseFailed'))
          view.setMode('source')
        }
      }
    } catch {
      deps.session.parseFailed = true
      notifyError(t('rendered.parseFailed'))
      view.setMode('source')
    } finally {
      deps.session.applyingExternal = false
      // A content change that arrived mid-apply must not be dropped.
      const pending = deps.session.pendingExternal
      deps.session.pendingExternal = null
      if (pending !== null && pending !== deps.session.lastLocalMarkdown && !deps.session.parseFailed) {
        deps.session.gen++
        void applyContent(pending)
      } else {
        deps.scheduleOverlayRefresh()
      }
    }
  }

  function onContentChanged(content: string | undefined): void {
    // I2: a save-time rewrite syncs the model but must not re-open the editor
    // (that would replace the user's live text and reset caret/scroll). The
    // flag is armed by tabs.saveActive and consumed once here.
    if (consumeSuppressReapply()) return
    if (content === undefined) return
    if (deps.session.applyingExternal) {
      deps.session.pendingExternal = content
      return
    }
    // The echo of an editor-originated update: content was set from the
    // editor's own serialization, so re-opening would re-parse the whole
    // document (wiping undo history and stored positions) for no change.
    if (content === deps.session.lastLocalMarkdown) return
    if (deps.session.parseFailed) return
    // Supersede any in-flight applyContent: bump gen so its stale serialization
    // (captured before the await) cannot overwrite this newer content.
    deps.session.gen++
    void applyContent(content)
  }

  function onModeChanged(mode: string): void {
    if (!deps.session.parseFailed) return
    if (mode === 'source') return
    deps.session.parseFailed = false
    const content = tabs.activeTab?.content
    if (content === undefined) return
    deps.session.gen++
    void applyContent(content)
  }

  return { applyContent, onContentChanged, onModeChanged }
}
