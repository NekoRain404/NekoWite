import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  askPluginPermission,
  getActiveVaultPluginIds,
  loadVaultPlugins,
  resetVaultPluginStateForTests,
  setPluginPermissionDecider,
  setPluginIntegrityDecider,
} from './plugins'
import { computePluginDigest } from '@nekowite/plugin-host'
import type { PluginMeta } from '@nekowite/plugin-host'

const listMock = vi.hoisted(() => vi.fn())
const readMock = vi.hoisted(() => vi.fn())
const loadMock = vi.hoisted(() => vi.fn())
const activateMock = vi.hoisted(() => vi.fn())
const deactivateMock = vi.hoisted(() => vi.fn())
const notifyErrorMock = vi.hoisted(() => vi.fn())

vi.mock('./fs', () => ({ fsService: { list: listMock, read: readMock } }))
vi.mock('./errors', () => ({
  notifyError: notifyErrorMock,
  describePluginError: (e: { message?: string; recovery?: string }) =>
    `${e.message ?? ''}${e.recovery ? ` ${e.recovery}` : ''}`,
}))
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
  notifyErrorMock.mockClear()
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

describe('parallel loading & isolation', () => {
  it('activates multiple plugins in deterministic sorted order', async () => {
    listMock.mockResolvedValue([
      { name: 'zzz', path: '/vault/plugins/zzz', is_dir: true, is_mdx: false },
      { name: 'aaa', path: '/vault/plugins/aaa', is_dir: true, is_mdx: false },
    ])
    readMock.mockImplementation((_vault, rel) =>
      Promise.resolve(
        rel.includes('zzz')
          ? JSON.stringify({ name: '@scope/zzz', version: '1.0.0', main: 'index.js' })
          : JSON.stringify({ name: '@scope/aaa', version: '1.0.0', main: 'index.js' }),
      ),
    )
    loadMock.mockImplementation(async (meta) => ({ ok: true, id: meta.id, meta, definition: {} }))
    activateMock.mockImplementation(async (res) => ({ ok: true, id: res.id }))
    await loadVaultPlugins('/vault')
    expect(getActiveVaultPluginIds()).toEqual(['@scope/aaa', '@scope/zzz'])
  })

  it('isolates a failing plugin so the others still activate', async () => {
    listMock.mockResolvedValue([
      { name: 'good', path: '/vault/plugins/good', is_dir: true, is_mdx: false },
      { name: 'bad', path: '/vault/plugins/bad', is_dir: true, is_mdx: false },
    ])
    readMock.mockImplementation((_vault, rel) =>
      Promise.resolve(
        rel.includes('good')
          ? JSON.stringify({ name: '@scope/good', version: '1.0.0', main: 'index.js' })
          : JSON.stringify({ name: '@scope/bad', version: '1.0.0', main: 'index.js' }),
      ),
    )
    loadMock.mockImplementation(async (meta) =>
      meta.id === '@scope/bad'
        ? { ok: false, id: meta.id, error: 'boom' }
        : { ok: true, id: meta.id, meta, definition: {} },
    )
    activateMock.mockImplementation(async (res) => ({ ok: true, id: res.id }))
    await loadVaultPlugins('/vault')
    expect(getActiveVaultPluginIds()).toEqual(['@scope/good'])
    expect(notifyErrorMock).toHaveBeenCalled()
    expect(String(notifyErrorMock.mock.calls[0]?.[0])).toContain('@scope/bad')
  })
})

