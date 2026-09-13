/**
 * Which note an action is about, and its latest text.
 *
 * The note list lets the user right-click a card and act on THAT note. Every
 * action behind that menu — open, favourite, rename, export, delete — has to be
 * addressed by the path the user right-clicked, never by whatever tab happens to
 * be active. A wrong fallback is not a visible glitch: it exports or deletes a
 * DIFFERENT note than the one under the cursor, silently.
 *
 * So this module answers exactly two questions and nothing else:
 *
 *   1. what is the target? — {@link NoteActionTarget}, a path plus an optional
 *      tab handle, built from the card the user acted on;
 *   2. what is its latest content? — {@link readTargetContent}, which prefers
 *      the target's own open tab (flushing pending keystrokes first) and falls
 *      back to reading the target's file.
 *
 * The stores are injected rather than imported. That keeps the rule testable
 * without mounting a component or a Pinia app, and it is what makes "the active
 * tab is not an input" checkable: the only content sources this module knows
 * about are the tab matching the target path and a read of the target path.
 * Wiring lives with the caller (the note list builds `findTab`/`read` from the
 * tabs store and the fs gateway, the export path passes the same deps in).
 */

import { samePath } from './paths'

/**
 * The note the user acted on. Exactly these fields, on purpose: `path` is the
 * binding (it survives tab closes, renames of the ACTIVE tab, and menu reuse),
 * and `tabId` is only a handle the menu may carry along for later actions. No
 * field here is read from a store, and nothing resolves a target implicitly.
 */
export interface NoteActionTarget {
  path: string
  tabId?: string
}

/** The part of an open tab this boundary needs. Structurally satisfied by the
 *  tabs store's `OpenTab`, so callers pass their tab object straight through. */
export interface NoteActionTab {
  /** The tab handle later actions need (closing, deleting, focusing). */
  id: string
  /** The tab's path, or null for an unsaved untitled document. */
  path: string | null
  content: string
}

/** The injected surface for note-menu actions. */
export interface NoteActionDeps {
  /** Read a note from the vault (fs gateway `read`). */
  read(vault: string, path: string): Promise<string>
  /** The open tab for `path`, or null when the note is not open. The lookup
   *  must key on the path — it is asked for the target's path, not for "the
   *  current tab". */
  findTab(path: string): NoteActionTab | null
  /** Publish pending editor keystrokes into the tab (see `editorOwnership`). */
  flushEdits(): Promise<void>
  /** Open a note as a tab (the menu's "open" action). */
  openTab(path: string): Promise<void>
}

/**
 * A target could not be named or its content could not be read. Carries the
 * path so the caller can name the note in a notification; the message names it
 * too, for logs and for surfaces that show the raw error.
 */
export class NoteTargetError extends Error {
  readonly path: string

  constructor(path: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'NoteTargetError'
    this.path = path
  }
}

/** A blank path cannot name a note, and letting it through would reach a
 *  read/delete call with nothing to bind to. */
function assertUsablePath(path: unknown): string {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new NoteTargetError(
      typeof path === 'string' ? path : '',
      'a note action target needs the path of the note it acts on',
    )
  }
  return path
}

/**
 * Build the target for a note the user acted on.
 *
 * `tabId` is optional and only kept when it is a real handle: the card knows
 * its tab id as `string | undefined` (`find(...)?.id`), and storing an empty
 * one would make a later "is this note open?" check answer wrongly.
 */
export function noteActionTarget(path: string, tabId?: string | null): NoteActionTarget {
  const target: NoteActionTarget = { path: assertUsablePath(path) }
  if (typeof tabId === 'string' && tabId.trim() !== '') target.tabId = tabId
  return target
}

/**
 * The target note's latest text.
 *
 * Resolution order, and there is no third step:
 *
 *   1. the OPEN TAB whose path is the target path — flushed first, because both
 *      editor panes coalesce keystrokes through their own debounce and the tab
 *      otherwise lags what the user can see. `flushEdits` publishes the mounted
 *      panes, and only the active tab's panes are mounted, so flushing is a
 *      no-op for the target's content when the target is a background tab and
 *      the exact fix when it is the active one;
 *   2. otherwise a read of the target path from the vault.
 *
 * The active tab is deliberately NOT in that list, not even as a fallback: when
 * the target is not the active note, its text must never be returned.
 */
export async function readTargetContent(
  deps: NoteActionDeps,
  vault: string | null,
  target: NoteActionTarget,
): Promise<string> {
  const path = assertUsablePath(target?.path)

  const tab = deps.findTab(path)
  // A lookup that answers with some other tab (the active one, a stale id) is
  // discarded rather than trusted: its content belongs to a different note, and
  // returning it is the wrong-note bug this boundary exists to prevent. The
  // file then decides, which is the correct content for this path either way.
  if (tab && tab.path !== null && samePath(tab.path, path)) {
    await deps.flushEdits()
    return tab.content
  }

  if (!vault) {
    throw new NoteTargetError(path, `no vault is open, so ${path} cannot be read`)
  }
  try {
    return await deps.read(vault, path)
  } catch (cause) {
    // Never degrade to empty text: the caller would export an empty document,
    // or treat a delete as done for a file it never touched. Name the path and
    // keep the backend error as the cause.
    throw new NoteTargetError(path, `could not read the note: ${path}`, { cause })
  }
}
