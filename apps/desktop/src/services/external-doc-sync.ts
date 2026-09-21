/**
 * App-level "the file changed on disk" handling for every OPEN document.
 *
 * This used to live in `FileTree.vue`, which is only mounted while the sidebar
 * shows the Folders panel. Opening a note from the Notes panel (the DEFAULT
 * view) therefore left nobody listening: an external edit was never noticed,
 * the editor kept showing the old text, and the next save overwrote the other
 * program's change. External-edit reload is a headline capability, so the
 * subscription belongs to the app, not to one panel.
 *
 * And it belongs to every open document, not only the one on screen (L05). An
 * open tab is not a saved copy of anything: a comparison against the active tab
 * alone let the others hold text the file no longer had, with nothing on screen
 * to say so. The tab the user then switched to showed that text with the caret
 * in it, and the edit they made on top of it was saved over the version they
 * never saw. Switching back re-points `activeId` and nothing else, so the stale
 * text survived even a deliberate look at the note. The decision is therefore
 * made per PATH, for every tab holding the changed file, using exactly the same
 * rules for a background tab as for the visible one.
 *
 * The service owns only the decision + reload. Surfaces that need to react
 * visually (the file tree refreshing its rows) subscribe to `onChange`.
 */

import { decideConflict } from './errors'
import type { FsChangeEvent } from '../platform/gateways/contracts'

/** One open document, as the decision needs it: what it is, and what it
 *  believes is on disk. Structural on purpose — the tab store's `OpenTab`
 *  satisfies it, and nothing here imports the store. */
export interface OpenDocTab {
  id: string
  path: string | null
  dirty: boolean
  /** The bytes this tab last wrote or read: what the disk is compared
   *  against. */
  savedContent: string
}

export interface ExternalDocSyncDeps {
  /**
   * Every open tab, answered from LIVE state rather than from a copy taken
   * earlier. A change to a FOLDER is checked against the notes that live inside
   * it, and a change to a NOTE is decided for every tab holding it — not only
   * the one on screen (see the module note).
   *
   * Called once for the tab set to visit and again, per tab, after each read
   * (see `currentTab`), so a provider that memoizes this answer would put the
   * stale comparison back. */
  getOpenTabs(): ReadonlyArray<OpenDocTab>
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
  /**
   * True when an fs change for `path` is this app's own write.
   *
   * `disk` is what was just read at that path, or null when it could not be
   * read. It is passed because our own write is identified by its CONTENT, not
   * by elapsed time: a claim that expired on a clock let the app read back its
   * own save echo as an external edit whenever the write outlived the window.
   */
  isSelfWrite(path: string, disk: string | null): boolean
  /** True while the APP is renaming/moving this path (or a folder above it). */
  isPendingMove?(path: string): boolean
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
  /**
   * Bumped by every `start()` and every `stop()`.
   *
   * `if (unlisten) return` is checked *before* the await, so two starts in
   * flight both pass it and the second to resolve overwrites the first —
   * orphaning a registration nothing holds the unsubscribe for. And a `stop()`
   * during the await nulls `unlisten` only for the registration to land
   * afterwards, leaving a listener alive on an object the caller believes is
   * stopped. A ticket tells a late registration that the world moved, so it can
   * release **its own** registration instead of storing it.
   */
  let generation = 0
  const pendingReads = new Map<string, symbol>()

