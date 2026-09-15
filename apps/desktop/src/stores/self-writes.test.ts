import { describe, expect, it } from 'vitest'
import { createSelfWrites, SELF_WRITE_MS } from './self-writes'

/** A hand-cranked clock, so a claim's whole lifetime is exercised without
 *  waiting for it. */
function harness() {
  let clock = 1_000_000
  return {
    writes: createSelfWrites(() => clock),
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('self-write claims', () => {
  it('holds a named claim for as long as the write runs, however long that is', () => {
    const h = harness()
    h.writes.note('/vault/a.md', 'new text')

    // Ten times the old window: a write that outlives any fixed duration is
    // exactly the case the clock got wrong.
    h.advance(SELF_WRITE_MS * 10)

    expect(h.writes.isSelfWrite('/vault/a.md', 'new text')).toBe(true)
  })

  it('does not claim an external edit that lands while our write is in flight', () => {
    const h = harness()
    h.writes.note('/vault/a.md', 'our text')
    // Somebody else wrote the file while we were writing it. Different bytes
    // are somebody else's edit, and the claim must not swallow it — the old
    // window suppressed everything on that path, this one does not.
    expect(h.writes.isSelfWrite('/vault/a.md', 'their text')).toBe(false)
  })

  it('releases the claim when the write settles, so a later edit is reported', () => {
    const h = harness()
    h.writes.note('/vault/a.md', 'our text')
    h.writes.settle('/vault/a.md')
    expect(h.writes.isSelfWrite('/vault/a.md', 'our text')).toBe(false)
    expect(h.writes.isSelfWrite('/vault/a.md', 'their text')).toBe(false)
  })

  it('treats an unreadable path as ours while a named write is in flight', () => {
    const h = harness()
    // Our own delete: the watcher reports the path and there is nothing left
    // to read, so there are no bytes to compare.
    h.writes.note('/vault/a.md', 'our text')
    expect(h.writes.isSelfWrite('/vault/a.md', null)).toBe(true)
  })

  it('keeps the timed claim for an operation with no bytes to name', () => {
    const h = harness()
    h.writes.note('/vault/a.md') // a rename, a delete
    expect(h.writes.isSelfWrite('/vault/a.md', 'anything')).toBe(true)
    h.advance(SELF_WRITE_MS + 1)
    expect(h.writes.isSelfWrite('/vault/a.md', 'anything')).toBe(false)
  })

  it('answers no for a path nothing has claimed', () => {
    const h = harness()
    expect(h.writes.isSelfWrite('/vault/a.md', 'text')).toBe(false)
  })

  it('drops every claim on clear', () => {
    const h = harness()
    h.writes.note('/vault/a.md', 'ours')
    h.writes.note('/vault/b.md')
    h.writes.clear()
    expect(h.writes.isSelfWrite('/vault/a.md', 'ours')).toBe(false)
    expect(h.writes.isSelfWrite('/vault/b.md')).toBe(false)
  })
})
