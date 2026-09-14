/**
 * Where the reader was in each note.
 *
 * The panes are the only things that can measure themselves, and their two
 * geometries have nothing in common — the same note is one height in the source
 * pane and another in the rendered one — so a pixel offset cannot be the memory.
 * A source LINE can: it is the document's own coordinate, and the whole app
 * already carries positions in it (the mode handoff, the split sync, the
 * outline). It is also what makes a stale memory safe: the line is clamped into
 * whatever the document holds now, so a note edited shorter elsewhere (or one
 * whose text arrived from disk in a shorter version) lands the reader at its
 * end rather than at some offset measured against a document that no longer
 * exists.
 *
 * The memory itself is in-memory and session-scoped, keyed by tab id. Two
 * rules keep it from lying:
 *
 * - an entry is dropped as soon as its tab leaves the open set, so a recycled
 *   tab id (open tabs are numbered per vault session) cannot inherit another
 *   note's position;
 * - a restore has to be ARMED by activating a note, and each pane may take it
 *   once per activation. Nothing else re-places a pane: a disk reload, a
 *   history restore or a preview re-sync leaves the pane where the reader put
 *   it, exactly as before.
 */

/** Which pane is claiming a restore. Both can be on screen (split mode), and
 *  both have to land on the same line, so the claim is per pane. */
export type PaneSide = 'source' | 'rendered'

/** Top-of-viewport line of each note, 1-based and possibly fractional — the
 *  same unit `getVisibleLine` reports. */
const readingLines = new Map<string, number>()

/** The restore armed by activating a note, and who has taken it. */
let armed: { tabId: string; line: number; generation: number } | null = null
let generation = 0
const claimed = new Map<PaneSide, number>()

/** Record where a note was left. Called with the pane's own measurement, so a
 *  nonsense value is dropped rather than stored. */
export function rememberReadingLine(tabId: string, line: number): void {
  if (!Number.isFinite(line) || line < 1) return
  readingLines.set(tabId, line)
}

/** The line a note was left at, or null when it was never shown. */
export function readingLineOf(tabId: string): number | null {
  return readingLines.get(tabId) ?? null
}

/**
 * Arm the one-shot restore for a note that has just been activated.
 *
 * A note with no memory arms nothing, which also clears whatever was armed
 * before: a restore belongs to the activation that armed it.
 */
export function armReadingRestore(tabId: string): void {
  const line = readingLines.get(tabId)
  if (line === undefined) {
    armed = null
    return
  }
  generation += 1
  armed = { tabId, line, generation }
}

/**
 * The line `side` has to be put back on, or null when nothing is armed for this
 * note, or this pane has already taken it.
 *
 * Each pane takes the armed line once, when it is holding that note's document.
 * The two panes arrive at different moments (the source pane's text is set the
 * moment the tab changes; the rendered pane's model is rebuilt when its parse
 * resolves), which is why this is a claim rather than a value the caller reads.
 */
export function claimReadingLine(tabId: string, side: PaneSide): number | null {
  if (armed === null || armed.tabId !== tabId) return null
  if (claimed.get(side) === armed.generation) return null
  claimed.set(side, armed.generation)
  return armed.line
}

/** Drop the positions of notes that are no longer open. */
export function forgetReadingLines(openTabIds: Iterable<string>): void {
  const open = new Set(openTabIds)
  for (const id of [...readingLines.keys()]) {
    if (!open.has(id)) readingLines.delete(id)
  }
}

/** Forget everything (tests, and a vault that is being replaced wholesale). */
export function resetReadingLines(): void {
  readingLines.clear()
  armed = null
  claimed.clear()
}
