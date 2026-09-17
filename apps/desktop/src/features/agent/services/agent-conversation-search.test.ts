/**
 * What a query over the open conversation is allowed to match, and where each hit sits.
 *
 * This is the rule half of the transcript's find box — the half a unit test can hold cheaply
 * and in every run. The browser half (does the reader reach it, does the container move to the
 * hit) is the WebKit probe's; what is asserted here is the set of strings the answer is built
 * from, because every wrong version of that set is a claim about the session the reader cannot
 * check.
 */
import { describe, expect, it } from 'vitest'
import {
  activeHitIndex,
  findConversationHits,
  hitKey,
  hitsIn,
  searchableFields,
  stepHitIndex,
  type AgentHit,
} from './agent-conversation-search'
import type { AgentTimelineEntry } from './agent-timeline'

const user = (id: number, text: string, attachments: readonly string[] = []): AgentTimelineEntry => ({
  kind: 'user',
  id,
  runId: null,
  text,
  origin: 'host',
  attachments: attachments.map((name) => ({ kind: 'resource', name })),
})

const reply = (id: number, text: string): AgentTimelineEntry => ({
  kind: 'text',
  id,
  runId: 'run-1',
  text,
})

const thought = (id: number, text: string): AgentTimelineEntry => ({
  kind: 'thought',
  id,
  runId: 'run-1',
  text,
})

const tool = (
  id: number,
  fields: {
    title?: string
    name?: string
    paths?: string[]
    input?: string
    output?: string
  } = {},
): AgentTimelineEntry => ({
  kind: 'tool',
  id,
  runId: 'run-1',
  toolCallId: `call-${id}`,
  title: fields.title ?? 'Read notes/a.md',
  name: fields.name,
  toolKind: 'read',
  status: 'completed',
  paths: fields.paths ?? ['notes/a.md'],
  content: [],
  input: fields.input === undefined ? { state: 'absent' } : { state: 'text', json: fields.input },
  output: fields.output === undefined ? { state: 'absent' } : { state: 'text', json: fields.output },
})

/** The text each hit covers, in the order the hits were found — the reading every offset
 *  assertion below is really about. */
function coveredText(rows: readonly AgentTimelineEntry[], query: string): string[] {
  return findConversationHits(rows, query).map((hit) => {
    const field = searchableFields(rows.find((row) => row.id === hit.rowId)!).find(
      (candidate) => candidate.field === hit.field,
    )
    return field === undefined ? '<no such field>' : field.text.slice(hit.start, hit.end)
  })
}

