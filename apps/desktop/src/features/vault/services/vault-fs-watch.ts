/**
 * The open vault's filesystem watch: it holds the fs subscription, remembers
 * whether that subscription is alive, and turns raw fs events into the work the
 * index has to do about them (invalidate the file list, re-index one note,
 * re-run the whole note index, refresh the attachment badge).
 *
 * The coalescing is why this is a module and not a callback. A save emits
 * several events for one path and a paste writes several attachments, while the
 * reaction to a single event is a re-read of the vault - so everything cheap is
 * done now and everything expensive is deferred behind a debounce. Each
 * deferred reaction carries the generation that was current when it was
 * scheduled, so a vault switch landing inside the window, or a newer event for
 * the same path, turns the pending work into a no-op instead of letting it
 * write into a vault it no longer describes.
 *
 * `resync` is the one event that names no path: it says the watcher itself may
 * have lost changes, so it is answered with the same whole-vault re-read a
 * structural change triggers rather than with a per-path reaction.
 *
 * Degraded mode lives here too: when the subscription cannot be established the
 * app is deaf to everything that happens outside it, and `isDown()` is what the
 * rest of the index asks before trusting anything it read earlier.
 */

import type { FsChangeEvent, FsChangeKind } from '../../../platform/gateways/contracts'
import { extensionFromFileName } from '../../attachments'
import { baseName } from '../../../services/paths'

/** Coalesce bursts of markdown fs-change events for one path into a single
 * re-index (a save may otherwise emit several read + stat + index updates). */
const MD_CHANGE_DEBOUNCE_MS = 200

function isMdPath(path: string): boolean {
  return /\.(md|mdx)$/i.test(path)
}

export interface VaultFsWatchDeps {
  /** Subscribe to fs-change events; resolves to an unsubscribe. */
  onFsChange(cb: (e: FsChangeEvent) => void): Promise<() => void>
  /** The vault that is open right now, or null after `detach`. Read live: an
   *  event can land while a switch is still in flight. */
  currentVault(): string | null
  /** Latest-wins token naming the vault session a deferred reaction belongs to. */
  generation(): number
  /** Drop the cached vault file list — the change may have added or removed one. */
  invalidateFileList(vault: string): void
  /** True when `path` is, or contains, a note the note-list index lists. */
  indexedNotesCover(vault: string, path: string): boolean
  /** Re-run the full note index for `vault` (already debounced here). */
  reindexAll(vault: string, generation: number): void
  /** Re-index the single markdown note at `path`. `isStale` is the supersede
   *  guard — a newer event for the same path, or a vault switch — which the
   *  callee must re-check around every await before it writes. */
  noteChanged(vault: string, path: string, kind: FsChangeKind, isStale: () => boolean): void
  /** The attachment tree changed: refresh its badge (already debounced here). */
  attachmentChanged(vault: string, generation: number): void
  /** The subscription could not be established (`down: true`) or is back. */
  watcherStateChanged(down: boolean, error?: unknown): void
}

export interface VaultFsWatch {
  /** Try to establish the fs-change subscription for `vault`.
   *
   * Returns the unsubscribe when it worked. A failure is reported rather than
   * swallowed, and remembered so `rebuildIndex` (the user's "refresh this
   * list" button) can retry it: otherwise the only way back to a live list was
   * to switch vaults and back, which nothing on screen suggests. */
  subscribe(vault: string): Promise<(() => void) | null>
  /** Cancel pending coalesced work and forget the degraded flag (vault switch). */
  stop(): void
  /** True while the fs-change subscription is missing. */
  isDown(): boolean
}

