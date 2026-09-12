/**
 * App-level "the file changed on disk" handling for the OPEN document.
 *
 * This used to live in `FileTree.vue`, which is only mounted while the sidebar
 * shows the Folders panel. Opening a note from the Notes panel (the DEFAULT
 * view) therefore left nobody listening: an external edit was never noticed,
 * the editor kept showing the old text, and the next save overwrote the other
 * program's change. External-edit reload is a headline capability, so the
 * subscription belongs to the app, not to one panel.
 *
 * The service owns only the decision + reload. Surfaces that need to react
 * visually (the file tree refreshing its rows) subscribe to `onChange`.
 */

import { decideConflict } from './errors'
import type { FsChangeEvent } from '../platform/gateways/contracts'

export interface ExternalDocSyncDeps {
  /** Every open tab, so a change to a FOLDER can be checked against the notes
   *  that live inside it (see `onMissing`). */
  getOpenTabs(): ReadonlyArray<{ id: string; path: string | null }>
  /**
   * Called when a tab's file no longer exists — its folder was renamed or
   * deleted outside the app, for instance. The app must stop writing to that
   * path: the backend recreates missing parent directories, so a save would
   * silently resurrect the old location and leave the user with two copies of
   * one note, diverging. */
  onMissing(tabId: string, path: string): void
  /** Read a file's bytes (used to tell our own save echo from an external one). */
  read(vault: string, path: string): Promise<string>
  /** Subscribe to backend fs-change events; resolves to an unsubscribe. */
  onFsChange(cb: (e: FsChangeEvent) => void): Promise<() => void>
  /** The vault to read through, or null when none is open. */
  getVault(): string | null
  /** The tab currently shown, or null. */
  getActiveTab(): { id: string; path: string | null; dirty: boolean; savedContent: string } | null
  /** True while a path is inside the window where we treat a write as our own. */
  isSelfWrite(path: string): boolean
  /** Reload the tab's content from disk. */
  reload(tabId: string): Promise<void>
  /** Surface a keep-or-reload question (the tab has unsaved edits). */
  onConflict(req: { tabId: string; path: string }): void
  /** Extra listeners (e.g. the file tree refreshing its rows). */
  onChange?(e: FsChangeEvent): void
}

export interface ExternalDocSync {
  start(): Promise<void>
  stop(): void
}

export function createExternalDocSync(deps: ExternalDocSyncDeps): ExternalDocSync {
  let unlisten: (() => void) | null = null

  /** True when `path` is `ancestor` itself or lives beneath it. */
  function isUnder(path: string, ancestor: string): boolean {
    const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '')
    const p = norm(path)
    const a = norm(ancestor)
    return p === a || p.startsWith(`${a}/`)
  }

  /**
   * A FOLDER that lost or gained an entry only reports the folder itself, so a
   * note inside it can disappear without any event naming the note. Ask the disk
   * about every tab under that path and report the ones that are actually gone.
   */
  async function checkTabsUnder(vault: string, folder: string): Promise<void> {
    for (const tab of deps.getOpenTabs()) {
      if (!tab.path || !isUnder(tab.path, folder)) continue
      try {
        await deps.read(vault, tab.path)
      } catch {
        deps.onMissing(tab.id, tab.path)
      }
    }
  }

  async function handle(e: FsChangeEvent): Promise<void> {
    // Every visual surface reacts, whether or not a document is involved.
    deps.onChange?.(e)

    const vault = deps.getVault()
    if (!vault) return
    // A folder change can take open notes with it and no event will name them
    // individually — and the kind is not a reliable signal: renaming a folder on
    // Windows reports `modified` for BOTH names, not `removed` + `created`
    // (measured), so gating on `removed` meant the common case went unnoticed
    // and the next save silently recreated the old path.
    //
    // The check is cheap and self-limiting: only tabs living under the changed
    // path are examined, and each costs one read that doubles as the existence
    // probe. A file event matches no tab (a file path cannot be a note's
    // ancestor), so ordinary note/image writes stay no-ops.
    await checkTabsUnder(vault, e.path)

    const activeTab = deps.getActiveTab()
    if (!activeTab || !activeTab.path || activeTab.path !== e.path) return
    // Our own write echoes back through the watcher; treating it as external
    // would reload the document and drop the caret on every save.
    if (deps.isSelfWrite(e.path)) return

    try {
      // Compare the bytes on disk with what we last persisted: an identical
      // file is a no-op touch (or our own write that raced the marker) and must
      // not reload — that would replace the live model and reset undo/caret.
      const disk = await deps.read(vault, activeTab.path)
      if (disk === activeTab.savedContent) return
    } catch {
      // A read failure still falls through to the normal conflict decision.
    }

    const decision = decideConflict({ dirty: activeTab.dirty, hasDiskChange: true })
    if (decision === 'reload') {
      await deps.reload(activeTab.id)
    } else if (decision === 'ask') {
      deps.onConflict({ tabId: activeTab.id, path: e.path })
    }
  }

  return {
    async start(): Promise<void> {
      if (unlisten) return
      unlisten = await deps.onFsChange((e) => {
        void handle(e)
      })
    },
    stop(): void {
      unlisten?.()
      unlisten = null
    },
  }
}