describe('what a query over the conversation matches', () => {
  const rows: readonly AgentTimelineEntry[] = [
    user(1, 'Summarise the reading list'),
    thought(2, 'The reader wants the reading list summarised.'),
    reply(3, 'Here is the summary.'),
    tool(4, { title: 'Read notes/2026-09/plan.md', paths: ['notes/2026-09/plan.md'] }),
  ]

  it('matches the words of every row the transcript draws', () => {
    // The four kinds, each on its own row: this is the whole set the answer is built from, and
    // the failure it is written against is a search that reaches one kind and not the others —
    // the reader's own turns, the answer, the reasoning, and what a tool call touched.
    expect(coveredText(rows, 'reading list')).toEqual(['reading list', 'reading list'])
    // Three rows, and the hit covers the row's own characters: the reader's capitalised turn is
    // reported as it was written, not as the case-folded copy the comparison ran on.
    expect(coveredText(rows, 'summar')).toEqual(['Summar', 'summar', 'summar'])
    // The tool row twice: the engine's title names the file and the path beside it names it
    // again, and both strings are on the row.
    expect(coveredText(rows, '2026-09')).toEqual(['2026-09', '2026-09'])
  })

  it('counts every occurrence on one row, in order', () => {
    // A find box counts hits, not rows: two occurrences of the same word in one answer are two
    // stops for the reader, and a row-count would send them to the same place twice.
    const hits = findConversationHits([reply(1, 'alpha beta alpha')], 'alpha')
    expect(hits.map((hit) => [hit.start, hit.end])).toEqual([
      [0, 5],
      [11, 16],
    ])
  })

  it('ignores case, and folds the way the app’s other search box folds', () => {
    // The same semantics as `filterSessionRows` — a lower-case containment test — and NOT the
    // engine's own `i` flag, which disagrees with it on a handful of code points (`K` U+212A is
    // one: a reader who types "kelvin" finds it in the history list, so they have to find it
    // here). The two search boxes in this app agreeing is worth more than either folding rule.
    const rows = [reply(1, 'The Kelvin sign and KELVIN')]
    expect(coveredText(rows, 'kelvin')).toEqual(['Kelvin', 'KELVIN'])
  })

  it('reports a range inside the text even where folding changes its length', () => {
    // `İ` (U+0130) lower-cases to two code units, so the obvious implementation — scan
    // `text.toLowerCase()` and use the index found there — reports an end one past the real one
    // and paints a span that runs off the end of the row's own text. The query is built from
    // `toLowerCase()` rather than typed with an invisible combining mark in this file, but it is
    // the query a paste of the folded word produces.
    const text = 'İstanbul plan'
    const folded = 'İstanbul'.toLowerCase()
    expect(folded.length).toBe(8 + 1)

    const hits = findConversationHits([reply(1, text)], folded)
    expect(hits.map((hit) => text.slice(hit.start, hit.end))).toEqual(['İstanbul'])
    expect(hits[0].end).toBeLessThanOrEqual(text.length)
  })

  it('is a plain containment test, so a query with punctuation in it is not a pattern', () => {
    // The reader types what they are looking for, not a pattern: `(plan` has to match the
    // literal text, which a regex build from the raw query would refuse as a syntax error.
    expect(coveredText([reply(1, 'see (plan) above')], '(plan')).toEqual(['(plan'])
    expect(coveredText([reply(1, 'a.c')], '.')).toEqual(['.'])
  })

  it('treats an empty or whitespace-only query as no query at all', () => {
    // An emptied field must not narrow anything — the same rule `filterSessionRows` keeps for
    // the history list — and a single space must not match every space in the transcript.
    expect(findConversationHits(rows, '')).toEqual([])
    expect(findConversationHits(rows, '   ')).toEqual([])
  })

  it('matches nothing this app wrote onto a row', () => {
    // The status word, the disclosure labels and the sentences this app draws around the
    // engine's facts are the app's words, not the session's: a reader who typed "Done" is
    // looking for their own word or the engine's, and a hit on a word the engine never sent is
    // a hit the row cannot explain.
    expect(coveredText(rows, 'Done')).toEqual([])
    expect(coveredText(rows, 'Show the reasoning')).toEqual([])
    expect(coveredText(rows, 'You')).toEqual([])
  })

  it('does not reach into a tool call’s arguments, output or proposed change', () => {
    // Those blocks are drawn inside their own scroll boxes, and the change is folded by its own
    // disclosure: the transcript's own scroll cannot bring a hit there into view, and a count
    // that includes hits the reader cannot be taken to is the count that lies. The call's own
    // header — the engine's title, name and paths — is searched, because that IS on the row.
    const rows = [
      tool(1, {
        title: 'Edit notes/a.md',
        input: '{"needle": "in the arguments"}',
        output: 'the needle in the output',
      }),
    ]
    expect(coveredText(rows, 'needle')).toEqual([])
    expect(coveredText(rows, 'Edit notes/a.md')).toEqual(['Edit notes/a.md'])
  })

  it('searches the tool call’s drawn name, not the title it replaced', () => {
    // The row draws `name ?? title` — one string on screen. Searching the other one would return
    // a hit whose characters appear nowhere on the row.
    const named = [tool(1, { name: 'str_replace', title: 'Edit notes/a.md' })]
    expect(coveredText(named, 'str_replace')).toEqual(['str_replace'])
    expect(coveredText(named, 'Edit notes/a.md')).toEqual([])
  })

  it('searches the names of the files a turn carried', () => {
    // The attachment list is drawn on the reader's own row, so a query that matches one of those
    // names is a hit the row shows. The field is the entry's index: two turns can carry the same
    // file, and two attachments of one turn can share a name.
    const rows = [user(1, 'what is this?', ['diagram.png', 'notes/a.md'])]
    const hits = findConversationHits(rows, 'diagram')
    expect(hits.map((hit) => hit.field)).toEqual(['attach:0'])
    expect(hitsIn(hits, 1, 'attach:0')).toEqual([{ start: 0, end: 7 }])
  })

  it('reports a hit’s row and field so the row that draws it can be found', () => {
    const hits = findConversationHits([user(1, 'hello'), reply(7, 'hello again')], 'hello')
    expect(hits.map((hit) => [hit.rowId, hit.field])).toEqual([
      [1, 'text'],
      [7, 'text'],
    ])
  })
})

