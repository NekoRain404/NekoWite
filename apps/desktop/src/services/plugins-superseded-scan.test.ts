/**
 * A superseded vault's plugin scan.
 *
 * A vault switch is not a cancellation: the load pipeline awaits a directory
 * read, a consent dialog, a digest and an import, none of them instant, so the
 * older scan can finish after the newer vault has already installed its own
 * set. Activation registers into a process-wide host, so the older scan's
 * plugins would land on top of the newer set with nothing left to take them
 * down — the load that owned them has already returned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getActiveVaultPluginIds, loadVaultPlugins, resetVaultPluginStateForTests } from './plugins'
import type { PluginMeta } from '@nekowite/plugin-host'

const listMock = vi.hoisted(() => vi.fn())
const readMock = vi.hoisted(() => vi.fn())
const loadMock = vi.hoisted(() => vi.fn())
const activateMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
  fsService: { list: listMock, read: readMock, write: vi.fn() },
}))
vi.mock('./errors', () => ({
  notifyError: vi.fn(),
  describePluginError: (e: { message?: string; recovery?: string }) =>
    `${e.message ?? ''}${e.recovery ? ` ${e.recovery}` : ''}`,
}))
vi.mock('@nekowite/plugin-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nekowite/plugin-host')>()),
  loadPlugin: loadMock,
  activatePlugin: activateMock,
  deactivatePlugin: vi.fn(),
}))

const entries = (vault: string) => [
  { name: 'quote', path: `${vault}/plugins/quote`, is_dir: true, is_mdx: false },
]

beforeEach(() => {
  resetVaultPluginStateForTests()
  localStorage.clear()
  vi.clearAllMocks()
  // Each vault has one plugin, under its own id, so "which vault activated" is
  // readable in the active set.
  readMock.mockImplementation((vault: string, rel: string) =>
    Promise.resolve(
      rel.endsWith('package.json')
        ? JSON.stringify({
            name: vault === '/vaultA' ? '@scope/a' : '@scope/b',
            version: '1.0.0',
            main: 'index.js',
          })
        : 'export default {}',
    ),
  )
  loadMock.mockImplementation(async (meta: PluginMeta) => ({
    ok: true,
    id: meta.id,
    meta,
    definition: {},
  }))
  activateMock.mockImplementation(async (res: { id: string }) => ({ ok: true, id: res.id }))
})

describe('a superseded vault’s plugin scan', () => {
  it('does not activate after a newer vault claimed the app', async () => {
    let releaseA: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    listMock.mockImplementation((vault: string) =>
      vault === '/vaultA' ? held.then(() => entries(vault)) : Promise.resolve(entries(vault)),
    )

    // Vault A's scan starts and is held at its first read...
    const stale = loadVaultPlugins('/vaultA')
    // ...the user switches to vault B, whose scan runs to completion...
    await loadVaultPlugins('/vaultB')
    expect(getActiveVaultPluginIds()).toEqual(['@scope/b'])

    // ...and only then does A's scan resume.
    releaseA()
    await stale

    expect(getActiveVaultPluginIds()).toEqual(['@scope/b'])
    expect(activateMock).toHaveBeenCalledTimes(1)
  })

  it('still activates its own vault when nothing superseded it', async () => {
    listMock.mockImplementation((vault: string) => Promise.resolve(entries(vault)))
    await loadVaultPlugins('/vaultA')
    expect(getActiveVaultPluginIds()).toEqual(['@scope/a'])
  })
})
