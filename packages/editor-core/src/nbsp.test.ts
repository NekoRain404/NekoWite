import { describe, expect, it } from 'vitest'
import { normalizeNbsp, roundTrip } from './serialize'
import { createEditor } from './editor'

async function openAndSave(markdown: string): Promise<string> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, {
    plugins: await import('./plugins/basic').then((m) => m.basicPlugins),
  })
  await editor.open(markdown)
  const out = await editor.save()
  editor.destroy()
  return out
}

describe('normalizeNbsp', () => {
  it('replaces non-breaking spaces with ordinary ones', () => {
    expect(normalizeNbsp('a\u00a0b')).toBe('a b')
    expect(normalizeNbsp('a\u00a0\u00a0b')).toBe('a  b')
  })

  it('leaves text without one untouched', () => {
    const text = 'plain  text\n\nwith lines'
    expect(normalizeNbsp(text)).toBe(text)
  })

  it('handles an empty string', () => {
    expect(normalizeNbsp('')).toBe('')
  })

  it('does not disturb other whitespace', () => {
    expect(normalizeNbsp('a\tb\nc')).toBe('a\tb\nc')
  })
})

describe('roundTripping keeps non-breaking spaces out of the file', () => {
  it('saves a U+00A0 in the input as an ordinary space', async () => {
    // A browser inserts U+00A0 for a space typed at the end of a text run, so
    // the model can hold one even though the user typed a normal space.
    const out = await openAndSave('alpha\u00a0tail\n')
    expect(out).not.toContain('\u00a0')
    expect(out).toBe('alpha tail\n')
  })

  it('preserves ordinary double spaces verbatim', async () => {
    // The app deliberately does not collapse runs of spaces.
    const out = await openAndSave('alpha  tail\n')
    expect(out).toBe('alpha  tail\n')
  })

  it('round-trips a document with no non-breaking space unchanged', () => {
    const md = '# Title\n\nbody text\n'
    expect(roundTrip(md)).toBe(md)
  })
})
