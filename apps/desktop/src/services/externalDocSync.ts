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

  async function handle(e: FsChangeEvent): Promise<void> {
    // Every visual surface reacts, whether or not a document is involved.
    deps.onChange?.(e)

    const vault = deps.getVault()
    const active = deps.getActiveTab()
    if (!vault || !active || !active.path || active.path !== e.path) return
    // Our own write echoes back through the watcher; treating it as external
    // would reload the document and drop the caret on every save.
    if (deps.isSelfWrite(e.path)) return

    try {
      // Compare the bytes on disk with what we last persisted: an identical
      // file is a no-op touch (or our own write that raced the marker) and must
      // not reload — that would replace the live model and reset undo/caret.
      const disk = await deps.read(vault, active.path)
      if (disk === active.savedContent) return
    } catch {
      // A read failure still falls through to the normal conflict decision.
    }

    const decision = decideConflict({ dirty: active.dirty, hasDiskChange: true })
    if (decision === 'reload') {
      await deps.reload(active.id)
    } else if (decision === 'ask') {
      deps.onConflict({ tabId: active.id, path: e.path })
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
