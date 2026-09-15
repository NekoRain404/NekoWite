/**
 * Which filesystem writes are this app's own.
 *
 * The app writes a note and the watcher reports the write back to it. Without a
 * claim the app reads its own save echo as an external edit: it reloads the
 * document it just saved (dropping the caret and the live model), and on a tab
 * with unsaved edits it asks a keep-or-reload question about a change it made
 * itself — whose "use the disk version" answer discards every keystroke typed
 * since the save began.
 *
 * The claim is therefore the CONTENT the app wrote, not a stopwatch. It used to
 * be a fixed window measured from the START of the write, and its defect was
 * structural rather than a matter of length: a write that outlives any fixed
 * window falls out of it, so the app read its own echo as somebody else's. No
 * duration fixes that — the window closes while the write is still running
 * whatever it is set to. Naming the bytes ends the guesswork: the claim is held
 * from before the write until the write settles, so it cannot expire underneath
 * a slow one, and an external edit landing in the same window is still
 * reported, because it writes different bytes.
 *
 * Two kinds of claim, distinguished by whether the caller has bytes to name:
 *
 *   - **named** (`noteSelfWrite(path, content)` … `settleSelfWrite(path)`) — the
 *     save path. Held for exactly as long as the write runs. After it settles,
 *     identification is by content anyway: a landed save leaves the bytes it
 *     wrote in the tab's `savedContent`, which `externalDocSync` compares the
 *     disk against before it decides anything.
 *   - **timed** (`noteSelfWrite(path)`) — an operation with no single write to
 *     point at (a delete, a rename). Those have no settle moment to bind to, so
 *     they keep a clock.
 *
 * The shape IS the lifetime, and it is fixed when the claim is made. A named
 * claim has no clock to run out: nothing in this module can end it except the
 * write it belongs to. That is the whole point of the split — the prune used to
 * sweep every claim on the timed rule, so a `note` for an unrelated path, taken
 * while a slow save was still running, quietly ended that save's claim, and the
 * app read its own echo as a change nobody had made. A rule that a claim was
 * not made under must not be able to expire it.
 *
 * Split out of `tab-save.ts` for the line budget (§13.1) and because it is a
 * question with one answer that two modules ask.
 */

/**
 * How long a claim by a path with no bytes to name is honoured. Named claims
 * do not use it — see the module note above.
 */
export const SELF_WRITE_MS = 2000

/**
 * A claim, in one of the two shapes the module note describes.
 *
 * `named` carries no timestamp and `timed` carries no content, so neither can
 * be held to the other's rule: "may this still be honoured?" has one answer per
 * shape, and the type says which.
 */
type Claim =
  | { kind: 'named'; content: string }
  | { kind: 'timed'; at: number }

export interface SelfWrites {
  /**
   * Claim `path` as this app's own write.
   *
   * `content` is what is about to be written. Passing it is what makes the
   * claim honest for the whole write; a caller with no bytes to name (a delete,
   * a rename) omits it and gets the timed claim.
   */
  note(path: string, content?: string): void
  /**
   * The write for `path` has landed or failed: the claim ends here.
   *
   * A claim must not outlive the write that armed it, or a later genuine
   * external edit to that path would be read as our echo and silently dropped.
   * A successful save needs no claim after this — see the module note.
   */
  settle(path: string): void
  /**
   * True when an fs change reported for `path` is this app's own write.
   *
   * `disk` is what the watcher found at that path, or null when it could not be
   * read at all.
   */
  isSelfWrite(path: string, disk?: string | null): boolean
  /** Drop every claim (the tab set was replaced; nothing here still holds). */
  clear(): void
}

export function createSelfWrites(now: () => number = () => Date.now()): SelfWrites {
  const claims = new Map<string, Claim>()

  /** Drop the claims that have run out of time — the timed ones, and only
   *  those. A named claim's lifetime is the write it was made for, so it is
   *  `settle` that ends it, never a sweep taken while some other write runs. */
  function prune(at = now()): void {
    for (const [path, claim] of claims) {
      if (claim.kind === 'timed' && at - claim.at > SELF_WRITE_MS) claims.delete(path)
    }
  }

  function note(path: string, content?: string): void {
    prune()
    claims.set(
      path,
      content === undefined ? { kind: 'timed', at: now() } : { kind: 'named', content },
    )
  }

  function settle(path: string): void {
    claims.delete(path)
  }

  function isSelfWrite(path: string, disk?: string | null): boolean {
    const claim = claims.get(path)
    if (claim === undefined) return false
    if (claim.kind === 'named') {
      // A named write is in flight: ours only when what the watcher found is
      // what we are writing. No bytes to compare — an unreadable path, which is
      // what our own delete leaves behind — still counts as ours.
      return disk === undefined || disk === null || disk === claim.content
    }
    if (now() - claim.at <= SELF_WRITE_MS) return true
    claims.delete(path)
    return false
  }

  return { note, settle, isSelfWrite, clear: () => claims.clear() }
}
