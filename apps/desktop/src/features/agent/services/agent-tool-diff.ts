/**
 * A proposed edit, turned into rows a 400px column can draw — and into the facts a reader needs
 * to know about what those rows are.
 *
 * The input is one `diff` block from the contract (`AgentToolContent`): the file's path, the text
 * the engine says it started from, and the text it proposes to leave behind. The output is the
 * row list plus the things a render must not silently substitute for it — whether the engine
 * stated an original text at all, whether the two texts are the same document, and whether the
 * rows cover the whole of it.
 *
 * ## Why the diff is recomputed here
 *
 * ACP carries no hunks: its `Diff` is "the original content" and "the new content after
 * modification" (`agent-client-protocol-schema` 1.7.0, `src/v1/tool_call.rs:700-720`), so the
 * change is derived rather than received. That is also the shape the reference client uses — Zed
 * runs its own buffer diff over the same two strings (`acp_thread/src/diff.rs:384-405`) — and it
 * is the reason a surface can show the change at all: the block is the whole proposal, not a
 * summary of one.
 *
 * ## What it refuses to decide
 *
 * `oldText === null` means "the engine stated no original text", and this module carries that
 * fact rather than a conclusion. The schema glosses the case as "None for new files", but the
 * field deserializes with `x-deserialize-default-on-error`, so original text that failed to
 * deserialize arrives as `null` too — "this is a new file" and "this host could not read the
 * original" are one value by the time a typed frame exists (see `AgentToolContent`). So the rows
 * are computed against an empty baseline (which is what a file with no original text is) and
 * {@link AgentDiffView.statedOldText} travels beside them, for the surface to say what it knows
 * instead of claiming a new file.
 *
 * ## Why the rows are folded rather than capped
 *
 * A one-line change to a long file would otherwise open with two thousand unchanged lines and put
 * the change past the fold, which is the one arrangement where a diff is worse than no diff. So
 * unchanged runs are trimmed to {@link DIFF_CONTEXT_LINES} a side and the count of the lines
 * dropped is carried in a row of its own — visible, counted, and one click away from being shown
 * again — which is the same trade the reference client makes at its own source
 * (`acp_thread/src/diff.rs:337-373`, hunks plus two context lines).
 *
 * The cap on the underlying comparison is `services/diff.ts`'s and is reported rather than
 * absorbed: see {@link AgentDiffView.partial}.
 */

import type { AgentToolContent } from '../../../platform/gateways/agent-contracts'
import { compareDocuments, type DiffLine } from '../../../services/diff'

/** The `diff` arm of the contract's content union, named so a caller can ask for it. */
export type AgentDiffBlock = Extract<AgentToolContent, { type: 'diff' }>

/** Unchanged lines kept either side of a change. Two, the reference client's own default
 *  (`multi_buffer/src/multi_buffer.rs:67-69`): enough to place the change in its surroundings,
 *  little enough that the column is spent on the change itself. */
export const DIFF_CONTEXT_LINES = 2

/** One line of the comparison, as a row. */
export interface AgentDiffLineRow {
  kind: 'line'
  type: DiffLine['type']
  text: string
  /** 1-based line number in the original text, `null` for an added line. */
  oldLine: number | null
  /** 1-based line number in the proposed text, `null` for a removed line. */
  newLine: number | null
}

/**
 * Unchanged lines that were trimmed away, as a row of their own.
 *
 * `key` is the index of the first trimmed line in the comparison, which is what makes one fold
 * distinguishable from another when a surface remembers which ones are open. `count` is exactly
 * how many lines are behind it, so a reader is never asked to take "some lines" on trust.
 */
export interface AgentDiffFoldRow {
  kind: 'fold'
  key: number
  count: number
  /** The line number the run starts at in the original text — what the fold stands in for. */
  from: number
}

export type AgentDiffRow = AgentDiffLineRow | AgentDiffFoldRow

