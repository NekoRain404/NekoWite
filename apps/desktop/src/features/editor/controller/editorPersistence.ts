import { emitLifecycle } from '@nekowite/plugin-host'
import { debounce } from '../../../services/timing'
import { useTabsStore } from '../../../stores/tabs'
import { clearSourceAuthored, isSourceAuthored } from '../../../services/editorOwnership'
import { getSourceViewHandle } from '../../../services/sourceView'
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
  /**
   * Serialize NOW and publish the result to the tab.
   *
   * The normal path is debounced, so for ~120ms after a keystroke `tab.content`
   * still holds the previous text. Anything that reads the document for a
   * one-shot purpose (saving, exporting) has to flush first, or it persists the
   * stale version — and the save then re-applies that stale text to the model,
   * discarding the keystroke that was still in flight.
   */
  flush(): Promise<void>
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
    // Publish anything the source pane is still coalescing before reading the
    // tab. Without this a keystroke that has not cleared the host's debounce
    // window is invisible here, and the model's older serialization would be
    // written over it — the "my last character disappeared" family.
    getSourceViewHandle()?.flush()
    // The tab currently holds text the source pane authored and the model has
    // not caught up with, so this serialization is stale: writing it would
    // replace the raw Markdown under the user's caret. Note this is about the
    // text, not the mode — a rendered-pane edit still in flight when the view
    // switches to source must land, or that edit would be lost.
    if (isSourceAuthored(active.content)) return
    // The model has not moved since the last snapshot (a re-open / external
    // apply only re-loaded the same text) — there is nothing new to persist.
    // Writing it back here would push the serializer's canonical form into the
    // tab, replacing the raw Markdown the user is typing in the source pane and
    // resetting its caret.
    if (markdown === deps.session.lastLocalMarkdown) return
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
      // A real rendered-pane edit: the model authors the text again, so the
      // source pane's authored marker no longer describes the tab.
      clearSourceAuthored()
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

  async function flush(): Promise<void> {
    markdownSync.cancel()
    await persistMarkdown()
  }

  function cancel(): void {
    markdownSync.cancel()
    if (deps.session.docChangeTimer) {
      clearTimeout(deps.session.docChangeTimer)
      deps.session.docChangeTimer = null
    }
  }

  return { attachChangeListener, scheduleSerialize, flush, cancel }
}
