import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { useFloatStore } from '../../../stores/float'
import { setCalloutView } from '../../../plugins/callout'
import { notifyError } from '../../../services/errors'
import { isSourceAuthored } from '../../../services/editor-ownership'
import { consumeSuppressReapply } from '../../../services/suppress-reapply'
import { debounce } from '../../../services/timing'
import { t } from '../../../i18n'
import type { DocumentSession } from '../model/document-session'

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
  /** Apply a deferred preview re-sync now, if one is waiting. */
  flushPendingSync(): void
}

/**
 * How long the preview waits for the source pane to stop typing before the
 * model is rebuilt from its text (split mode only).
 *
 * The source pane publishes through its own 50 ms debounce, so at normal typing
 * speed every pause arrives here as a whole-document re-parse — `open()` builds
 * a new ProseMirror state for the entire document — followed by a
 * whole-document re-serialization. Measured on a 44k-character note in split
 * view: ~570 ms of parse and ~220 ms of serialize per typing pause, i.e. the
 * app pays a full document round trip for every keystroke the user takes. The
 * preview is allowed to lag the keystroke that caused it; it is not allowed to
 * lag the sentence.
 *
 * 300 ms is the settle window, not a deadline: a burst of any length costs one
 * re-parse, and text that stops arriving is rendered ~300 ms after the last
 * keystroke. A write from anywhere else (disk reload, history restore, another
 * document) never waits — only text the source pane authored does, and only
 * while the mode keeps both panes live.
 */