/** What one `diff` block is, for a surface that draws it. */
export interface AgentDiffView {
  /** The engine's own path, verbatim — possibly blank, in which case a surface draws no path. */
  path: string
  /** Whether the engine stated an original text. False is an absence, never "a new file". */
  statedOldText: boolean
  /**
   * Whether the two texts are the same document, answered over the whole of both rather than over
   * the rows — `services/diff.ts` compares line sequences for this, so a difference past the row
   * cap is still reported as one. A surface must not read it off "no added and no removed rows",
   * which is what made a long document's tail invisible once already.
   */
  identical: boolean
  /**
   * Whether the rows cover only a prefix of the comparison, because a side ran past
   * `services/diff.ts`'s row cap. A surface that draws the rows must say so: an empty or short row
   * set otherwise reads as a complete answer.
   */
  partial: boolean
  /**
   * Whether the two sides differ *past* the rows — the case where the comparison stopped at the
   * cap and no change appears in what it compared.
   *
   * Not a sub-case worth a flag for tidiness: it is the ordinary shape of a change late in a long
   * file (a 3,000-line file edited at line 2,500 compares its first 2,000 lines, which are all
   * unchanged), and a surface that drew its rows without saying this would be showing a card whose
   * counts read `+0 −0` over a call that is asking to change the file. That is the softening this
   * whole module exists to refuse.
   *
   * It implies {@link partial}: over the whole of both texts an unequal pair has a difference
   * somewhere, so a row set with no added and no removed line can only be missing the part that
   * holds it, and a row set is only ever missing anything when the cap was hit.
   */
  beyond: boolean
  added: number
  removed: number
  rows: readonly AgentDiffRow[]
}

/**
 * The comparison, folded.
 *
 * `unfolded` names the folds the reader has opened, by {@link AgentDiffFoldRow.key}. It defaults
 * to none, because the initial state of a proposed edit is the change itself.
 */
export function diffRows(
  ops: readonly DiffLine[],
  unfolded: ReadonlySet<number>,
): AgentDiffRow[] {
  const rows: AgentDiffRow[] = []
  let index = 0
  while (index < ops.length) {
    const line = ops[index]
    if (line.type !== 'same') {
      rows.push(lineRow(line))
      index += 1
      continue
    }
    // A maximal run of unchanged lines, and what to do with it. A run inside the context window
    // is drawn whole: folding it would cost a row to save a row and hide the change behind a
    // control, which is the wrong way round.
    let end = index
    while (end < ops.length && ops[end].type === 'same') end += 1
    const length = end - index
    if (length <= DIFF_CONTEXT_LINES * 2 || unfolded.has(index)) {
      for (let at = index; at < end; at += 1) rows.push(lineRow(ops[at]))
    } else {
      for (let at = index; at < index + DIFF_CONTEXT_LINES; at += 1) rows.push(lineRow(ops[at]))
      rows.push({
        kind: 'fold',
        key: index,
        count: length - DIFF_CONTEXT_LINES * 2,
        from: ops[index + DIFF_CONTEXT_LINES].oldLine ?? 0,
      })
      for (let at = end - DIFF_CONTEXT_LINES; at < end; at += 1) rows.push(lineRow(ops[at]))
    }
    index = end
  }
  return rows
}

function lineRow(line: DiffLine): AgentDiffLineRow {
  return {
    kind: 'line',
    type: line.type,
    text: line.text,
    oldLine: line.oldLine,
    newLine: line.newLine,
  }
}

/**
 * One block, ready to draw — with `unfolded` applied.
 *
 * `oldText` is read as the empty string when the engine stated none: that is what a comparison
 * against a file with no original text is, and the alternative — refusing to compute rows — would
 * make the one case the schema names ("a new file") the one case with nothing to show. The
 * absence itself travels in {@link AgentDiffView.statedOldText} so the surface can say so.
 */
export function diffView(
  block: AgentDiffBlock,
  unfolded: ReadonlySet<number> = new Set(),
): AgentDiffView {
  const comparison = compareDocuments(block.oldText ?? '', block.newText)
  const partial = comparison.truncated && !comparison.identical
  return {
    path: block.path,
    statedOldText: block.oldText !== null,
    identical: comparison.identical,
    partial,
    beyond: partial && comparison.stats.added + comparison.stats.removed === 0,
    added: comparison.stats.added,
    removed: comparison.stats.removed,
    rows: diffRows(comparison.ops, unfolded),
  }
}

/** The `diff` blocks of a call's content, in the engine's order. Empty when it reported none —
 *  which is the ordinary case for every call that is not an edit, and the reason a surface gates
 *  the whole view on this rather than drawing an empty one. */
export function diffBlocks(content: readonly AgentToolContent[]): AgentDiffBlock[] {
  return content.filter((block): block is AgentDiffBlock => block.type === 'diff')
}

/** Whether the call reported any block this version does not draw. The complement of
 *  {@link diffBlocks} over the content the engine sent — a fact a surface can state rather than
 *  leave as a silence that reads like an empty result. */
export function hasUndrawnContent(content: readonly AgentToolContent[]): boolean {
  return content.some((block) => block.type === 'unrecognised')
}