describe('a hit’s identity, and the index the reader is on', () => {
  const hit = (rowId: number, start: number, end: number): AgentHit => ({
    rowId,
    field: 'text',
    start,
    end,
  })

  it('is the row, the field and the range — nothing else', () => {
    expect(hitKey(hit(3, 4, 9))).toBe(hitKey(hit(3, 4, 9)))
    expect(hitKey(hit(3, 4, 9))).not.toBe(hitKey(hit(3, 4, 10)))
    expect(hitKey(hit(3, 4, 9))).not.toBe(hitKey(hit(4, 4, 9)))
    expect(hitKey(hit(3, 4, 9))).not.toBe(hitKey(hit(3, 0, 4)))
  })

  it('keeps the reader on the same hit when more content arrives', () => {
    // The engine streams into the last row of a live turn, so a rescan happens per frame. A hit
    // recorded before the append is still the same hit afterwards — its row and its range did not
    // move — and saying so is what lets the caller leave the container alone.
    const before = [hit(1, 0, 4), hit(1, 20, 24)]
    const after = [hit(1, 0, 4), hit(1, 20, 24), hit(2, 5, 9)]
    const index = activeHitIndex(after, hitKey(before[1]))
    expect(index).toEqual({ index: 1, preserved: true })
  })

  it('falls back to the first hit when the one the reader was on is gone', () => {
    const index = activeHitIndex([hit(1, 0, 4)], hitKey(hit(9, 0, 4)))
    expect(index).toEqual({ index: 0, preserved: false })
  })

  it('has no index when there is nothing to be on', () => {
    expect(activeHitIndex([], hitKey(hit(1, 0, 4)))).toEqual({ index: -1, preserved: false })
  })

  it('steps forward and back, and wraps at both ends', () => {
    // Zed's arithmetic, kept: next from the last hit is the first, and prev from the first is the
    // last — and with no hit yet selected, next starts at the first and prev at the last.
    expect(stepHitIndex(0, 3, 1)).toBe(1)
    expect(stepHitIndex(2, 3, 1)).toBe(0)
    expect(stepHitIndex(0, 3, -1)).toBe(2)
    expect(stepHitIndex(-1, 3, 1)).toBe(0)
    expect(stepHitIndex(-1, 3, -1)).toBe(2)
    expect(stepHitIndex(0, 0, 1)).toBe(-1)
  })
})

describe('the ranges one field of one row draws', () => {
  it('gives back only that field’s hits, and only that row’s', () => {
    const hits = findConversationHits(
      [user(1, 'one one', ['one.png']), reply(2, 'one')],
      'one',
    )
    expect(hitsIn(hits, 1, 'text')).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ])
    expect(hitsIn(hits, 1, 'attach:0')).toEqual([{ start: 0, end: 3 }])
    expect(hitsIn(hits, 2, 'text')).toEqual([{ start: 0, end: 3 }])
    expect(hitsIn(hits, 2, 'name')).toEqual([])
  })
})