export function createVaultFsWatch(deps: VaultFsWatchDeps): VaultFsWatch {
  /** Pending full re-index for a structural folder change. */
  let reindexTimer: ReturnType<typeof setTimeout> | null = null
  /** path → pending markdown re-index timer (coalesced per note). */
  const mdChangeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** path → latest markdown change generation; a stale read must never win. */
  const mdChangeSeq = new Map<string, number>()

  /** True while the fs-change subscription is missing, so nothing may assume
   *  in-memory state (the note stat mirror, the content cache, the search
   *  index) still matches the disk - no event would report a change made
   *  outside the app (see `subscribe`). */
  let fsWatchDown = false

  /** Debounce a full re-index of `v`, collapsing a burst into a single run.
   *
   * The slot holds ONE pending run and is re-set rather than appended to, so a
   * newer change supersedes the pending one instead of queueing behind it. A run
   * that is already in flight is not cancelled and does not swallow the new
   * request: the timer fires regardless and starts a fresh run over the current
   * file list. That is the rule the coordinator already applies to full runs
   * (latest-wins, one generation read when the work actually starts), and a
   * second policy beside it would be a second thing to keep in step. */
  function scheduleReindex(v: string): void {
    if (reindexTimer) clearTimeout(reindexTimer)
    reindexTimer = setTimeout(() => {
      reindexTimer = null
      if (deps.currentVault() !== v) return
      deps.reindexAll(v, deps.generation())
    }, MD_CHANGE_DEBOUNCE_MS)
  }

  function handleFsChange(e: FsChangeEvent): void {
    const v = deps.currentVault()
    if (!v) return
    // A `resync` is not a change to one path — the watcher is telling us it LOST
    // events (an overflowing OS queue, an exhausted handle), so nothing the index
    // holds about this vault can be trusted, the file list included. It is the one
    // case where the watcher knows it may be wrong, so it has to repair itself the
    // way a structural change does: waiting for the per-path event that would
    // normally carry a new or deleted note means waiting for an event that was
    // dropped, and the note list then stays stale for good. Handled before the
    // path heuristics below, because the path a resync carries is the watch root
    // and reading it as an ordinary non-note folder is exactly the misreading that
    // made it a no-op.
    if (e.kind === 'resync') {
      deps.invalidateFileList(v)
      scheduleReindex(v)
      deps.attachmentChanged(v, deps.generation())
      return
    }
    if (!isMdPath(e.path)) {
      deps.invalidateFileList(v)
      // A folder that was created or removed may have taken notes with it; the
      // note list would otherwise keep listing notes that are no longer there
      // (and clicking one fails only later, at read time).
      const structural = e.kind === 'created' || e.kind === 'removed'
      const looksLikeAttachment = Boolean(extensionFromFileName(baseName(e.path)))
      if (structural && (!looksLikeAttachment || deps.indexedNotesCover(v, e.path))) {
        scheduleReindex(v)
      }
      // Bind the pending refresh to the vault generation that is current NOW:
      // reading the attachment tree takes several awaits, so a vault switch can
      // land while the count is being computed, and the count then belongs to the
      // vault that was left (see the badge's `refresh`).
      deps.attachmentChanged(v, deps.generation())
      return
    }
    deps.invalidateFileList(v)
    const path = e.path
    const existing = mdChangeTimers.get(path)
    if (existing) clearTimeout(existing)
    const generation = (mdChangeSeq.get(path) ?? 0) + 1
    mdChangeSeq.set(path, generation)
    mdChangeTimers.set(
      path,
      setTimeout(() => {
        mdChangeTimers.delete(path)
        deps.noteChanged(
          v,
          path,
          e.kind,
          () => deps.currentVault() !== v || mdChangeSeq.get(path) !== generation,
        )
      }, MD_CHANGE_DEBOUNCE_MS),
    )
  }

  async function subscribe(v: string): Promise<(() => void) | null> {
    try {
      const listener = await deps.onFsChange(handleFsChange)
      if (fsWatchDown) {
        fsWatchDown = false
        deps.watcherStateChanged(false)
      }
      return listener
    } catch (err) {
      console.error(`[NekoWite] vault "${v}" file-change subscription failed`, err)
      if (!fsWatchDown) {
        fsWatchDown = true
        deps.watcherStateChanged(true, err)
      }
      return null
    }
  }

  function stop(): void {
    if (reindexTimer) {
      clearTimeout(reindexTimer)
      reindexTimer = null
    }
    for (const timer of mdChangeTimers.values()) clearTimeout(timer)
    mdChangeTimers.clear()
    mdChangeSeq.clear()
    fsWatchDown = false
  }

  return { subscribe, stop, isDown: () => fsWatchDown }
}
