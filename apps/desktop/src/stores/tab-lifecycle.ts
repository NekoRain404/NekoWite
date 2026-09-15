/**
 * Tab lifecycle: a document arriving in a tab — open, focus, the first read,
 * and taking a tab back out of the set. The CLOSES that decide what happens to
 * unsaved work before a tab disappears live in `tab-close.ts`, which this module
 * composes, so `createTabLifecycle` stays the one surface a consumer wires.
 *
 * This module NEVER imports `app/recoveryClosedLoop`: the app imports this
 * store, so a store-side module reaching up to it would recreate the
 * store→app cycle the split removes. The close-all prompt therefore arrives as
 * the injected `requestUntitledClose` callback, and the fs/notification ports
 * arrive through `deps` like every other dependency.
 */

import type { Ref } from 'vue'
import { emitLifecycle } from '@nekowite/plugin-host'
import { flushEdits } from '../services/editor-ownership'
import { pruneSuppressReapply } from '../services/suppress-reapply'
import type { HistoryEntry } from '../platform/gateways/contracts'
import type { RecoveryPrompt } from '../services/errors'
import { createTabClose } from './tab-close'
import type { UntitledCloseChoice } from './tab-close'
import type { OpenTab } from './tabs'

/** Re-exported for the store that wires the untitled-close prompt; the type
 *  belongs to the closes that consume it. */
export type { UntitledCloseChoice }

/** The slice of the fs gateway opening a tab needs. */
export interface TabOpenFilePort {
  read(vault: string, path: string): Promise<string>
}

export interface TabLifecycleDeps {
  tabs: Ref<OpenTab[]>
  activeId: Ref<string | null>
  vault: Ref<string | null>
  files: TabOpenFilePort
  t: (key: string, params?: Record<string, unknown>) => string
  notifyError(message: string): void
  notifyRecovery(prompt: RecoveryPrompt): void
  /** Persistence commands the close flows call — forwarded to `tab-close.ts`
   *  with the rest of the ports. `saveUntilSettled` is the gate
   *  a close asks, not `saveTab`: one landed write is not a saved tab
   *  (`tab-settle.ts`), and a close that reads it as one drops the text the
   *  write could not carry. */
  saveUntilSettled(id: string): Promise<boolean>
  flushDirty(): Promise<boolean>
  /** Record one edit of `id`'s text, at the keystroke rather than at the
   *  publish. A save reads the revision before its write and clears the tab's
   *  `dirty` flag only if it has not moved — see `tab-save.ts`'s
   *  `editRevisions`. */
  noteEdit(id: string): void
  untitledDirtyTabs(): OpenTab[]
  captureSession(): void
  cancelAutosave(id: string): void
  resetSaveBookkeeping(): void
  /** Recovery flows `openTab` runs after the tab is live. */
  checkCrashRecovery(id: string): Promise<HistoryEntry | null>
  restoreHistoryToActive(id: string, versionId: string): Promise<string | null>
  /** Ask the user what to do with `count` untitled dirty tabs before a bulk
   *  close. Injected because the app-layer prompt lives in
   *  `app/recoveryClosedLoop` — see the module header. Resolves `'save'` to
   *  save them through Save-As first, `'discard'` to drop them. */
  requestUntitledClose(count: number): Promise<UntitledCloseChoice>
}

