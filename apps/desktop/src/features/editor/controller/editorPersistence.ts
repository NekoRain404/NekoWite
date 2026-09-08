import { emitLifecycle } from '@nekowite/plugin-host'
import { debounce } from '../../../services/timing'
import { useTabsStore } from '../../../stores/tabs'
import type { DocumentSession } from '../model/documentSession'

export interface EditorPersistenceDeps {
  session: DocumentSession
}

export interface EditorPersistence {
  /** Register the `onContentChange` listener that marks the tab dirty and
   *  schedules serialization. Returns an unsubscribe. */
  attachChangeListener(): () => void
  /** Defer a full-document serialization (runtime call, not instant). */
  scheduleSerialize(): void
  /** Cancel a pending serialization and the doc-change emit timer. */
  cancel(): void
}

const MARKDOWN_SYNC_MS = 120
const DOC_CHANGE_MS = 300

/**
 * Serializes the editor document into the tab's canonical Markdown and keeps
 * the dirty/autosave/save-state machinery in sync.
 *
 * Full-document serialization round-trips the whole doc through the Milkdown
 * serializer on every markdownUpdated, so a typing burst is collapsed into ONE
 * serialization shortly after input settles, while still marking the tab dirty /
 * re-arming autosave per keystroke so the save state (dirty flag, autosave
 * timer) stays exactly as before. `scheduleSave` on close and `flush` are
 * handled by the tab store; this module only echoes the doc into the model.
 */
export function createEditorPersistence(deps: EditorPersistenceDeps): EditorPersistence {
  const tabs = useTabsStore()

  async function persistMarkdown(): Promise<void> {
    const editor = deps.session.editor
    if (!editor) return
    const active = tabs.activeTab
    if (!active) return
    // Capture generation BEFORE the await: a reloadFromDisk during the save
    // bumps gen, and the stale markdown must not win.
    const myGen = deps.session.gen
    const markdown = await editor.save()
    if (tabs.activeTab?.id !== active.id) return
    if (myGen !== deps.session.gen) return
    // The echo of a change we already applied is not an edit.
    if (markdown === deps.session.lastLocalMarkdown && markdown === active.content) return
    deps.session.lastLocalMarkdown = markdown
    active.content = markdown
    deps.session.lastDoc = markdown
    if (deps.session.docChangeTimer) return
    deps.session.docChangeTimer = setTimeout(() => {
      emitLifecycle('onDocChange', { doc: deps.session.lastDoc })
      deps.session.docChangeTimer = null
    }, DOC_CHANGE_MS)
  }

  const markdownSync = debounce(() => {
    void persistMarkdown()
  }, MARKDOWN_SYNC_MS)

  function attachChangeListener(): () => void {
    const editor = deps.session.editor
    if (!editor) return () => {}
    return editor.onContentChange(() => {
      if (deps.session.applyingExternal || !deps.session.editor) return
      const active = tabs.activeTab
      if (!active) return
      // Keep the dirty flag & autosave timer per-keystroke (cheap, and the save
      // state must reflect each edit immediately), but defer the expensive
      // full-document serialization until the typing burst settles.
      tabs.markDirty(active.id)
      tabs.scheduleAutosave(active.id)
      markdownSync.run()
    })
  }

  function scheduleSerialize(): void {
    markdownSync.run()
  }

  function cancel(): void {
    markdownSync.cancel()
    if (deps.session.docChangeTimer) {
      clearTimeout(deps.session.docChangeTimer)
      deps.session.docChangeTimer = null
    }
  }

  return { attachChangeListener, scheduleSerialize, cancel }
}
