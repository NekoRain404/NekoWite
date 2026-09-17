import { describe, expect, it } from 'vitest'
import { compareDocuments } from '../../../services/diff'
import type { AgentToolContent } from '../../../platform/gateways/agent-contracts'
import {
  DIFF_CONTEXT_LINES,
  diffBlocks,
  diffRows,
  diffView,
  hasUndrawnContent,
  type AgentDiffLineRow,
} from './agent-tool-diff'

/** The `diff` arm of the contract's union, built from the three fields that matter to the rows. */
function diff(block: { path: string; oldText: string | null; newText: string }) {
  return diffView({ type: 'diff', ...block })
}

describe('a proposed edit, as rows', () => {
  it('draws the change and trims the unchanged runs either side of it', () => {
    // A one-line change in a long file. The rows must open on the change rather than on two
    // hundred lines of context — which is the whole reason the fold exists — and the lines that
    // were trimmed must be counted rather than lost.
    const head = Array.from({ length: 40 }, (_, i) => `head ${i + 1}`)
    const tail = Array.from({ length: 40 }, (_, i) => `tail ${i + 1}`)
    const before = [...head, 'old', ...tail].join('\n')
    const after = [...head, 'new', ...tail].join('\n')
    const view = diff({ path: 'a.md', oldText: before, newText: after })

    expect(view.identical).toBe(false)
    expect(view.partial).toBe(false)
    expect(view.statedOldText).toBe(true)
    expect(view.added).toBe(1)
    expect(view.removed).toBe(1)

    const folds = view.rows.filter((row) => row.kind === 'fold')
    // Two runs, one before the change and one after it, and each says how many lines are behind
    // it: 40 lines minus the two kept either side of the change.
    expect(folds.map((row) => (row.kind === 'fold' ? row.count : 0))).toEqual([
      40 - DIFF_CONTEXT_LINES * 2,
      40 - DIFF_CONTEXT_LINES * 2,
    ])
    // And the changed lines are drawn, in order, without a fold between them.
    const changed = view.rows.filter(
      (row): row is AgentDiffLineRow => row.kind === 'line' && row.type !== 'same',
    )
    expect(changed.map((row) => [row.type, row.text])).toEqual([
      ['del', 'old'],
      ['add', 'new'],
    ])
  })

  it('shows a trimmed run when the reader opens it, and shows exactly what it counted', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    const after = `${before}\nextra`
    const block = { type: 'diff' as const, path: 'a.md', oldText: before, newText: after }
    const folded = diffView(block)
    const fold = folded.rows.find((row) => row.kind === 'fold')
    expect(fold).toBeDefined()
    if (fold?.kind !== 'fold') throw new Error('expected a fold')

    const opened = diffView(block, new Set([fold.key]))
    expect(opened.rows.filter((row) => row.kind === 'fold')).toEqual([])
    // The count on the fold was the number of lines it stood in for, so opening it removes that
    // one row and adds exactly that many lines. A fold that said one number and hid another would
    // be a lie in the place where the reader is deciding whether to allow an edit.
    expect(opened.rows.length).toBe(folded.rows.length - 1 + fold.count)
  })

  it('keeps a run the size of the context window whole, rather than folding nothing', () => {
    // Five lines, one change in the middle: the unchanged runs are at the window's edge, and a
    // fold there would cost a row to save a row and put the change behind a control.
    const view = diff({
      path: 'a.md',
      oldText: 'a\nb\nc\nd\ne',
      newText: 'a\nb\nC\nd\ne',
    })
    expect(view.rows.every((row) => row.kind === 'line')).toBe(true)
  })

  it('says the two texts are the same rather than drawing no rows at all', () => {
    // The engine measured in this tree sends exactly this shape when the patch it applied
    // reproduces the file it read (`agent_permission_ipc_test.rs`'s fixture is literally
    // `HELLO` → `HELLO`). An empty row set would read as "nothing to see" about a call that is
    // still asking to touch the file.
    const view = diff({ path: 'a.md', oldText: 'HELLO', newText: 'HELLO' })
    expect(view.identical).toBe(true)
    expect(view.added).toBe(0)
    expect(view.removed).toBe(0)
    // No row is added and none is removed — the rows are the text itself, drawn unchanged, which
    // is what makes the surface's "same on both sides" sentence a statement about the block rather
    // than a substitute for rows it could not compute.
    expect(
      view.rows.every((row) => row.kind === 'line' && row.type === 'same' && row.text === 'HELLO'),
    ).toBe(true)
  })

  it('carries an absent original text as an absence, and still draws the proposed text', () => {
    const view = diff({ path: 'new.md', oldText: null, newText: 'one\ntwo\n' })
    expect(view.statedOldText).toBe(false)
    expect(view.added).toBe(2)
    expect(view.removed).toBe(0)
    expect(view.rows.filter((row) => row.kind === 'line').map((row) => row.type)).toEqual([
      'add',
      'add',
    ])
  })

  it('reports a comparison that stopped at the row cap', () => {
    const long = Array.from({ length: 2_100 }, (_, i) => `line ${i + 1}`).join('\n')
    const view = diff({ path: 'a.md', oldText: long, newText: `${long}\nlast` })
    expect(view.partial).toBe(true)
  })

  it('says a change is past the compared lines rather than reporting no change at all', () => {
    // A change late in a long file: both sides run past the cap, so the rows hold nothing but
    // unchanged lines while the two texts are not the same document. Without this flag a surface
    // would draw `+0 −0` over a call that is asking to change the file.
    const head = Array.from({ length: 2_100 }, (_, i) => `line ${i + 1}`)
    const view = diff({ path: 'a.md', oldText: head.join('\n'), newText: [...head].join('\n') })
    expect(view.identical).toBe(true)
    expect(view.beyond).toBe(false)

    const late = diff({
      path: 'a.md',
      oldText: head.join('\n'),
      newText: [...head.slice(0, 2_050), 'changed', ...head.slice(2_051)].join('\n'),
    })
    expect(late.identical).toBe(false)
    expect(late.partial).toBe(true)
    expect(late.beyond).toBe(true)
    expect(late.added).toBe(0)
    expect(late.removed).toBe(0)
  })

  it('does not call a pair identical on the strength of the rows it capped', () => {
    // The comparison answers identity over the whole texts, which is what `services/diff.ts`
    // provides and what a render must not recompute from `added === 0 && removed === 0`: a
    // difference past the cap is still a difference.
    const head = Array.from({ length: 2_100 }, (_, i) => `line ${i + 1}`)
    const view = diff({
      path: 'a.md',
      oldText: head.join('\n'),
      newText: [...head, 'tail'].join('\n'),
    })
    expect(view.partial).toBe(true)
    expect(view.identical).toBe(false)
  })
})

