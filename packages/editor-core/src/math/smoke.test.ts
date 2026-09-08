import { describe, expect, it } from 'vitest'
import { basicPlugins, createEditor } from '../editor'

describe('math editor smoke', () => {
  it('save round-trips inline math', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    const md = 'Energy is $E=mc^2$.\n'
    await editor.open(md)
    expect(await editor.save()).toContain('$E=mc^2$')
  })
  it('save round-trips display math', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    const md = '$$\nx^2 + y^2 = z^2\n$$\n'
    await editor.open(md)
    expect(await editor.save()).toBe(md)
  })
})
