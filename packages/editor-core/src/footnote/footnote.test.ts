import { describe, expect, it } from 'vitest'

import { basicPlugins, createEditor } from '../editor'
import { roundTrip } from '../serialize'

describe('footnote round-trip', () => {
  it('preserves a lone footnote reference and its definition', () => {
    const md = 'Text[^1]\n\n[^1]: the note\n'
    expect(roundTrip(md)).toBe(md)
  })
  it('preserves a footnote reference in prose', () => {
    const md = 'Text [^1] here.\n\n[^1]: the note\n'
    expect(roundTrip(md)).toBe(md)
  })
  it('preserves multiple footnote definitions', () => {
    const md = 'A[^a] and B[^b].\n\n[^a]: note a\n\n[^b]: note b\n'
    expect(roundTrip(md)).toBe(md)
  })

  it('open/save keeps the footnote source byte-faithfully', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    const md = 'Text[^1] and [^2].\n\n[^1]: first note\n\n[^2]: second note\n'
    await editor.open(md)
    expect(await editor.save()).toBe(md)
    editor.destroy()
  })
})
