import { describe, expect, it } from 'vitest'

import { basicPlugins, createEditor } from './editor'

describe('createEditor', () => {
  it('exposes open/save API', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('# Hello')
    const md = await editor.save()
    expect(md).toContain('# Hello')
  })
})