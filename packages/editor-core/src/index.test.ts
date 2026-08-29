import { describe, expect, it } from 'vitest'

import { basicPlugins, createEditor } from './index'
import type { NekoEditor } from './index'

describe('editor-core smoke', () => {
  it('exports public API', () => {
    expect(typeof createEditor).toBe('function')
    expect(Array.isArray(basicPlugins)).toBe(true)
    const editor: NekoEditor = {} as NekoEditor
    expect(editor).toBeDefined()
  })
})