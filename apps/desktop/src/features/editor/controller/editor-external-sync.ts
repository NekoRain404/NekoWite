import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { useFloatStore } from '../../../stores/float'
import { setCalloutView } from '../../../plugins/callout'
import { notifyError } from '../../../services/errors'
import { clearRefusedDocument, isSourceAuthored, markRefusedDocument } from '../../../services/editor-ownership'
import { consumeSuppressReapply } from '../../../services/suppress-reapply'
import { debounce } from '../../../services/timing'
import { t } from '../../../i18n'
import { documentKey } from '../model/document-session'
import type { DocumentSession } from '../model/document-session'

export interface EditorExternalSyncDeps {
  session: DocumentSession
  getEditor: () => DocumentSession['editor']
  /** Ask the search overlay to re-scan the model after a content swap. */
  scheduleOverlayRefresh: () => void
  /**
   * The document switch's hand-off boundary: publish the model's pending
   * serialization to the document it is HOLDING, before the model is given
   * another one (see `applyContent`).
   *
   * Nothing else can do this: the pending text lives in the model, and the
   * model is the one thing a switch replaces. It must run to completion before
   * `open()`, which is why it is awaited here rather than fired and forgotten —
   * the publish reads the document through the same editor.
   */
  handOffPendingEdits?: () => Promise<void>
  /**
   * The model has just been given `content` — this pane is holding that
   * document now (only the successful path: a refused parse holds nothing).
   *
   * Anything that measures the document has to wait for this: the pane's own
   * geometry does not exist until the model does, so a caller that acted on the
   * content watcher alone would be mapping through the document it just
   * replaced.
   */
  onDocumentApplied?: (content: string) => void
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

  /** The document the ACTIVE tab names, or null when there is no tab. */
  function activeDocumentKey(): string | null {
    const tab = tabs.activeTab
    return tab ? documentKey(tabs.vault, tab.id) : null
  }

