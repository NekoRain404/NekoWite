import { describe, expect, it } from 'vitest'
import type { Node } from '@milkdown/prose/model'

import { basicPlugins, createEditor } from '../editor'
import { roundTrip } from '../serialize'

describe('highlight round-trip', () => {
  it('preserves a lone highlight', () => {
    expect(roundTrip('==a==\n')).toBe('==a==\n')
  })
  it('preserves mixed inline text', () => {
    const md = 'En ==a== and ==b==.\n'
    expect(roundTrip(md)).toBe(md)
  })
  it('preserves a leading highlight on a line', () => {
    expect(roundTrip('==a== at start\n')).toBe('==a== at start\n')
  })
  it('does not treat a single == as highlight', () => {
    expect(roundTrip('a == b\n')).toBe('a == b\n')
  })
})

function hasHighlight(doc: Node): boolean {
  let found = false
  doc.descendants((n) => {
    n.marks.forEach((m) => {
      if (m.type.name === 'highlight') found = true
    })
    return true
  })
  return found
}

describe('highlight editor integration', () => {
  it('parses ==text== into a highlight mark and saves it back', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('En ==a== here.')

    expect(hasHighlight(editor.getView().state.doc)).toBe(true)
    expect(await editor.save()).toContain('==a==')
    editor.destroy()
  })

  it('round-trips an isolated highlight through open/save', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('==a==')
    const saved = await editor.save()
    expect(saved).toContain('==a==')
    editor.destroy()
  })

  it('nested ==**x**== is parsed as strong (not a highlight), a documented limitation', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('==**x**==')
    const doc = editor.getView().state.doc
    // The `==` delimiters cannot wrap a strong node across remark's tree split,
    // so no highlight mark is emitted; the inner strong still parses.
    expect(hasHighlight(doc)).toBe(false)
    let strong = false
    doc.descendants((n) => {
      n.marks.forEach((m) => {
        if (m.type.name === 'strong') strong = true
      })
      return true
    })
    expect(strong).toBe(true)
    // The source text round-trips even though the mark nesting is lost.
    expect(await editor.save()).toContain('**x**')
    editor.destroy()
  })
})