  /** True when `path` is `ancestor` itself or lives beneath it. */
  function isUnder(path: string, ancestor: string): boolean {
    const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '')
    const p = norm(path)
    const a = norm(ancestor)
    return p === a || p.startsWith(`${a}/`)
  }

  /**
   * The tab's state as it is NOW, by id — never the copy the loop was holding.
   *
   * The read below is an await, and a read is an IPC round trip: long enough for
   * the world to move under it. The case that proves it is our OWN save. The
   * write lands, the save records the bytes it wrote and clears `dirty`, and the
   * claim it held is settled — all while the read is still in flight. What comes
   * back is then the bytes the app just wrote, and the snapshot the loop took
   * disagrees with them twice over: `isSelfWrite` is asked about a claim the
   * save has already released, and the content comparison is asked about a
   * `savedContent` the tab has already replaced. Both guards miss by one time
   * slice, and the user is asked whether to keep or reload their own autosave —
   * about a tab with nothing unsaved, while the status line beside it reads
   * "saved".
   *
   * A tab that is gone by now is not decided at all: there is nothing to reload
   * and nobody to ask.
   */
  function currentTab(vault: string, id: string, path: string, ticket: number, readTicket: symbol): OpenDocTab | null {
    if (pendingReads.get(id) !== readTicket) return null
    if (ticket !== generation || deps.getVault() !== vault || deps.isPendingMove?.(path)) return null
    return deps.getOpenTabs().find((t) => t.id === id && t.path === path) ?? null
  }

  /**
   * Read `id`'s file and act on what is there.
   *
   * The read DOUBLES as the existence probe, and that is deliberate: a path the
   * disk will not give us is the folder-renamed-or-deleted-outside-the-app case
   * this service exists to catch. Asking "is it there?" and then reading it
   * again to compare gave two answers to one question, and on a read failure
   * they disagreed — the probe said the file was gone while the comparison said
   * to carry on and decide anyway. One read, one answer, one decision.
   *
   * The bytes come BEFORE the decision, because they are what the decision is
   * made of: our own write echoes back through the watcher, and treating it as
   * external would reload the document and drop the caret on every save — and
   * on a tab with unsaved edits it would ask a keep-or-reload question about a
   * change the app made itself, whose "use the disk version" answer discards
   * every keystroke typed since the save began.
   *
   * Both guards are asked of the LIVE tab (see `currentTab`): the tab is not a
   * parameter, because a tab read before the await is a snapshot, and every
   * comparison this function makes is one the snapshot gets wrong.
   */
  async function examine(vault: string, id: string, path: string, ticket: number, readTicket: symbol): Promise<void> {
    let disk: string
    try {
      disk = await deps.read(vault, path)
    } catch (error) {
      // Only the gateways' missing-file reason proves absence. Permission and
      // decoding failures must not detach a file that still exists.
      const message = error instanceof Error ? error.message : String(error)
      const missing = /^could not read [\s\S]+: no such file or folder(?: \(os error 2\))?$/.test(message)
        || message.startsWith('No such file in demo vault: ')
      if (missing && currentTab(vault, id, path, ticket, readTicket)) deps.onMissing(id, path)
      return
    }
    if (deps.isSelfWrite(path, disk)) return
    // Asked AFTER the await and only for this tab: what the decision needs is
    // what the tab holds now, not what the loop saw when it started.
    const tab = currentTab(vault, id, path, ticket, readTicket)
    if (!tab) return
    // An identical file is a no-op touch (or our own write that raced the
    // claim) and must not reload — that would replace the live model and reset
    // undo/caret.
    if (disk === tab.savedContent) return

    const decision = decideConflict({ dirty: tab.dirty, hasDiskChange: true })
    if (decision === 'reload') {
      await deps.reload(tab.id)
    } else if (decision === 'ask') {
      deps.onConflict({ tabId: tab.id, path })
    }
  }

  /**
   * Decide every open tab whose path `inScope` accepts — the same rules for all
   * of them, whatever is on screen.
   *
   * A tab the APP is renaming is skipped rather than read. Its path is
   * momentarily absent on disk while the move runs — `renamePathInTabs` only
   * updates the tabs once the disk work is done — so reading it finds nothing
   * and the tab is detached as a file "moved outside the app": it turns into
   * "Untitled" and the next Ctrl+S asks for a new location instead of saving to
   * the note the user just renamed. The move owns the path until it finishes.
   */
  async function examineEach(
    vault: string,
    inScope: (path: string) => boolean,
    ticket: number,
  ): Promise<void> {
    // Claim all affected tabs before awaiting: a queued resync must not take
    // ownership back from a newer file event while it waits on an earlier tab.
    const candidates = deps.getOpenTabs().flatMap((tab) => {
      if (!tab.path || !inScope(tab.path)) return []
      const readTicket = Symbol()
      pendingReads.set(tab.id, readTicket)
      return [{ id: tab.id, path: tab.path, readTicket }]
    })
    try {
      for (const { id, path, readTicket } of candidates) {
        if (ticket !== generation || deps.getVault() !== vault) return
        if (!currentTab(vault, id, path, ticket, readTicket)) continue
        await examine(vault, id, path, ticket, readTicket)
      }
    } finally {
      for (const { id, readTicket } of candidates) {
        if (pendingReads.get(id) === readTicket) pendingReads.delete(id)
      }
    }
  }

  /**
   * A FOLDER event names only the folder, so a note inside it can disappear —
   * or change — with no event naming the note. The kind is not a reliable
   * signal either: renaming a folder on Windows reports `modified` for BOTH
   * names, not `removed` + `created` (measured), so gating on `removed` meant
   * the common case went unnoticed and the next save silently recreated the old
   * path.
   *
   * The check is cheap and self-limiting: only tabs living under the changed
   * path are examined, and each costs one read. A file event matches at most
   * the tabs holding that file, so ordinary note/image writes stay no-ops.
   */
  async function examineTabsUnder(vault: string, path: string, ticket: number): Promise<void> {
    await examineEach(vault, (open) => isUnder(open, path), ticket)
  }

  /**
   * The watcher lost events (see `FsChangeKind.resync`), so the per-path checks
   * below cannot be trusted: a change to any open note may never have been
   * reported. Re-check every open tab against the disk instead of waiting for an
   * event that will not come — the cost is one read per open tab, and the
   * alternative is a silent divergence that ends with the user's save
   * overwriting someone else's edit.
   */
  async function resyncAll(vault: string, ticket: number): Promise<void> {
    await examineEach(vault, () => true, ticket)
  }

  async function handle(e: FsChangeEvent, ticket: number): Promise<void> {
    if (ticket !== generation) return
    // Every visual surface reacts, whether or not a document is involved.
    deps.onChange?.(e)

    const vault = deps.getVault()
    if (!vault) return
    if (e.kind === 'resync') {
      await resyncAll(vault, ticket)
      return
    }
    await examineTabsUnder(vault, e.path, ticket)
  }

  return {
    async start(): Promise<void> {
      if (unlisten) return
      const mine = ++generation
      const off = await deps.onFsChange((e) => {
        void handle(e, mine)
      })
      if (mine !== generation) {
        off()
        return
      }
      unlisten = off
    },
    stop(): void {
      generation++
      pendingReads.clear()
      unlisten?.()
      unlisten = null
    },
  }
}
