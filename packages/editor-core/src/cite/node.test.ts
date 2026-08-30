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

  it('parses a lone citation on its own line into a cite node', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('[@a]\n')

    const node = findCite(editor.getView().state.doc, 'a')
    expect(node).not.toBeNull()
    expect(await editor.save()).toContain('[@a]')
  })

  it('parses a citation wrapped in emphasis into a cite node', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('*[@a]*')

    const node = findCite(editor.getView().state.doc, 'a')
    expect(node).not.toBeNull()
  })

  it('round-trips a lone citation byte-faithfully', () => {
    expect(roundTrip('[@a]\n')).toBe('[@a]\n')
    expect(roundTrip('*[@a]*\n')).toBe('*[@a]*\n')
  })

  it('keeps an escaped \\[@foo] as literal text without creating a cite node', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('literal \\[@foo] here.')
    const doc = editor.getView().state.doc
    let cites = 0
    doc.descendants((n) => {
      if (n.type.name === 'cite') cites++
      return true
    })
    expect(cites).toBe(0)
    expect(doc.textContent).toContain('[@foo]')
    editor.destroy()
  })

  it('keeps an escaped \\[@foo] literal while still parsing unescaped cites around it', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('See [@a] and \\[@b] and [@c].')
    const doc = editor.getView().state.doc
    const keys: string[] = []
    doc.descendants((n) => {
      if (n.type.name === 'cite') keys.push(String(n.attrs.key))
      return true
    })
    expect(keys).toEqual(['a', 'c'])
    expect(doc.textContent).toContain('[@b]')
    editor.destroy()
  })
})
