import { describe, expect, it, vi } from 'vitest'
import { collectVaultFiles, MAX_DIRS, VaultFileIndex, walkVault } from './vault-files'
import type { FileEntry } from '../platform/gateways/fs'

// A tiny cap for the truncation tests: building MAX_DIRS+1 = 100_001 directories
// would be far too slow, so the walk cap is exercised with a small override.
const SMALL_MAX_DIRS = 4

function entry(name: string, path: string, isDir: boolean, isMdx = false): FileEntry {
  return { name, path, is_dir: isDir, is_mdx: isMdx }
}

const TREE: Record<string, FileEntry[]> = {
  vault: [
    entry('welcome.md', 'vault/welcome.md', false, true),
    entry('notes', 'vault/notes', true),
    entry('node_modules', 'vault/node_modules', true),
    entry('.hidden', 'vault/.hidden', true),
    entry('logo.png', 'vault/logo.png', false),
  ],
  'vault/notes': [
    entry('idea.md', 'vault/notes/idea.md', false, true),
    entry('draft.md', 'vault/notes/draft.md', false, true),
    entry('math', 'vault/notes/math', true),
    entry('deep', 'vault/notes/deep', true),
  ],
  'vault/notes/math': [entry('线性代数.md', 'vault/notes/math/线性代数.md', false, true)],
  'vault/notes/deep': [entry('nested.md', 'vault/notes/deep/nested.md', false, true)],
}

function fakeList(): { list: (vault: string, dir: string) => Promise<FileEntry[]>; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    list: vi.fn(async (_vault: string, dir: string) => {
      calls.push(dir)
      const entries = TREE[dir]
      if (!entries) throw new Error(`no such dir: ${dir}`)
      return entries
    }),
  }
}

describe('collectVaultFiles', () => {
  it('walks recursively and only keeps markdown/MDX files', async () => {
    const { list } = fakeList()
    const files = await collectVaultFiles('vault', list)
    expect(files).toEqual([
      'vault/notes/deep/nested.md',
      'vault/notes/draft.md',
      'vault/notes/idea.md',
      'vault/notes/math/线性代数.md',
      'vault/welcome.md',
    ])
  })
  it('skips node_modules and hidden directories', async () => {
    const { list, calls } = fakeList()
    await collectVaultFiles('vault', list)
    expect(calls.some((c) => c.includes('node_modules'))).toBe(false)
    expect(calls.some((c) => c.includes('.hidden'))).toBe(false)
  })
  it('tolerates failing directories instead of rejecting', async () => {
    const files = await collectVaultFiles('vault', async (_v, dir) => {
      if (dir === 'vault/notes') throw new Error('boom')
      return TREE[dir] ?? []
    })
    expect(files).toEqual(['vault/welcome.md'])
  })
  it('lists sibling directories concurrently and still returns a deterministic result', async () => {
    const gates = new Map<string, () => void>()
    const list = vi.fn(async (_v: string, dir: string) => {
      if (dir === 'vault') {
        return [entry('a', 'vault/a', true), entry('b', 'vault/b', true)]
      }
      // Gate the two siblings so we can observe they are requested in parallel.
      await new Promise<void>((resolve) => gates.set(dir, resolve))
      return dir === 'vault/a'
        ? [entry('one.md', 'vault/a/one.md', false, true)]
        : [entry('two.md', 'vault/b/two.md', false, true)]
    })
    const p = collectVaultFiles('vault', list)
    // Both sibling dirs must be requested without waiting for the first to
    // resolve — if listing were serial, only 'vault/a' would be in flight now.
    await new Promise((r) => setTimeout(r, 0))
    const requested = list.mock.calls.map(([, d]) => d)
    expect(requested).toContain('vault/a')
    expect(requested).toContain('vault/b')
    for (const dir of ['vault/a', 'vault/b']) gates.get(dir)?.()
    await expect(p).resolves.toEqual(['vault/a/one.md', 'vault/b/two.md'])
  })
  it('flags truncated and does not silently drop when the directory cap is hit', async () => {
    const dirs = Array.from({ length: SMALL_MAX_DIRS + 1 }, (_, i) => `d${i}`)
    const result = await walkVault(
      'vault',
      async (_v, dir) => {
        if (dir === 'vault') return dirs.map((name) => entry(name, `vault/${name}`, true))
        return [entry('note.md', `${dir}/note.md`, false, true)]
      },
      { maxDirs: SMALL_MAX_DIRS },
    )
    expect(result.truncated).toBe(true)
    expect(result.files).toHaveLength(SMALL_MAX_DIRS - 1)
  })

  it('raises the default directory cap far above any realistic vault', () => {
    // The default must not silently cap a large vault. A 10k-file vault with a
    // handful of dirs each must never hit this bound.
    expect(MAX_DIRS).toBeGreaterThanOrEqual(100_000)
  })

  it('does not truncate a vault that fits under the cap', async () => {
    // The vault root counts as one visited directory, so SMALL_MAX_DIRS - 1
    // second-level dirs leaves every visit within the cap — no truncation.
    const dirs = Array.from({ length: SMALL_MAX_DIRS - 1 }, (_, i) => `d${i}`)
    const result = await walkVault(
      'vault',
      async (_v, dir) => {
        if (dir === 'vault') return dirs.map((name) => entry(name, `vault/${name}`, true))
        return [entry('note.md', `${dir}/note.md`, false, true)]
      },
      { maxDirs: SMALL_MAX_DIRS },
    )
    expect(result.truncated).toBe(false)
  })
})