export function createTabLifecycle(deps: TabLifecycleDeps) {
  const {
    tabs,
    activeId,
    vault,
    files,
    t,
    notifyError,
    notifyRecovery,
    saveUntilSettled,
    flushDirty,
    noteEdit,
    untitledDirtyTabs,
    captureSession,
    cancelAutosave,
    resetSaveBookkeeping,
    checkCrashRecovery,
    restoreHistoryToActive,
    requestUntitledClose,
  } = deps

  let seq = 0
  const nextId = () => `tab-${++seq}`

  /**
   * Make `id` the active tab and drop the suppress-reapply arms of every other
   * tab (see services/suppressReapply): only the ACTIVE tab's content watcher
   * runs, so an arm left behind by a tab the user switched away from could never
   * be consumed — it would just sit there until it swallowed an unrelated content
   * change (typically the one belonging to the tab that is now on screen).
   */
  function focusTab(id: string | null): void {
    activeId.value = id
    pruneSuppressReapply(id)
  }

  function setActive(id: string): void {
    focusTab(id)
  }

  /** The tab's text changed: it is unsaved, and the edit is counted.
   *
   *  Both halves matter and both belong here rather than at the publish: a save
   *  decides whether it may call the tab saved by comparing the revision it saw
   *  before its write against the revision now, and `dirty` is what every
   *  protection for unsaved text reads. A publish, by contrast, happens up to a
   *  debounce window later and must not be the thing that records the edit. */
  function markDirty(id: string): void {
    const tab = tabs.value.find((x) => x.id === id)
    if (!tab) return
    tab.dirty = true
    noteEdit(id)
  }

  /**
   * Take text the user typed into a tab whose first read had not landed yet,
   * and give it a document of its own.
   *
   * The tab was showing an EMPTY editor wearing the note's path, so the typing
   * is the user's text and the file's text is the note's, and neither may be
   * written over the other. Committing the file's text into the note is the
   * read doing its job; writing the typing into the note instead would destroy
   * the note's text on the next autosave, and dropping it is what L03 is. So it
   * moves to an untitled tab, which is the state it is actually in — text the
   * user typed that belongs to no file.
   *
   * Not focused (the user asked for a note, and a nameless document in front of
   * them answers a different question), marked dirty (nothing of it is on disk
   * anywhere) and announced, because a tab appearing beside theirs is not
   * something to discover later. The sentence differs by what the user asked
   * for — a note they OPENED is a note still in front of them, a note they
   * CLOSED is gone (`tab-close.ts`, which is the other caller) — so the caller
   * supplies it.
   *
   * `from.content` is only the typing once the pane holding it has published
   * — see `commitRead`, which flushes before calling this. Reading the field
   * without that flush is how this handed the user an empty tab under a toast
   * saying their text was in it. A caller that reaches this from anywhere else
   * owes the same flush.
   */
  function rescuePlaceholderTyping(from: OpenTab, notice: string): void {
    const rescued: OpenTab = {
      id: nextId(),
      path: null,
      content: from.content,
      savedContent: '',
      dirty: false,
      loading: false,
      pendingAssetPaths: [],
    }
    tabs.value.push(rescued)
    markDirty(rescued.id)
    // The flag means "this tab holds text no disk has", and after the move it
    // does not: the only thing it was recording is now in the tab above. What
    // protects the note's FILE was never this flag — it is the write path's
    // `loading` guard (`tab-write-preconditions.ts`), untouched by this and by
    // the move alike, so a placeholder still cannot be written whatever its
    // `dirty` says. Leaving it set bought exactly two things: a refusal that
    // read as "unsafe to close" on every bulk route (`flushDirty` answers false
    // for a tab nothing can write), and a SECOND rescue of the same words when
    // the user retried the close, since a retry finds the tab dirty again and
    // nothing else has a record that the text left. So the rescue is the place
    // that clears it — the single place that knows the text has left the tab.
    // `commitRead` must not: a tab it commits into may still hold text of the
    // user's, and clearing the flag there would drop the only record of it.
    from.dirty = false
    emitLifecycle('onOpenDocument', { id: rescued.id, path: null })
    notifyError(notice)
  }

  /**
   * Commit a finished read into the tab that asked for it — or leave both texts
   * alone.
   *
   * Guards, in order: the tab may be gone (closed, or closeAll ran, while the
   * read was pending — never resurrect one); `loading` may already be false
   * (this read's answer is stale); and the user may have typed into the
   * placeholder, which is what `dirty` says — it is set at the keystroke by
   * `markDirty`, and a keystroke is the only thing that sets it. Then the read
   * still owns the note, but not the typing.
   *
   * The store's reactive proxy is what gets written (NOT a captured raw
   * object): the read is async, so the pane may already be watch-ing
   * activeTab.content, and a raw-object write would bypass Vue's reactivity and
   * leave the editor permanently empty.
   */
  async function commitRead(id: string, content: string | null, failed: boolean): Promise<void> {
    const stored = tabs.value.find((x) => x.id === id)
    if (!stored || !stored.loading) return
    // The tab as it stands NOW — re-read below, because the flush is an await.
    let tab = stored
    if (stored.dirty) {
      // `dirty` is set at the KEYSTROKE, so at this moment the typing is in the
      // pane and the tab still holds the text from before it: both panes
      // serialize asynchronously (the rendered one — the default mode — on a
      // 120ms debounce, `editor-persistence.ts`), and `tab.content` is a field
      // read that only sees them once they publish. Flushing is what makes it
      // hold what the user typed, and the rescue below is a one-shot read of
      // exactly that field: without this it copies the empty placeholder into
      // the new tab and tells the user their text is safe. The same flush the
      // save path takes before it writes (`tab-save.ts`), for the same reason.
      await flushEdits()
      // Everything above is stale after that await — it is where a close, a
      // `closeAll` or a vault switch's `removeAllTabs` lands. A read that
      // resolves afterwards owns no tab, and must not resurrect one.
      const current = tabs.value.find((x) => x.id === id)
      if (!current || !current.loading) return
      tab = current
      rescuePlaceholderTyping(current, t('tabs.loadRacedTyping'))
    }
    // A failed read commits no text: the note has none to show, and the tab
    // goes away with the message that says so. The typing above is rescued
    // first — `removeTab` would take it with the tab.
    if (!failed) {
      tab.content = content!
      tab.savedContent = content!
    }
    tab.loading = false
  }

  async function openTab(path: string | null, initial = ''): Promise<void> {
    if (path && !vault.value) {
      notifyError(t('tabs.openVaultFirst'))
      return
    }
    if (path) {
      // Synchronous critical section: the duplicate check and the placeholder
      // push happen in the same tick, before any await. Two quick clicks on
      // one path are therefore serialized — the second finds the placeholder
      // (or the fully loaded tab) and focuses it instead of spawning a second
      // tab after the pending read resolves.
      const existing = tabs.value.find((x) => x.path === path)
      if (existing) {
        focusTab(existing.id)
        return
      }
      const tab: OpenTab = {
        id: nextId(),
        path,
        content: initial,
        savedContent: initial,
        dirty: false,
        loading: true,
        pendingAssetPaths: [],
      }
      tabs.value.push(tab)
      focusTab(tab.id)
      emitLifecycle('onOpenDocument', { id: tab.id, path: tab.path })
      try {
        const content = await files.read(vault.value!, path)
        // Awaited, both ways: the commit publishes the placeholder's typing
        // through a pane flush first, and the rescues below have to have
        // happened before anything reads the tab set again.
        await commitRead(tab.id, content, false)
      } catch {
        // The typing goes first: `removeTab` would take it with the tab, and it
        // is not this failed read's to discard.
        await commitRead(tab.id, null, true)
        removeTab(tab.id)
        notifyError(t('tabs.readFileFailed', { path }))
        return
      }
      // Crash-recovery probe must never block opening the file: the prompt is
      // fired after the tab is live, and the user can dismiss or restore it.
      void (async () => {
        const entry = await checkCrashRecovery(tab.id)
        if (entry) {
          notifyRecovery({
            message: t('tabs.crashRecoveryMsg', { time: new Date(entry.mtime).toLocaleString() }),
            onRestore: () => {
              void restoreHistoryToActive(tab.id, entry.id)
            },
            onDismiss: () => {},
          })
        }
      })()
      captureSession()
      return
    }
    const tab: OpenTab = {
      id: nextId(),
      path: null,
      content: initial,
      savedContent: initial,
      dirty: false,
      // Nothing to read: this tab is complete the moment it exists.
      loading: false,
      pendingAssetPaths: [],
    }
    tabs.value.push(tab)
    focusTab(tab.id)
    emitLifecycle('onOpenDocument', { id: tab.id, path: tab.path })
    captureSession()
  }

  /** Remove a tab without flushing anything (used after the file is gone). */
  function removeTab(id: string): void {
    cancelAutosave(id)
    const i = tabs.value.findIndex((x) => x.id === id)
    if (i < 0) return
    const removing = tabs.value[i]
    emitLifecycle('onCloseTab', { id, path: removing.path })
    tabs.value.splice(i, 1)
    if (activeId.value === id) {
      focusTab(tabs.value[i]?.id ?? tabs.value[i - 1]?.id ?? null)
    }
  }

  /** Drop every tab WITHOUT touching the filesystem. Only for callers that have
   *  already flushed the dirty tabs and prompted for the untitled ones — see
   *  `closeAll` and the vault-switch path in `appBootstrap`. "Flushed" means
   *  settled: `flushDirty` answers true only with every path'd dirty tab clean,
   *  because this contract named a caller that did not hold it once already —
   *  see `tab-settle.ts`. */
  function removeAllTabs(): void {
    // Leave no tab-scoped state behind: removeTab only cancels autosave
    // timers, but a closed tab's in-flight save, saving flag and self-write
    // window must also be reset or a later open/switch would inherit the stale
    // remnants.
    resetSaveBookkeeping()
    for (const tab of [...tabs.value]) removeTab(tab.id)
    focusTab(null)
  }

  /** The closes: the primitives above, asked what they owe text that is not on
   *  disk yet (see `tab-close.ts`). Composed here so `createTabLifecycle` — the
   *  single surface `tabs.ts` wires — keeps its shape across the split. */
  const close = createTabClose({
    tabs,
    t,
    notifyError,
    saveUntilSettled,
    flushDirty,
    requestUntitledClose,
    untitledDirtyTabs,
    captureSession,
    rescuePlaceholderTyping,
    removeTab,
    removeAllTabs,
    focusTab,
  })

  return {
    focusTab,
    setActive,
    markDirty,
    openTab,
    removeTab,
    removeAllTabs,
    ...close,
  }
}

export type TabLifecycle = ReturnType<typeof createTabLifecycle>
