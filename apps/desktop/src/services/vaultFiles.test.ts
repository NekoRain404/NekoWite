import { describe, expect, it, vi } from 'vitest'
import { collectVaultFiles, VaultFileIndex } from './vaultFiles'
import type { FileEntry } from './fs'

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
})
