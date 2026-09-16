/**
 * The note's blocks: which lines the renderer takes as one node, and the line ↔
 * block arithmetic over them. Pure — no model, no DOM.
 *
 * The caret needs this because the pane's scroll ratio cannot carry a point in a
 * document (see `document-blocks`), and what it must agree on is the exact line
 * numbering: the numbers the source pane's caret and the outline use, over the
 * WHOLE file, with the frontmatter counted and the fences never split.
 */

import { describe, expect, it } from 'vitest'
import { blockIndexForLine, blockLineFor, blockProgress, parseSourceBlocks } from './document-blocks'

describe('parseSourceBlocks', () => {
  it('reads one block per blank-line-separated run of lines', () => {
    expect(parseSourceBlocks('first paragraph\n\nsecond paragraph\n\nthird paragraph\n')).toEqual([
      { line: 1, endLine: 1 },
      { line: 3, endLine: 3 },
      { line: 5, endLine: 5 },
    ])
  })

  it('takes a multi-line block as one, and lines up to the last of them', () => {
    expect(parseSourceBlocks('one\ntwo\n\nthree\n')).toEqual([
      { line: 1, endLine: 2 },
      { line: 4, endLine: 4 },
    ])
    // No trailing newline: the block still ends on its own last line.
    expect(parseSourceBlocks('one\ntwo\n\nthree')).toEqual([
      { line: 1, endLine: 2 },
      { line: 4, endLine: 4 },
    ])
  })

  it('never splits a fence, however many blank lines are inside it', () => {
    // The renderer takes the fence as ONE node, so a rule that split it here
    // would put every block after it one out.
    expect(parseSourceBlocks('intro\n\n```\n\ncode\n\n```\n\noutro\n')).toEqual([
      { line: 1, endLine: 1 },
      { line: 3, endLine: 7 },
      { line: 9, endLine: 9 },
    ])
  })

  it('does not count the frontmatter as a block, and keeps the file’s own numbering', () => {
    // The model is given the BODY only — `editor-core`'s `open()` parses
    // `readDocumentEnvelope(content).body` — so the frontmatter has no node to
    // pair with. Its lines still count towards the line numbers, because that is
    // the numbering the source pane's caret is on.
    expect(parseSourceBlocks('---\ntitle: a\n---\n\nfirst\n\nsecond\n')).toEqual([
      { line: 5, endLine: 5 },
      { line: 7, endLine: 7 },
    ])
  })

  it('answers with nothing for a note that has no blocks', () => {
    expect(parseSourceBlocks('')).toEqual([])
    expect(parseSourceBlocks('\n\n')).toEqual([])
    expect(parseSourceBlocks('---\ntitle: a\n---\n')).toEqual([])
  })

  it('reports the source as it is, even where the model will disagree', () => {
    // A loose list is ONE list node in the model and two runs of lines here, and
    // this function does not guess: the caller pairs by index and refuses when
    // the counts differ, so a construct this rule does not know about costs the
    // fallback rather than the wrong paragraph.
    expect(parseSourceBlocks('- a\n\n- b\n')).toEqual([
      { line: 1, endLine: 1 },
      { line: 3, endLine: 3 },
    ])
  })
})

describe('blockIndexForLine', () => {
  const blocks = parseSourceBlocks('one\n\ntwo\n\nthree\n')

  it('names the block a line is in', () => {
    expect(blockIndexForLine(blocks, 1)).toBe(0)
    expect(blockIndexForLine(blocks, 3)).toBe(1)
    expect(blockIndexForLine(blocks, 5)).toBe(2)
  })

  it('gives the blank lines below a block to that block', () => {
    // A caret on the blank line under `two` is nearest to `two`, which is the
    // rule `anchorHeadingIndex` reads the same question by.
    expect(blockIndexForLine(blocks, 4)).toBe(1)
    expect(blockIndexForLine(blocks, 6)).toBe(2)
  })

  it('gives a line above the first block to the first block', () => {
    expect(blockIndexForLine(parseSourceBlocks('\n\none\n'), 1)).toBe(0)
  })

  it('answers null when the note has no blocks at all', () => {
    expect(blockIndexForLine([], 3)).toBeNull()
  })

  it('floors a fractional line', () => {
    expect(blockIndexForLine(blocks, 3.9)).toBe(1)
  })
})

describe('blockProgress and blockLineFor', () => {
  const blocks = parseSourceBlocks('one\ntwo\nthree\n\nfour\n')

  it('measures a line’s way through the block it is in', () => {
    expect(blockProgress(blocks, 0, 1)).toBe(0)
    expect(blockProgress(blocks, 0, 2)).toBe(0.5)
    expect(blockProgress(blocks, 0, 3)).toBe(1)
  })

  it('answers 0 for a one-line block', () => {
    // A caret on a paragraph's only line is at the paragraph’s own start, not at
    // some fraction of itself.
    expect(blockProgress(blocks, 1, 5)).toBe(0)
    expect(blockLineFor(blocks, 1, 0.7)).toBe(5)
  })

  it('is the inverse of itself, fractions included', () => {
    for (const line of [1, 1.5, 2, 2.25, 3]) {
      const progress = blockProgress(blocks, 0, line)
      expect(blockLineFor(blocks, 0, progress), `line ${line}`).toBeCloseTo(line, 9)
    }
  })

  it('clamps a progress outside the block, and refuses a block that is not there', () => {
    expect(blockLineFor(blocks, 0, -1)).toBe(1)
    expect(blockLineFor(blocks, 0, 4)).toBe(3)
    expect(blockLineFor(blocks, 9, 0.5)).toBeNull()
    expect(blockProgress(blocks, 9, 2)).toBe(0)
  })
})