describe('distinct plugin failure buckets', () => {
  it('silently skips a directory without a manifest (not a plugin)', async () => {
    readMock.mockRejectedValue(new Error('missing'))
    await loadVaultPlugins('/vault')
    expect(activateMock).not.toHaveBeenCalled()
    expect(getActiveVaultPluginIds()).toEqual([])
    expect(notifyErrorMock).not.toHaveBeenCalled()
  })

  it('routes a missing entry file to a not-found recovery hint', async () => {
    loadMock.mockRejectedValue(new Error('Cannot find module "./index.js"'))
    await loadVaultPlugins('/vault')
    expect(activateMock).not.toHaveBeenCalled()
    const msg = String(notifyErrorMock.mock.calls[0]?.[0])
    expect(msg).toContain('could not be found')
    expect(msg).toContain('Reinstall the plugin')
  })

  it('routes an invalid manifest (bad JSON) to a manifest-invalid error message', async () => {
    readMock.mockResolvedValue('not json')
    await loadVaultPlugins('/vault')
    expect(activateMock).not.toHaveBeenCalled()
    const msg = String(notifyErrorMock.mock.calls[0]?.[0])
    expect(msg).toContain('invalid manifest')
  })

  it('routes a parse/load code failure distinctly from an activation failure', async () => {
    // Load failure (import throws)
    loadMock.mockRejectedValue(new Error('SyntaxError: Unexpected token'))
    await loadVaultPlugins('/vault')
    expect(activateMock).not.toHaveBeenCalled()
    const loadMsg = String(notifyErrorMock.mock.calls[0]?.[0])
    expect(loadMsg).toContain('could not be parsed/imported')

    // Activation failure
    notifyErrorMock.mockClear()
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(), definition: {} })
    activateMock.mockResolvedValue({ ok: false, id: '@scope/q', error: 'register failed' })
    await loadVaultPlugins('/vault')
    expect(getActiveVaultPluginIds()).toEqual([])
    const actMsg = String(notifyErrorMock.mock.calls[0]?.[0])
    expect(actMsg).toContain('failed to activate')
    expect(actMsg).toContain('Disable and re-enable the plugin')
  })

  it('routes a permission denial through a structured permission-denied error', async () => {
    readMock.mockResolvedValue(pkg(['fs']))
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(['fs']), definition: {} })
    await loadVaultPlugins('/vault')
    expect(activateMock).not.toHaveBeenCalled()
    expect(getActiveVaultPluginIds()).toEqual([])
    const msg = String(notifyErrorMock.mock.calls[0]?.[0])
    expect(msg).toContain('@scope/q')
    expect(msg).toContain('permission(s)')
    expect(msg).toContain('Grant the requested permission')
  })
})

describe('plugin integrity detection', () => {
  it('records a baseline fingerprint on first approval', async () => {
    readMock.mockResolvedValue(pkg())
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(), definition: {} })
    await loadVaultPlugins('/vault')
    expect(activateMock).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(localStorage.getItem('nekowite.pluginDigests') ?? '{}')
    expect(stored['@scope/q']).toBeDefined()
    expect(stored['@scope/q'].d).toEqual(computePluginDigest(pkg(), ''))
  })

  it('refuses to activate a plugin whose code changed since it was approved', async () => {
    readMock.mockResolvedValue(pkg(['fs']))
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(['fs']), definition: {} })
    setPluginPermissionDecider(() => Promise.resolve(true))
    // Seed a stale fingerprint so this load's digest does not match.
    localStorage.setItem(
      'nekowite.pluginDigests',
      JSON.stringify({ '@scope/q': { v: '1.0.0', d: 'deadbeef' } }),
    )
    await loadVaultPlugins('/vault')
    expect(activateMock).not.toHaveBeenCalled()
    expect(getActiveVaultPluginIds()).toEqual([])
    const msgs = notifyErrorMock.mock.calls.map((c) => String(c[0]))
    const verifyMsg = msgs.find((m) => m.includes('modified since it was last approved'))
    expect(verifyMsg).toBeDefined()
    expect(verifyMsg).toContain('Re-approve the plugin or reinstall it')
  })

  it('re-activates a modified plugin only after the user re-approves it', async () => {
    readMock.mockResolvedValue(pkg(['fs']))
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(['fs']), definition: {} })
    setPluginPermissionDecider(() => Promise.resolve(true))
    setPluginIntegrityDecider(() => Promise.resolve(true))
    localStorage.setItem(
      'nekowite.pluginDigests',
      JSON.stringify({ '@scope/q': { v: '1.0.0', d: 'deadbeef' } }),
    )
    await loadVaultPlugins('/vault')
    expect(activateMock).toHaveBeenCalledTimes(1)
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])
    const stored = JSON.parse(localStorage.getItem('nekowite.pluginDigests') ?? '{}')
    expect(stored['@scope/q'].d).not.toEqual('deadbeef')
  })
})
