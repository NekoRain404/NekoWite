import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  askPluginPermission,
  getActiveVaultPluginIds,
  loadVaultPlugins,
  resetVaultPluginStateForTests,
  setPluginPermissionDecider,
} from './plugins'
import type { PluginMeta } from '@nekowite/plugin-host'

const listMock = vi.hoisted(() => vi.fn())
const readMock = vi.hoisted(() => vi.fn())
const loadMock = vi.hoisted(() => vi.fn())
const activateMock = vi.hoisted(() => vi.fn())
const deactivateMock = vi.hoisted(() => vi.fn())

vi.mock('./fs', () => ({ fsService: { list: listMock, read: readMock } }))
vi.mock('@nekowite/plugin-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nekowite/plugin-host')>()
  return {
    ...actual,
    loadPlugin: loadMock,
    activatePlugin: activateMock,
    deactivatePlugin: deactivateMock,
  }
})

const META = (permissions?: string[]): PluginMeta => ({
  id: '@scope/q',
  name: '@scope/q',
  version: '1.0.0',
  main: 'plugins/quote/index.js',
  permissions: permissions as never,
})

function pkg(permissions?: string[]): string {
  return JSON.stringify({ name: '@scope/q', version: '1.0.0', main: 'index.js', permissions })
}

beforeEach(() => {
  resetVaultPluginStateForTests()
  vi.clearAllMocks()
  listMock.mockResolvedValue([
    { name: 'quote', path: '/vault/plugins/quote', is_dir: true, is_mdx: false },
  ])
  readMock.mockResolvedValue(pkg())
  loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(), definition: {} })
  activateMock.mockResolvedValue({ ok: true, id: '@scope/q' })
})

describe('loadVaultPlugins', () => {
  it('is a silent no-op when the plugins dir is missing', async () => {
    listMock.mockRejectedValue(new Error('no plugins dir'))
    await expect(loadVaultPlugins('/vault')).resolves.toBeUndefined()
    expect(loadMock).not.toHaveBeenCalled()
    expect(activateMock).not.toHaveBeenCalled()
  })

  it('loads and activates each vault plugin', async () => {
    await loadVaultPlugins('/vault')
    expect(readMock).toHaveBeenCalledWith('/vault', 'plugins/quote/package.json')
    expect(loadMock).toHaveBeenCalledTimes(1)
    expect(activateMock).toHaveBeenCalledTimes(1)
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])
  })

  it('deactivates the previous vault’s plugins before loading a new vault', async () => {
    await loadVaultPlugins('/vaultA')
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])
    expect(deactivateMock).not.toHaveBeenCalled()

    listMock.mockResolvedValue([
      { name: 'quote', path: '/vaultB/plugins/quote', is_dir: true, is_mdx: false },
    ])
    await loadVaultPlugins('/vaultB')
    expect(deactivateMock).toHaveBeenCalledWith('@scope/q')
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])

    deactivateMock.mockClear()
    await loadVaultPlugins('/vaultA')
    expect(deactivateMock).toHaveBeenCalledWith('@scope/q')
  })

  it('never activates a plugin whose load failed', async () => {
    loadMock.mockResolvedValue({ ok: false, id: '@scope/q', error: 'boom' })
    await loadVaultPlugins('/vault')
    expect(activateMock).not.toHaveBeenCalled()
    expect(getActiveVaultPluginIds()).toEqual([])
  })
})

describe('askPluginPermission', () => {
  it('allows a pure UI plugin with no declared permissions', async () => {
    await expect(askPluginPermission(META(), {})).resolves.toBe(true)
    expect(activateMock).not.toHaveBeenCalled()
  })

  it('allows a plugin declaring only clipboard', async () => {
    await expect(askPluginPermission(META(['clipboard']), { permissions: ['clipboard'] })).resolves.toBe(true)
  })

  it('denies a dangerous plugin by default when no decider is installed', async () => {
    await expect(askPluginPermission(META(['fs']), { permissions: ['fs'] })).resolves.toBe(false)
  })

  it('denies a dangerous plugin when the decider rejects', async () => {
    setPluginPermissionDecider(() => Promise.resolve(false))
    await expect(askPluginPermission(META(['fs']), { permissions: ['fs'] })).resolves.toBe(false)
  })

  it('allows a dangerous plugin when the decider approves', async () => {
    setPluginPermissionDecider((meta) => Promise.resolve(meta.id === '@scope/q'))
    await expect(askPluginPermission(META(['network']), { permissions: ['network'] })).resolves.toBe(true)
  })

  it('keeps the verdict for a plugin across repeated asks', async () => {
    setPluginPermissionDecider(() => Promise.resolve(true))
    expect(await askPluginPermission(META(['ai']), { permissions: ['ai'] })).toBe(true)
    // The decider should not be invoked a second time for the same id.
    expect(await askPluginPermission(META(['ai']), { permissions: ['ai'] })).toBe(true)
  })
})

describe('permission gate during loadVaultPlugins', () => {
  it('skips activation of a dangerous plugin without consent', async () => {
    readMock.mockResolvedValue(pkg(['fs']))
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(['fs']), definition: {} })
    await loadVaultPlugins('/vault')
    expect(activateMock).not.toHaveBeenCalled()
  })

  it('activates a dangerous plugin after the decider approves', async () => {
    readMock.mockResolvedValue(pkg(['ai']))
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(['ai']), definition: {} })
    setPluginPermissionDecider(() => Promise.resolve(true))
    await loadVaultPlugins('/vault')
    expect(activateMock).toHaveBeenCalledTimes(1)
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])
  })
})