describe('VaultFileIndex', () => {
  it('caches the listing until invalidated', async () => {
    const { list, calls } = fakeList()
    const index = new VaultFileIndex(list)
    await index.get('vault')
    await index.get('vault')
    expect(calls).toHaveLength(Object.keys(TREE).length)
    index.invalidate('vault')
    await index.get('vault')
    expect(calls).toHaveLength(Object.keys(TREE).length * 2)
  })
  it('shares one in-flight walk between concurrent gets', async () => {
    const { list } = fakeList()
    const index = new VaultFileIndex(list)
    const [a, b] = await Promise.all([index.get('vault'), index.get('vault')])
    expect(a).toEqual(b)
    expect(list).toHaveBeenCalledTimes(Object.keys(TREE).length)
  })
  it('resolves to an empty list when the walk fails', async () => {
    const index = new VaultFileIndex(async () => {
      throw new Error('no vault')
    })
    await expect(index.get('gone')).resolves.toEqual([])
  })

  it('reports false for a vault that fits under the directory cap', async () => {
    const { list } = fakeList()
    const index = new VaultFileIndex(list)
    await index.get('vault')
    expect(index.isTruncated('vault')).toBe(false)
  })
  it('reports true when the directory cap was hit, and clears it on invalidate', async () => {
    const dirs = Array.from({ length: SMALL_MAX_DIRS + 1 }, (_, i) => `d${i}`)
    const index = new VaultFileIndex(
      async (_v, dir) => {
        if (dir === 'vault') return dirs.map((name) => entry(name, `vault/${name}`, true))
        return []
      },
      SMALL_MAX_DIRS,
    )
    await index.get('vault')
    expect(index.isTruncated('vault')).toBe(true)
    index.invalidate('vault')
    expect(index.isTruncated('vault')).toBe(false)
  })

  it('discards an in-flight walk superseded by invalidate so newer data wins', async () => {
    const resolvers: Array<(files: FileEntry[]) => void> = []
    const list = vi.fn(
      () =>
        new Promise<FileEntry[]>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    const index = new VaultFileIndex(list)
    const stale = index.get('vault')
    index.invalidate('vault')
    const fresh = index.get('vault')

    // The old walk resolves first with stale data — it must not touch cache.
    resolvers[0]([entry('old.md', 'vault/old.md', false, true)])
    expect(await stale).toEqual(['vault/old.md'])

    // The new walk wins and populates the cache.
    resolvers[1]([entry('new.md', 'vault/new.md', false, true)])
    expect(await fresh).toEqual(['vault/new.md'])
    expect(await index.get('vault')).toEqual(['vault/new.md'])
    expect(list).toHaveBeenCalledTimes(2)
  })

describe('walkVault completeness', () => {
  it('flags an unlistable directory as incomplete while keeping what it did list', async () => {
    const list = async (_vault: string, dir: string) => {
      if (dir === '/vault/locked') throw new Error('EACCES: permission denied')
      if (dir === '/vault') {
        return [
          { name: 'locked', path: '/vault/locked', is_dir: true, is_mdx: false },
          { name: 'a.md', path: '/vault/a.md', is_dir: false, is_mdx: true },
        ]
      }
      return []
    }
    const result = await walkVault('/vault', list)
    expect(result.files).toEqual(['/vault/a.md'])
    expect(result.truncated).toBe(false)
    // A caller that deletes `.tmp` litter on the strength of "no note
    // references it" must not trust a walk that could not read every folder.
    expect(result.incomplete).toBe(true)
  })

  it('is complete when every directory was listed', async () => {
    const list = async (_vault: string, dir: string) =>
      dir === '/vault'
        ? [{ name: 'a.md', path: '/vault/a.md', is_dir: false, is_mdx: true }]
        : []
    expect((await walkVault('/vault', list)).incomplete).toBe(false)
  })

  it('exposes the incompleteness through VaultFileIndex', async () => {
    const list = async (_vault: string, dir: string) => {
      if (dir === '/vault/locked') throw new Error('gone')
      if (dir === '/vault') return [{ name: 'locked', path: '/vault/locked', is_dir: true, is_mdx: false }]
      return []
    }
    const index = new VaultFileIndex(list)
    await index.get('/vault')
    expect(index.isIncomplete('/vault')).toBe(true)
    index.invalidate('/vault')
    expect(index.isIncomplete('/vault')).toBe(false)
  })
})
})
