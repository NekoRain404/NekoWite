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
    expect(gw.ai.listModels).toBeTypeOf('function')
    // Without a mocked invoke the tauri gateway must not resolve a list.
    await expect(gw.fs.list('memoir://demo', '.')).rejects.toThrow()
  })

  it('returns memory gateways when running in a plain browser', async () => {
    vi.stubGlobal('window', {})
    const { getGateways } = await import('./index')
    const gw = getGateways()
    expect(gw.fs.read).toBeTypeOf('function')
    expect(gw.ai.listModels).toBeTypeOf('function')
    // The default-seeded memory gateway lists the demo welcome.md at the root.
    const root = await gw.fs.list('memoir://demo', '.')
    expect(root.map((e) => e.name)).toContain('welcome.md')
  })
})

describe('createGateways', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('builds the separated ports for a tauri environment', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    const { createGateways } = await import('../../platform/gateways')
    const gw = createGateways({ environment: 'tauri' })
    expect(gw.fs.read).toBeTypeOf('function')
    // Dialogs and events are first-class ports, not conflated onto `.fs`.
    expect(gw.dialogs.openFolderDialog).toBeTypeOf('function')
    expect(gw.events.on).toBeTypeOf('function')
    expect(gw.keys.loadAiKey).toBeTypeOf('function')
    // Without a mocked invoke the tauri gateway must not resolve a list.
    await expect(gw.fs.list('memoir://demo', '.')).rejects.toThrow()
  })

  it('builds the separated ports for a memory environment', async () => {
    vi.stubGlobal('window', {})
    const { createGateways } = await import('../../platform/gateways')
    const gw = createGateways({ environment: 'browser' })
    expect(gw.fs.read).toBeTypeOf('function')
    expect(gw.dialogs.openFolderDialog).toBeTypeOf('function')
    expect(gw.events.emit).toBeTypeOf('function')
    const root = await gw.fs.list('memoir://demo', '.')
    expect(root.map((e) => e.name)).toContain('welcome.md')
  })
})
