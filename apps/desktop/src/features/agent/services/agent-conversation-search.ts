/**
 * What a query over the open conversation matches, and where each hit sits.
 *
 * This is the transcript's find box as a rule rather than as a widget: the set of strings a
 * query is allowed to answer to, where in each of them the hit is, how a hit keeps its identity
 * while the engine streams, and which hit the arrows step to. Everything here is a pure function
 * over the rows the view already holds, so the whole rule is testable without a browser — and
 * the browser half (does the reader reach the box, does the container move to the hit) is
 * measured by the WebKit probe instead of asserted twice.
 *
 * **The scope is what the transcript draws, and the reason it stops where it does is
 * reachability.** A count that includes a hit the reader cannot be taken to is worse than no
 * count, so every hit here is one the transcript's own scroll can bring to them:
 *
 *  - the reader's own turns, the engine's answers, the engine's reasoning, the names of the files
 *    a turn carried, and the engine's facts on a tool call's row — the title (or the name it
 *    draws instead), and the paths it touched;
 *  - **not** a tool call's arguments, output or proposed change. Those are drawn inside their own
 *    scroll boxes, and the change is additionally folded by its own disclosure, so the
 *    transcript's own scroll cannot bring a hit there into view. Zed's bar keeps the same line
 *    for its own reason (`conversation_view/thread_search_bar.rs:924`: a call's content is
 *    scanned only while the call is expanded) and reaches the hit by scrolling the block itself;
 *    this panel has no such write, so the honest move is to leave those words out of the count.
 *    The call's header still says what the call was, and that is searched.
 *  - **not** anything this app wrote. A tool row's status word, the disclosure labels, the
 *    sentence drawn where the engine sent no title: they are the app's words, and a reader who
 *    typed one of them is looking for something the session never said.
 *
 * **Reasoning is searched whether or not it is unfolded**, which is a deliberate departure from
 * Zed's scan. Zed can only search a reasoning block whose markdown exists, so a collapsed block
 * is not in its count (`thread_search_bar.rs:348`, `:899-907`) — a rule that costs nothing there
 * because its blocks start closed only when the reader closed them. This panel opens them closed
 * by default, so the same scan would leave the engine's reasoning out of every search unless the
 * reader had already unfolded it one row at a time, and a search that reports "no match" about
 * words the session holds is exactly the count that lies. What makes counting them honest is the
 * other half: landing on a hit inside a folded row unfolds it, so a hit that is counted is a hit
 * the reader is taken to.
 *
 * Two things this file deliberately does not do. It does not fuzzy-match: `needle` inside
 * `haystack` is a sentence a reader can verify by looking at the row, and the same reason the
 * history list's filter gives (`agent-session-history.ts:162`). And it does not offer Zed's
 * case/whole-word/regex switches: the rail is 220px at its narrowest, the app's other find box
 * (`AgentSessionHistoryHead.vue`) offers none, and a case-insensitive containment test is the
 * least surprising default of the three.
 */
import type { AgentTimelineEntry } from './agent-timeline'

/**
 * Which drawn string of a row a hit sits in.
 *
 * `attach:<index>` addresses one entry of the row's own attachment list, by position: two turns
 * can carry the same file and one turn can carry two files of the same name, so the name is not
 * an identity. The index is the one the template's `v-for` is already carrying.
 */
export type AgentHitField = 'text' | 'name' | 'target' | `attach:${number}`

/** One hit: the row that draws it, the string on that row, and the range inside that string. */
export interface AgentHit {
  readonly rowId: number
  readonly field: AgentHitField
  readonly start: number
  readonly end: number
}

/** A range inside one string — what a highlighted span needs and nothing more. */
export interface AgentHitRange {
  readonly start: number
  readonly end: number
}

/** One string of one row, named by the field it is drawn as. */
export interface AgentSearchFieldText {
  readonly field: AgentHitField
  readonly text: string
}

/**
 * The strings of one row a query is answered from, in the row's own drawing order.
 *
 * A row with nothing to draw — a reply that has not arrived yet — contributes nothing, and the
 * empty strings are left out rather than scanned: an empty field can never match a query this
 * module accepts, and leaving them in would only make the offsets below harder to read.
 */
export function searchableFields(row: AgentTimelineEntry): readonly AgentSearchFieldText[] {
  const fields: AgentSearchFieldText[] = []
  const add = (field: AgentHitField, text: string): void => {
    if (text !== '') fields.push({ field, text })
  }
  switch (row.kind) {
    case 'tool':
      // The row draws one of the two: `name` when the engine sent one, the title otherwise
      // (`AgentToolActivity.vue:127`). Searching both would return a hit whose characters appear
      // nowhere on the row.
      add('name', row.name ?? row.title)
      add('target', row.paths.join(', '))
      break
    case 'user':
      add('text', row.text)
      row.attachments.forEach((attachment, index) => add(`attach:${index}`, attachment.name))
      break
    default:
      add('text', row.text)
  }
  return fields
}

/** One string, lower-cased, with a way back to where each folded unit came from. */
interface FoldedText {
  readonly folded: string
  /** The original index each folded unit starts at. */
  readonly starts: readonly number[]
  /** The original index just past each folded unit. */
  readonly ends: readonly number[]
}

