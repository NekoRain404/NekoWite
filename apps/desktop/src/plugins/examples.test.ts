import { describe, expect, it } from 'vitest'
import { calloutPlugin } from './callout'
import { activatePlugin } from '@nekowite/plugin-host'
import { getComponent, getToolbar } from '@nekowite/editor-core'

const meta = { id: 'callout', name: 'Callout', version: '1', main: 'x' }

describe('builtin callout plugin', () => {
  it('registers Callout component and toolbar item', async () => {
    const res = await activatePlugin({
      ok: true,
      id: 'callout',
      meta,
      definition: calloutPlugin,
    })
    expect(res.ok).toBe(true)
    expect(getComponent('Callout')).toBeDefined()
    expect(getToolbar().some((t) => t.label === '插入 Callout')).toBe(true)
  })
})