export const PREVIEW_RESYNC_DEBOUNCE_MS = 300

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

  /** The rendered pane only edits the document while it is actually visible.
   *  In source mode it stays mounted (v-show) but is hidden, and the source
   *  pane owns the text — feeding its edits through the Markdown serializer
   *  here would write the canonicalized result back into the tab and replace
   *  the document the user is typing in.
   *
   *  Split mode keeps the preview live on purpose: the model follows source
   *  edits, and `editorPersistence` is what stops the serializer's output from
   *  being pushed back over the raw Markdown (see `isSourceAuthored`). */
  function renderedPaneOwnsText(): boolean {
    return view.mode !== 'source'
  }

  /**
   * Reconcile the model with `content` right now.
   *
   * Every path that is not the source pane's own typing goes through here (and
   * so does the debounced path once it fires), because the guards are the same
   * either way: a serialization in flight is superseded rather than raced, and
   * text that arrived mid-apply is queued instead of dropped.
   */
  function applyExternal(content: string): void {
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

  /** Text the source pane authored, waiting for the typing to settle (split
   *  mode only — see {@link PREVIEW_RESYNC_DEBOUNCE_MS}). */
  const pendingPreviewResync = debounce(applyExternal, PREVIEW_RESYNC_DEBOUNCE_MS)

  async function applyContent(content: string): Promise<void> {
    // An immediate apply supersedes a deferred one: the deferred text describes
    // a document that is no longer the one being loaded (the user switched
    // notes, a disk reload arrived), and landing it afterwards would replace
    // the newer model with the older text.
    pendingPreviewResync.cancel()
    const editor = deps.getEditor()
    if (!editor) return
    // Idempotence guard: the editor already holds this exact canonical text.
    // Re-opening it now would replace the live model, wiping undo history,
    // stored caret/scroll and interrupting typing. A failed parse stays
    // eligible so switching back to rendered mode can retry.
    //
    // `appliedContent` alone is not enough to say the editor HOLDS it: it is the
    // text the editor was last OPENED with, and any typing since then replaced
    // the live document. Restoring a version that happens to equal that text -
    // the common case, "undo my last edit by restoring the previous version" -
    // was therefore skipped as already-applied: the file went back and the SCREEN
    // did not, so the user saw no change, and their next keystroke published the
    // discarded text and saved it over the restore. The pair of fields is what
    // distinguishes the two states: they are equal only while nothing has been
    // typed (editorPersistence updates `lastLocalMarkdown` on every edit).
    const editorStillHoldsApplied = deps.session.lastLocalMarkdown === deps.session.appliedContent
    if (content === deps.session.appliedContent && editorStillHoldsApplied && !deps.session.parseFailed) {
      return
    }
    deps.session.applyingExternal = true
    try {
      // The file's path, because it is what says whether the document is MDX:
      // `open` reads a `.mdx` file with the MDX parser and leaves everything
      // else — including `.md` — as Markdown. An untitled tab has no path, and
      // no path is Markdown. Read here rather than after the await: this text
      // belongs to the tab that is active NOW.
      await editor.open(content, tabs.activeTab?.path ?? null)
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
      // Adopt the serializer's canonical form only when the rendered pane owns
      // the text (rendered mode). In split mode the source pane is the author:
      // writing the canonicalized text back would replace the raw Markdown —
      // and reset the caret — under the user's hands.
      if (
        view.mode === 'rendered' &&
        active &&
        active.content !== initial &&
        active.content === content
      ) {
        active.content = initial
        // `savedContent` is what this tab believes is ON DISK: App.vue hands the
        // live tab straight to the external-change check, which compares that
        // field against the bytes it reads back. The serializer's canonical text
        // is what the NEXT save will write, not what is there now — for a file
        // that gets canonicalized on open (CRLF → LF) storing it here made the
        // comparison fail forever, so every later watcher event looked like a real
        // modification: a clean tab was silently reloaded (reopening the model,
        // dropping caret and scroll) and a dirty one got a conflict dialog for a
        // change nobody made. Untitled tabs have no file to compare against, so
        // they keep the previous "accepted text" meaning.
        if (!active.dirty && !active.path) active.savedContent = initial
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
    // (that would replace the user's live text and reset caret/scroll). The arm
    // belongs to the tab that was saved (tabs.saveTab) and is consumed once here,
    // for the ACTIVE tab only — a background save must never swallow the re-apply
    // of the document the user is actually looking at.
    // A deferred re-sync is only valid while the tab still holds the text it
    // describes. Every exit below — a suppressed re-apply, no tab at all, a
    // pane that does not own the text — means the document moved on without
    // this text being reconciled, so the pending one is dropped here, before
    // any of them can return: a closed note reports `undefined`, and re-opening
    // the model with its text 300 ms later would leave the editor holding a
    // document no tab is showing.
    pendingPreviewResync.cancel()
    const activeTabId = tabs.activeTab?.id
    if (activeTabId !== undefined && consumeSuppressReapply(activeTabId)) return
    if (content === undefined) return
    // While the rendered pane is hidden (source mode) the source pane is the
    // single source of truth. Applying its edits here would round-trip the
    // Markdown through the serializer and push the canonicalized text back
    // into the tab, replacing the live source document and moving its caret.
    // The model is re-synced when the pane becomes visible again (onModeChanged).
    if (!renderedPaneOwnsText()) return
    // Split mode: text the source pane authored is the user mid-keystroke, and
    // re-parsing per keystroke is what makes the preview hitch (and its
    // heading anchors drift out from under the source). Wait for the typing to
    // settle — the marker says the model is behind this text, which is exactly
    // the case a deferral is safe in: nothing else has edited the document, so
    // there is no state to race.
    if (view.mode === 'split' && isSourceAuthored(content)) {
      pendingPreviewResync.run(content)
      return
    }
    applyExternal(content)
  }

  function onModeChanged(mode: string): void {
    // A pending re-sync belongs to the mode being left. Source mode does not
    // re-sync the model at all, and on the way into a visible pane the apply
    // below reads the tab again anyway.
    pendingPreviewResync.cancel()
    // Switching back to a visible rendered pane must re-read the tab content:
    // edits made in source mode were intentionally skipped above, so the live
    // model can be stale. The idempotence guard inside applyContent keeps this
    // a no-op when the editor already holds the current text.
    if (mode === 'source') return
    if (deps.session.parseFailed) deps.session.parseFailed = false
    const content = tabs.activeTab?.content
    if (content === undefined) return
    deps.session.gen++
    void applyContent(content)
  }

  /** Apply a deferred preview re-sync now, if one is waiting.
   *
   *  Narrowing the deferral to zero is all a flush can do: the apply itself is
   *  a whole-document model rebuild, and a keystroke that lands while it runs
   *  is the same pre-existing race every `applyContent` has (a disk reload, a
   *  history restore) — not something a flush can close. */
  function flushPendingSync(): void {
    pendingPreviewResync.flush()
  }

  return { applyContent, onContentChanged, onModeChanged, flushPendingSync }
}
