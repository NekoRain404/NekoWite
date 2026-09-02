import { afterEach, describe, expect, it, vi } from 'vitest'

describe('getGateways', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('returns tauri gateways when Tauri internals are present', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    const { getGateways } = await import('./index')
    const gw = getGateways()
    expect(gw.fs.read).toBeTypeOf('function')
    // Without a mocked invoke the tauri gateway must not resolve a list.
    await expect(gw.fs.list('memoir://demo', '.')).rejects.toThrow()
  })

  it('returns memory gateways when running in a plain browser', async () => {
    vi.stubGlobal('window', {})
    const { getGateways } = await import('./index')
    const gw = getGateways()
    expect(gw.fs.read).toBeTypeOf('function')
    // The default-seeded memory gateway lists the demo welcome.md at the root.
    const root = await gw.fs.list('memoir://demo', '.')
    expect(root.map((e) => e.name)).toContain('welcome.md')
  })
})