describe('which blocks a surface may draw', () => {
  const content: AgentToolContent[] = [
    { type: 'unrecognised' },
    { type: 'diff', path: 'a.md', oldText: '', newText: 'x' },
    { type: 'diff', path: 'b.md', oldText: 'y', newText: 'z' },
  ]

  it('finds the diff blocks and nothing else', () => {
    expect(diffBlocks(content).map((block) => block.path)).toEqual(['a.md', 'b.md'])
    expect(diffBlocks([{ type: 'unrecognised' }])).toEqual([])
  })

  it('reports content the engine sent that this version does not draw', () => {
    // The fact a surface needs so that a call whose content was entirely undrawable does not
    // look exactly like a call that produced nothing.
    expect(hasUndrawnContent(content)).toBe(true)
    expect(hasUndrawnContent([{ type: 'diff', path: 'a.md', oldText: '', newText: 'x' }])).toBe(
      false,
    )
    expect(hasUndrawnContent([])).toBe(false)
  })
})

describe('the comparison this module rests on', () => {
  it('agrees with `compareDocuments` about the same pair', () => {
    // Not a re-test of `services/diff.ts`: what is checked is that this module does not re-spell
    // the comparison. The rows it draws are the ones the shared service produced, folded — so a
    // change to that service reaches every surface that draws a diff.
    const oldText = 'a\nb\nc\nd\ne\nf\ng\nh'
    const newText = 'a\nb\nX\nd\ne\nf\ng\nh'
    const shared = compareDocuments(oldText, newText)
    const rows = diffRows(shared.ops, new Set()).filter(
      (row): row is AgentDiffLineRow => row.kind === 'line',
    )
    const drawn = rows.filter((row) => row.type !== 'same')
    expect(drawn.map((row) => [row.type, row.text])).toEqual([
      ['del', 'c'],
      ['add', 'X'],
    ])
  })
})