/**
 * Fold a string for the containment test, keeping the map back to the original indices.
 *
 * A plain `text.toLowerCase().indexOf(needle)` is the app's other search box
 * (`agent-session-history.ts`'s filter) and it is what the semantics here copy — but it cannot be
 * used for this one, because *this* search reports ranges rather than rows. Lower-casing can
 * change a string's length (`'İ'.toLowerCase()` is two code units), so an index found in the
 * folded copy is not necessarily an index in the original, and a span built from one would cover
 * the wrong characters — or run off the end of the row's own text.
 *
 * The map removes the conflict: the comparison is a containment test on a lower-cased copy, and
 * the range that comes back is the range of original characters that copy was made of. Iteration
 * is by code point, so a surrogate pair is one unit of the map and a hit can never cut one in
 * half.
 */
function fold(text: string): FoldedText {
  let folded = ''
  const starts: number[] = []
  const ends: number[] = []
  let at = 0
  for (const character of text) {
    const lower = character.toLowerCase()
    for (let unit = 0; unit < lower.length; unit += 1) {
      starts.push(at)
      ends.push(at + character.length)
    }
    folded += lower
    at += character.length
  }
  return { folded, starts, ends }
}

/**
 * Every hit of `query` in the rows, in the order the transcript draws them.
 *
 * An empty or whitespace-only query is no query: it answers nothing rather than everything, which
 * is the difference between "the box is empty and no row is narrowed" and "every row is a hit".
 *
 * Occurrences do not overlap — the scan moves past each match — which is what an editor's find
 * does and what makes the count the same whichever way the reader walks it.
 */
export function findConversationHits(
  rows: readonly AgentTimelineEntry[],
  query: string,
): readonly AgentHit[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const hits: AgentHit[] = []
  for (const row of rows) {
    for (const field of searchableFields(row)) {
      const { folded, starts, ends } = fold(field.text)
      let from = 0
      for (;;) {
        const at = folded.indexOf(needle, from)
        // The folded end is the *last* unit's end, so a match that stops inside a character's
        // fold still reports a range that ends where that character does.
        if (at === -1) break
        hits.push({
          rowId: row.id,
          field: field.field,
          start: starts[at],
          end: ends[at + needle.length - 1],
        })
        from = at + needle.length
      }
    }
  }
  return hits
}

/**
 * A hit's identity across a rescan: its row, its field and its range.
 *
 * Nothing else is in it, and that is the point — the engine streams into the last row of a live
 * turn, so the rows are rebuilt on every frame, while a hit recorded before the append is still
 * the same hit afterwards (text is appended *after* it, so its range did not move). Identity is
 * what lets the caller tell "the reader's hit is still there" from "the transcript changed under
 * them", and it is the whole of what keeps a live conversation from moving a reader who is
 * looking at a hit.
 */
export function hitKey(hit: AgentHit): string {
  return `${hit.rowId}:${hit.field}:${hit.start}:${hit.end}`
}

/**
 * Which hit the reader is on after a rescan, and whether it is the same one they were on.
 *
 * `preserved` is the half the caller acts on: a preserved hit must not be moved to, because
 * moving to it would be the container fighting a reader who never asked for anything. When the
 * hit is gone — the row was dropped by the timeline's own bound, or the engine rewrote the text
 * it was in — the first hit takes over, and `preserved: false` says that this one is a new
 * position rather than the reader's.
 *
 * No hits at all is `-1`: there is nothing to be on, and the index is not a number the caller
 * should have to guard before using.
 */
export function activeHitIndex(
  hits: readonly AgentHit[],
  previousKey: string | null,
): { index: number; preserved: boolean } {
  if (hits.length === 0) return { index: -1, preserved: false }
  const found = previousKey === null ? -1 : hits.findIndex((hit) => hitKey(hit) === previousKey)
  return found === -1 ? { index: 0, preserved: false } : { index: found, preserved: true }
}

/**
 * The next or previous hit, wrapping at both ends.
 *
 * Zed's arithmetic, kept (`thread_search_bar.rs:602-628`): from the last hit, next is the first;
 * from the first, previous is the last. With no hit selected yet, next starts at the first and
 * previous at the last — which is what makes a single press of either arrow do something.
 */
export function stepHitIndex(index: number, total: number, delta: number): number {
  if (total === 0) return -1
  if (index < 0) return delta < 0 ? total - 1 : 0
  return (index + delta + total) % total
}

/**
 * The ranges one field of one row draws.
 *
 * The renderer asks this per string rather than filtering the whole hit list itself, so the
 * grouping rule lives here with the rest of the offsets — and a caller that passed the wrong
 * field's ranges would paint a hit over characters that never matched.
 */
export function hitsIn(
  hits: readonly AgentHit[],
  rowId: number,
  field: AgentHitField,
): readonly AgentHitRange[] {
  return hits
    .filter((hit) => hit.rowId === rowId && hit.field === field)
    .map((hit) => ({ start: hit.start, end: hit.end }))
}
