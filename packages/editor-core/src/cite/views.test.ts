import { describe, expect, it } from 'vitest'
import { createEditor, basicPlugins } from '../editor'
import { computeCiteOrder } from './views'

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
})