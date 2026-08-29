import { describe, expect, it } from 'vitest'
import { roundTrip } from './serialize'

describe('roundTrip', () => {
  it('preserves headings, emphasis, lists', () => {
    const md = '# Title\n\nSome **bold** and *italic*.\n\n- a\n- b\n'
    expect(roundTrip(md)).toBe(md)
  })
  it('preserves gfm tables', () => {
    const md = '| a | b |\n| - | - |\n| 1 | 2 |\n'
    expect(roundTrip(md)).toBe(md)
  })
  it('preserves yaml frontmatter', () => {
    const md = '---\ntitle: hello\n---\n\n# Body\n'
    expect(roundTrip(md)).toBe(md)
  })
})