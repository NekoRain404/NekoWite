import { describe, expect, it } from 'vitest'
import { createMemoryFsGateway } from '../platform/gateways/memory'
import {
  buildIndexIncremental,
  checksumOf,
  createFileIndexStorage,
  INDEX_VERSION,
  indexMetaKey,
  indexShardKey,
  loadIndex,
  saveIndex,
  shardLabelForPath,
  type StoredIndex,
} from './search-index'

const VAULT = 'memoir://demo'
const BASE = '.nekowite/index'

function memoryFs(seed: Record<string, string> = {}) {
  return createMemoryFsGateway(seed)
}

describe('createFileIndexStorage (fs-backed shards)', () => {
  it('round-trips an index through .nekowite/index files (+ no leftover .tmp)', async () => {
    const fs = memoryFs()
    const storage = createFileIndexStorage(fs, VAULT)
    const index: StoredIndex = {
      version: INDEX_VERSION,
      vault: VAULT,
      builtAt: 1,
      notes: {
        '/vault/a.md': { token: '1:1', text: 'alpha', mtime: 1, size: 1 },
        '/vault/b.md': { token: '2:2', text: 'beta', mtime: 2, size: 2 },
      },
    }
    await saveIndex(index, storage)
    const loaded = await loadIndex(VAULT, storage)
    expect(loaded).toEqual(index)

    // The manifest + each materialised shard is written as a JSON file, and the
    // atomic temp→swap left no `.tmp` sibling behind.
    const manifest = await fs.read(VAULT, `${BASE}/manifest.json`)
    const meta = JSON.parse(manifest)
    expect(meta.version).toBe(INDEX_VERSION)
    expect(meta.noteCount).toBe(2)
    const label = shardLabelForPath('/vault/a.md')
    const shard = await fs.read(VAULT, `${BASE}/shard-${label}.json`)
    expect(checksumOf(shard)).toBe(meta.shards[label].checksum)
    await expect(fs.read(VAULT, `${BASE}/manifest.json.tmp`)).rejects.toThrow()
  })

  it('flags a corrupted shard and heals it with a targeted rebuild', async () => {
    const fs = memoryFs({
      'a.md': '# Alpha\n\nbody alpha',
      'b.md': '# Beta\n\nbody beta',
    })
    const storage = createFileIndexStorage(fs, VAULT)
    const files = ['a.md', 'b.md']
    const stat = async () => ({ mtime: 1, size: 1 })
    const read = async (p: string) => fs.read(VAULT, p)

    const build1 = await buildIndexIncremental(VAULT, files, { stat, read }, null)
    await saveIndex(build1.index, storage)
    expect(((await loadIndex(VAULT, storage))?.corruptShards ?? []).length).toBe(0)

    // Corrupt one shard file on the fs.
    const label = shardLabelForPath('a.md')
    await fs.write(VAULT, `${BASE}/shard-${label}.json`, 'torn-{ garbage', 0)
    const corrupt = await loadIndex(VAULT, storage)
    expect(corrupt?.corruptShards).toContain(label)
    expect(corrupt?.notes['a.md']).toBeUndefined()

    // Rebuild from the corrupt index: the corrupt shard's note is re-read, the
    // rest are skipped -> a targeted rebuild (not a full one).
    const rebuild = await buildIndexIncremental(VAULT, files, { stat, read }, corrupt)
    expect(rebuild.rebuiltShards).toContain(label)
    await saveIndex(rebuild.index, storage)
    expect(((await loadIndex(VAULT, storage))?.corruptShards ?? []).length).toBe(0)
    expect((await loadIndex(VAULT, storage))?.notes['a.md']).toBeDefined()
  })

  it('a missing/corrupt manifest is treated as no index (fresh rebuild)', async () => {
    const fs = memoryFs()
    const storage = createFileIndexStorage(fs, VAULT)
    expect(await loadIndex(VAULT, storage)).toBeNull()
    // Corrupt manifest → no index (caller rebuilds whole index).
    await fs.write(VAULT, `${BASE}/manifest.json`, '{garbage', 0)
    expect(await loadIndex(VAULT, storage)).toBeNull()
  })

  it('clearIndex drops the manifest + every shard and their .tmp siblings', async () => {
    const fs = memoryFs()
    const storage = createFileIndexStorage(fs, VAULT)
    await saveIndex(
      {
        version: INDEX_VERSION,
        vault: VAULT,
        builtAt: 1,
        notes: {
          '/vault/a.md': { token: '1:1', text: 'alpha', mtime: 1, size: 1 },
        },
      },
      storage,
    )
    const { clearIndex } = await import('./search-index')
    await clearIndex(VAULT, storage)
    expect(await loadIndex(VAULT, storage)).toBeNull()
    // Manifest + every possible shard file is gone.
    await expect(fs.read(VAULT, `${BASE}/manifest.json`)).rejects.toThrow()
    await expect(fs.read(VAULT, `${BASE}/shard-${shardLabelForPath('/vault/a.md')}.json`)).rejects.toThrow()
    // A stray temp key is cleaned too.
    await expect(fs.read(VAULT, `${BASE}/manifest.json.tmp`)).rejects.toThrow()
  })

  it('memory-gateway fallback: an unavailable/missing file reads as null, not a throw', async () => {
    const fs = memoryFs()
    const storage = createFileIndexStorage(fs, VAULT)
    // Remove the manifest after a write: read resolves to null (fresh load).
    await expect(storage.getItem(indexMetaKey(VAULT))).resolves.toBeNull()
    // A shard read for a never-written shard is also null (corrupt rebuild).
    await expect(storage.getItem(indexShardKey(VAULT, 'a'))).resolves.toBeNull()
  })
})
