import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadVaultPlugins } from './plugins'

const listMock = vi.hoisted(() => vi.fn())
const readMock = vi.hoisted(() => vi.fn())
const loadMock = vi.hoisted(() => vi.fn())
const activateMock = vi.hoisted(() => vi.fn())

vi.mock('./fs', () => ({ fsService: { list: listMock, read: readMock } }))
vi.mock('@nekowite/plugin-host', () => ({
  loadPlugin: loadMock,
  activatePlugin: activateMock,
}))

describe('loadVaultPlugins', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is a silent no-op when the plugins dir is missing', async () => {
    listMock.mockRejectedValue(new Error('no plugins dir'))
    await expect(loadVaultPlugins('/vault')).resolves.toBeUndefined()
    expect(loadMock).not.toHaveBeenCalled()
    expect(activateMock).not.toHaveBeenCalled()
  })

  it('loads and activates each vault plugin', async () => {
    listMock.mockResolvedValue([
      { name: 'quote', path: '/vault/plugins/quote', is_dir: true, is_mdx: false },
    ])
    readMock.mockResolvedValue(
      JSON.stringify({ name: '@scope/q', version: '1.0.0', main: 'index.js' }),
    )
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: {}, definition: {} })
    activateMock.mockResolvedValue({ ok: true, id: '@scope/q' })

    await loadVaultPlugins('/vault')
    expect(readMock).toHaveBeenCalledWith('/vault', 'plugins/quote/package.json')
    expect(loadMock).toHaveBeenCalledTimes(1)
    expect(activateMock).toHaveBeenCalledTimes(1)
  })
})
