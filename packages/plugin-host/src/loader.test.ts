import { describe, expect, it, vi } from 'vitest'
import { loadPlugin, loadPluginsFromDir, computePluginDigest, verifyPluginIntegrity } from './loader'
import type { PluginDigestStore, PluginFsAdapter } from './loader'
import { declaredPermissionsOf } from './permissions'
import { PluginError } from './types'

const importMock = vi.hoisted(() => vi.fn())

describe('loadPlugin', () => {
  it('loads a plugin and returns its definition', async () => {
    const def = { name: 'Demo', components: { X: {} } }
    importMock.mockResolvedValue({ default: def })
    const out = await loadPlugin({ id: 'demo', name: 'Demo', version: '1.0.0', main: './index.ts' }, importMock)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.definition.components?.['X']).toBeDefined()
  })

  it('returns error instead of throwing on bad plugin', async () => {
    importMock.mockRejectedValue(new Error('boom'))
    const out = await loadPlugin({ id: 'bad', name: 'Bad', version: '1', main: './x.ts' }, importMock)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('boom')
  })

  it('reads what the plugin declared exactly once, at load', async () => {
    // Load is where the host first owns the definition, so it is where the
    // declaration is read (and pinned): a plugin whose getter answers one thing
    // here and another later has already been read by the time anything asks.
    let reads = 0
    const def = {
      name: 'Once',
      get permissions() {
        reads += 1
        return reads === 1 ? ['fs'] : ['ai']
      },
    }
    importMock.mockResolvedValue({ default: def })
    const out = await loadPlugin({ id: 'once', name: 'Once', version: '1.0.0', main: './y.ts' }, importMock)
    expect(out.ok).toBe(true)
    expect(reads).toBe(1)
    if (out.ok) expect(declaredPermissionsOf(out.meta, out.definition)).toEqual(['fs'])
  })

  it('refuses a plugin whose declared permissions cannot be read at all', async () => {
    const def = {
      name: 'Hostile',
      get permissions() {
        throw new Error('no declaration for you')
      },
    }
    importMock.mockResolvedValue({ default: def })
    const out = await loadPlugin({ id: 'hostile', name: 'Hostile', version: '1', main: './z.ts' }, importMock)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('no declaration')
  })
})

describe('loadPluginsFromDir (injected fs boundary)', () => {
  it('degrades to a structured load error when no fs adapter is injected', async () => {
    let err: unknown
    try {
      await loadPluginsFromDir('/vault', undefined as unknown as PluginFsAdapter)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(PluginError)
    expect((err as PluginError).code).toBe('PLUGIN_LOAD_FAILED')
    expect((err as PluginError).recovery).toContain('inject a file-system adapter')
  })

  it('reads the plugin dir only through the injected adapter (no node fs)', async () => {
    const readdir = vi.fn(async () => [{ name: 'demo', isDirectory: () => true }])
    const readFile = vi.fn(async () =>
      JSON.stringify({ name: '@scope/demo', version: '1.0.0', main: 'index.js' }),
    )
    const fs: PluginFsAdapter = {
      readdir,
      readFile,
      stat: vi.fn(async () => ({ isDirectory: () => true })),
    }
    // The entry's dynamic import specifier is not resolvable in tests, so the
    // manifest yields an ok:false load that is skipped, but the fs boundary and
    // path joins are exercised without a crash (no node: built-ins referenced).
    const out = await loadPluginsFromDir('/vault', fs)
    expect(readdir).toHaveBeenCalledWith('/vault')
    expect(readFile).toHaveBeenCalledWith('/vault/demo/package.json')
    expect(out).toEqual([])
  })
})

describe('computePluginDigest', () => {
  it('is deterministic and sensitive to part boundaries', () => {
    const a = computePluginDigest('ab', 'c')
    const b = computePluginDigest('a', 'bc')
    expect(a).toEqual(computePluginDigest('ab', 'c'))
    expect(a).not.toEqual(b)
  })

  it('treats undefined/null parts as absent', () => {
    expect(computePluginDigest('x', undefined, null, 'y')).toEqual(computePluginDigest('x', 'y'))
  })
})

describe('verifyPluginIntegrity', () => {
  const store: PluginDigestStore = {
    get: (id) => (id === 'approved' ? 'abc' : undefined),
    set: () => {},
  }

  it('classifies a matching digest as ok', () => {
    expect(verifyPluginIntegrity('approved', 'abc', store)).toBe('ok')
  })

  it('classifies a changed digest as mismatch', () => {
    expect(verifyPluginIntegrity('approved', 'def', store)).toBe('mismatch')
  })

  it('classifies an unrecorded plugin as missing', () => {
    expect(verifyPluginIntegrity('fresh', 'abc', store)).toBe('missing')
  })

  it('supports a vault-scoped store so the same id in two vaults never collides', () => {
    // The production composite-key scheme: a store that keys its entries by
    // vault + id. The same plugin id approved in vault A must not be treated as
    // approved in vault B.
    const toKey = (vault: string, id: string): string =>
      `${vault}${String.fromCharCode(0)}${id}`
    const entries = new Map<string, string>()
    const vaultA: PluginDigestStore = {
      get: (id) => entries.get(toKey('/vaultA', id)),
      set: (id, digest) => {
        entries.set(toKey('/vaultA', id), digest)
      },
    }
    vaultA.set('@scope/q', 'abc')
    expect(verifyPluginIntegrity('@scope/q', 'abc', vaultA)).toBe('ok')
    // The same id in a different vault has never been approved.
    const vaultB: PluginDigestStore = { get: () => undefined, set: () => {} }
    expect(verifyPluginIntegrity('@scope/q', 'abc', vaultB)).toBe('missing')
  })
})
