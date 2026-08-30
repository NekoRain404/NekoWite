import { describe, expect, it } from 'vitest'
import type { Node } from '@milkdown/prose/model'
import { basicPlugins, createEditor } from '../editor'
import { roundTrip } from '../serialize'
import { citeToMarkdown } from './node'

describe('citeToMarkdown', () => {
  it('renders pandoc-style citation', () => {
    expect(citeToMarkdown('smith2020')).toBe('[@smith2020]')
  })
})

describe('round-trip citations', () => {
  it('preserves a lone citation', () => {
    const md = 'See [@smith2020].\n'
    expect(roundTrip(md)).toBe(md)
  })
  it('preserves mixed inline text', () => {
    const md = 'See [@a] and [@b], plus [@a] again.\n'
    expect(roundTrip(md)).toBe(md)
  })
  it('does not treat plain text as citation', () => {
    const md = 'Emails go to [@ support] and brackets [not a cite].\n'
    expect(roundTrip(md)).toBe(md)
  })
})

function findCite(doc: Node, key?: string): Node | null {
  let found: Node | null = null
  doc.descendants((n) => {
    if (n.type.name === 'cite' && (key === undefined || n.attrs.key === key)) {
      found = n
      return false
    }
    return true
  })
  return found
}

describe('cite editor integration', () => {
  it('parses [@key] into a cite node with attrs.key', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('See [@smith2020].')

    const node = findCite(editor.getView().state.doc, 'smith2020')
    expect(node).not.toBeNull()
    expect(node!.attrs.key).toBe('smith2020')

    expect(await editor.save()).toContain('[@smith2020]')
  })
})
