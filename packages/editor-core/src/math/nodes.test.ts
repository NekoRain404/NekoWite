import { describe, expect, it } from 'vitest'
import { roundTrip } from '../serialize'
import { mathToMarkdown } from './nodes'

describe('mathToMarkdown', () => {
  it('inline math emits single dollar', () => {
    expect(mathToMarkdown('E=mc^2', 'inline')).toBe('$E=mc^2$')
  })
  it('display math emits double dollar block', () => {
    expect(mathToMarkdown('x^2', 'display')).toBe('$$\nx^2\n$$')
  })
})

describe('round-trip math', () => {
  it('preserves inline math', () => {
    const md = 'Energy is $E=mc^2$ and $x_i$ stays math, not emphasis.\n'
    expect(roundTrip(md)).toBe(md)
  })
  it('preserves display math', () => {
    const md = '$$\nx^2 + y^2 = z^2\n$$\n'
    expect(roundTrip(md)).toBe(md)
  })
  it('preserves escaped dollar and plain text', () => {
    const md = 'Cost is \\$5. Not math $5x$.\n'
    expect(roundTrip(md)).toContain('\\$5')
  })
})
