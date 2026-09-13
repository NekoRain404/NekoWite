import { afterEach, describe, expect, it } from 'vitest'
import { createEditor, basicPlugins } from '../editor'
import { CITE_MISSING_CLASS, computeCiteOrder, setCiteKeyResolver } from './views'

afterEach(() => {
  // The resolver is module state that the host app owns; a test that sets it
  // must hand the module back unchanged.
  setCiteKeyResolver(null)
})

describe('computeCiteOrder', () => {
  it('numbers by first-appearance order with dedup', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('See [@a], then [@b], then [@a] again.')
    await new Promise((r) => setTimeout(r, 0))
    const order = computeCiteOrder(editor.getView())
    expect(order.get('a')).toBe(1)
    expect(order.get('b')).toBe(2)
    editor.destroy()
  })

  it('renders a cite chip with data-cite-key per cite node', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('Reference [@key1].')
    await new Promise((r) => setTimeout(r, 0))
    const dom = editor.getView().dom
    const chips = dom.querySelectorAll('span.cite-chip[data-cite-key="key1"]')
    expect(chips.length).toBe(1)
    expect(chips[0].textContent).toBe('[1]')
    editor.destroy()
  })

  it('re-renders chip numbers when a cite is inserted before existing cites', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('See [@a] and [@b].')
    await new Promise((r) => setTimeout(r, 0))
    const view = editor.getView()

    const citeC = view.state.schema.nodes.cite.create({ key: 'c' })
    view.dispatch(view.state.tr.replaceWith(1, 1, citeC))
    await new Promise((r) => setTimeout(r, 0))

    const order = computeCiteOrder(view)
    expect(order.get('c')).toBe(1)
    expect(order.get('a')).toBe(2)
    expect(order.get('b')).toBe(3)

    const byKey = new Map<string, string>()
    view.dom.querySelectorAll('span.cite-chip').forEach((chip) => {
      const k = (chip as HTMLElement).dataset.citeKey
      if (k) byKey.set(k, chip.textContent ?? '')
    })
    expect(byKey.get('c')).toBe('[1]')
    expect(byKey.get('a')).toBe('[2]')
    expect(byKey.get('b')).toBe('[3]')
    editor.destroy()
  })
})

describe('unresolved citations', () => {
  it('marks a chip whose key is not in the library and keeps it out of the numbering', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    setCiteKeyResolver((key) => key !== 'ghost')
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('See [@ghost] and [@real] and [@ghost] again.')
    await new Promise((r) => setTimeout(r, 0))
    const view = editor.getView()
    const chips = [...view.dom.querySelectorAll('span.cite-chip')] as HTMLElement[]
    const text = chips.map((c) => c.textContent)
    // A missing key used to render as a numbered reference, so the reader could
    // not tell it pointed at nothing.
    expect(text).toEqual(['[?]', '[1]', '[?]'])
    const ghost = chips.find((c) => c.dataset.citeKey === 'ghost')
    expect(ghost?.classList.contains(CITE_MISSING_CLASS)).toBe(true)
    const order = computeCiteOrder(view)
    expect(order.get('ghost')).toBe(0)
    expect(order.get('real')).toBe(1)
    editor.destroy()
  })

  it('goes back to plain numbering when the resolver is removed', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    setCiteKeyResolver(() => false)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('See [@a].')
    await new Promise((r) => setTimeout(r, 0))
    const view = editor.getView()
    expect(view.dom.querySelector('span.cite-chip')?.textContent).toBe('[?]')
    setCiteKeyResolver(null)
    await new Promise((r) => setTimeout(r, 0))
    expect(view.dom.querySelector('span.cite-chip')?.textContent).toBe('[1]')
    editor.destroy()
  })
})