  /** True while the model is holding the document `key` names. Text alone
   *  cannot answer this: two notes can hold the same bytes. */
  function modelHolds(key: string | null): boolean {
    return key !== null && key === deps.session.appliedKey
  }

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
    // document (wiping undo history and stored positions) for no change. Bound
    // to the DOCUMENT as well as the text (L06): the text is not enough to say
    // which note it is the echo of, and two notes can hold identical text — a
    // switch between those two used to be read here as an echo and skipped, so
    // the model kept the note being left, its undo history included.
    if (modelHolds(activeDocumentKey()) && content === deps.session.lastLocalMarkdown) return
    if (deps.session.parseFailed) return
    // Supersede any in-flight applyContent: bump gen so its stale serialization
    // (captured before the await) cannot overwrite this newer content.
    deps.session.gen++
    void applyContent(content)
  }

  /** Text the source pane authored, waiting for the typing to settle (split
   *  mode only — see {@link PREVIEW_RESYNC_DEBOUNCE_MS}). */
  const pendingPreviewResync = debounce(applyExternal, PREVIEW_RESYNC_DEBOUNCE_MS)

  async function applyContent(
    content: string,
    key: string | null = activeDocumentKey(),
  ): Promise<void> {
    // An immediate apply supersedes a deferred one: the deferred text describes
    // a document that is no longer the one being loaded (the user switched
    // notes, a disk reload arrived), and landing it afterwards would replace
    // the newer model with the older text.
    pendingPreviewResync.cancel()
    const editor = deps.getEditor()
    if (!editor) return
    // Captured before the hand-off below, which is the only await this function
    // has before it takes charge of the model. The hand-off is a whole-document
    // serialization, so a second switch can arrive while it runs, and without
    // this the interrupted one would open its document AFTER the newer one had
    // — leaving the pane on a note the user had already switched away from.
    // Any later content write bumps gen (see `applyExternal`), so an apply that
    // finds it moved stands down and leaves the model to the newer one.
    const myGen = deps.session.gen
    // Idempotence guard: the editor already holds this exact canonical text OF
    // THIS DOCUMENT. Re-opening it now would replace the live model, wiping
    // undo history, stored caret/scroll and interrupting typing. A failed parse
    // stays eligible so switching back to rendered mode can retry.
    //
    // The document is part of the guard, not just the text (L06): two notes can
    // hold identical text — most obviously two empty ones — and for those the
    // text says nothing about whether this is a re-open or a switch. The model
    // then kept the note being left, undo history and all, so Ctrl+Z in the new
    // note inverted an edit made in the old one.
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
    //
    // And the pair says nothing at all about a document the editor has since
    // DISOWNED: `open()`'s catch clears `appliedContent`, because a failed load
    // leaves the model showing the previous document while the editor holds
    // none. So this guard is skipped after a refusal, and the open below is
    // what re-establishes the claim (clearing the refusal with it). Skipping it
    // there is the C1 of brief 58: the editor held nothing while the refusal
    // stayed armed, so the rendered pane published nothing and a save of the
    // note in front of the user wrote the text from before their keystroke.
    const editorStillHoldsApplied = deps.session.lastLocalMarkdown === deps.session.appliedContent
    if (
      modelHolds(key) &&
      content === deps.session.appliedContent &&
      editorStillHoldsApplied &&
      !deps.session.parseFailed
    ) {
      return
    }
    // The hand-off boundary (L04), and it has to be HERE: the text a switch
    // drops is not lost when the tab changes, it is lost when the model is
    // replaced — the publish armed by the last keystroke fires later, serializes
    // whatever document is open by then, and is discarded as stale. So the
    // leaving document's pending text is published to ITS tab (the model's own
    // identity, see `persistMarkdown`) while the model still holds it. A longer
    // debounce was considered and rejected: the window was argued on its own
    // merits, and moving it only moves the switch that loses the tail.
    if (deps.session.appliedKey !== null && !modelHolds(key)) {
      await deps.handOffPendingEdits?.()
      // The world moved while that ran, in either of the two ways it can: a
      // newer content write arrived for this document (gen), or the user is
      // looking at a different document now. The second one is why the key is
      // checked as well — a switch to a note whose text the model still holds
      // takes the echo shortcut above and bumps nothing this apply can see, so
      // without this it would land its document over the note the user went
      // back to.
      if (deps.session.gen !== myGen) return
      if (key !== activeDocumentKey()) return
    }
    deps.session.applyingExternal = true
    try {
      // The file's path, because it is what says whether the document is MDX:
      // `open` reads a `.mdx` file with the MDX parser and leaves everything
      // else — including `.md` — as Markdown. An untitled tab has no path, and
      // no path is Markdown. Read here rather than after the await: this text
      // belongs to the tab that is active NOW.
      await editor.open(content, tabs.activeTab?.path ?? null)
      // The model holds this document now, whatever it refused before.
      clearRefusedDocument()
      // Mark the exact content as applied immediately after open() succeeds.
      // Later canonicalization (save()) can change the tab's text, but the
      // editor model is now loaded; another open of this same source must be
      // skipped or it would reset the user's selection/undo/scroll.
      deps.session.appliedContent = content
      // ...and WHICH document that content belongs to, committed with it: the
      // pair is what the guards above ask about.
      deps.session.appliedKey = key
      // Published with the text it holds: the pane's record that this document
      // is measurable now, which is what a position waiting for a document
      // (the reading position of a note being switched to) waits for.
      deps.onDocumentApplied?.(content)
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
          // The editor view is expected to be ready once open() resolves. Note
          // this arm deliberately does NOT publish the refusal below: what
          // failed is the view, not the model — the document IS loaded, so a
          // save would still be writing the document the user is looking at.
          deps.session.parseFailed = true
          notifyError(t('rendered.parseFailed'))
          view.setMode('source')
        }
      }
    } catch (error) {
      deps.session.parseFailed = true
      // The load failed, so the editor holds no document: `held.drop()` leaves
      // the model showing the PREVIOUS document while disowning it, so nothing
      // the model can serialize is this file's text. `appliedContent` names the
      // text the editor was last OPENED with, which is a claim that it holds
      // that text — and the idempotence guard in `applyContent` skips the
      // re-open on the strength of it. Clearing it here is what keeps the two
      // facts from disagreeing: the next apply re-opens the note in front of the
      // user and re-establishes the claim, instead of skipping past it and
      // leaving the editor holding nothing for every note they switch to (C1,
      // brief 58).
      deps.session.appliedContent = null
      // Dropped with it, for the same reason: "the model holds this document"
      // is one claim, and half of it left standing would let the guards skip
      // the re-open that re-establishes it.
      deps.session.appliedKey = null
      // `error` is bound for the brief that must tell a document too large to
      // render (`DocumentTooComplexToRenderError`) apart from a genuine parse
      // failure. Nothing reads it yet, so it is discarded rather than carried.
      void error
      // Published with the text that failed, so the write path can refuse to
      // save exactly that text on the strength of a model that does not hold it
      // (C1). `parseFailed` above is the session's own view — retry
      // eligibility, suppressed re-applies — and this one is what the save
      // transaction reads.
      markRefusedDocument(content)
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
