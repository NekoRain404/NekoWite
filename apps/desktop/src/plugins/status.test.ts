import { describe, expect, it, vi } from 'vitest'
import { activatePlugin, deactivatePlugin, emitLifecycle } from '@nekowite/plugin-host'
import { statusPlugin } from './status'

const meta = { id: 'nekowite.builtin.status', name: 'Status', version: '1', main: '@nekowite/builtin-status' }

describe('status plugin lifecycle smoke', () => {
  it('onDocChange dispatches nekowite:word-count with the live doc word count', async () => {
    const res = await activatePlugin({ ok: true, id: meta.id, meta, definition: statusPlugin })
    expect(res.ok).toBe(true)
    const listener = vi.fn()
    window.addEventListener('nekowite:word-count', listener)
    emitLifecycle('onDocChange', { doc: 'hello world foo' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect((listener.mock.calls[0][0] as CustomEvent<number>).detail).toBe(3)
    window.removeEventListener('nekowite:word-count', listener)
    deactivatePlugin(meta.id)
  })
})