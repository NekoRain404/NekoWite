import { describe, expect, it } from 'vitest'
import { buildIndexIncremental } from './index-build'
import { INDEX_VERSION, type IndexedDoc, type StoredIndex } from './index-model'
import { clearIndex, loadIndex, saveIndex } from './index-shard-store'
import { indexMetaKey, type AsyncIndexStorage } from './index-storage'

const VAULT = '/vault'
const META = indexMetaKey(VAULT)

/**
 * Storage whose writes can be held open by key.
 *
 * A save writes its shards and then the metadata record, which is the commit
 * marker: holding the marker is how a test puts two saves into the one order
 * that matters — the older one reaching the marker after the newer one already
 * has. Holding a shard instead parks a save halfway through its own writes.
 */
function gatedStorage() {
  const data = new Map<string, string>()
  const held = new Map<string, Array<() => void>>()
  const ops: string[] = []
  let hold: (key: string) => boolean = () => false

  const storage: AsyncIndexStorage = {
    getItem: async (k) => data.get(k) ?? null,
    setItem: (k, v) =>
      new Promise<void>((resolve) => {
        const commit = (): void => {
          data.set(k, v)
          ops.push(`set:${k}`)
          resolve()
        }
        if (hold(k)) {
          const list = held.get(k) ?? []
          list.push(commit)
          held.set(k, list)
          return
        }
        commit()
      }),
    removeItem: async (k) => {
      data.delete(k)
      ops.push(`remove:${k}`)
    },
  }

  return {
    data,
    ops,
    storage,
    /** Hold every subsequent write of the commit marker. */
    holdCommitMarker: (): void => {
      hold = (k) => k === META
    },
    /** Hold every subsequent shard write (not the marker). */
    holdShards: (): void => {
      hold = (k) => k !== META
    },
    /** Commit the most recently held write first, then the older ones — so the
     *  snapshot that reaches disk LAST is the older one. */
    release: (): void => {
      hold = () => false
      for (const list of held.values()) {
        while (list.length) list.pop()!()
      }
      held.clear()
    },
    heldCount: (): number => [...held.values()].reduce((n, l) => n + l.length, 0),
  }
}

function doc(text: string, mtime: number): IndexedDoc {
  return { token: `${mtime}:${text.length}`, text, mtime, size: text.length }
}

function indexOf(notes: Record<string, IndexedDoc>, builtAt: number): StoredIndex {
  return { version: INDEX_VERSION, vault: VAULT, builtAt, notes }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/**
 * Two saves of one vault that overlap.
 *
 * `saveIndex` writes each shard and then the metadata record, which is the
 * commit marker: what that record says is what the index IS, because a load
 * reads the marker and then the shards it names. Two runs therefore race for
 * the marker, and before the saves of one vault were ordered the *older*
 * snapshot could commit last — dropping every note the newer run had added.
 * The note's own shard was still on disk; nothing pointed at it any more and
 * nothing reported it (`corruptShards` stays empty), so the only trace was a
 * content search that no longer covered that note.
 */
describe('saveIndex under two overlapping writers', () => {
  it('the newer index is the one the commit marker describes', async () => {
    const g = gatedStorage()

    // A: the state at the time note1 changed — note1 only.
    const indexA = indexOf({ '/vault/note1.md': doc('one', 1) }, 1)
    // B: the state when note2 changed a moment later — both notes.
    const indexB = indexOf(
      { '/vault/note1.md': doc('one', 1), '/vault/note2.md': doc('two', 2) },
      2,
    )

    g.holdCommitMarker()
    const pA = saveIndex(indexA, g.storage)
    await tick()
    expect(g.heldCount()).toBeGreaterThan(0) // A really is parked on the marker

    const pB = saveIndex(indexB, g.storage)
    await tick()
    g.release()
    await Promise.all([pA, pB])

    const loaded = await loadIndex(VAULT, g.storage)
    expect(Object.keys(loaded?.notes ?? {}).sort()).toEqual([
      '/vault/note1.md',
      '/vault/note2.md',
    ])
    expect(loaded?.corruptShards ?? []).toEqual([])
  })

  it('commits the notes as they are when the write runs, not as they were when it was asked for', async () => {
    const g = gatedStorage()
    // One index object, mutated in place between two saves — what the caller
    // does on every fs event (`upsert` writes into the live mirror and saves it).
    const live = indexOf({ '/vault/note1.md': doc('one', 1) }, 1)

    g.holdCommitMarker()
    const first = saveIndex(live, g.storage)
    live.notes['/vault/note2.md'] = doc('two', 2)
    const second = saveIndex(live, g.storage)
    await tick()
    g.release()
    await Promise.all([first, second])

    const loaded = await loadIndex(VAULT, g.storage)
    expect(Object.keys(loaded?.notes ?? {}).sort()).toEqual([
      '/vault/note1.md',
      '/vault/note2.md',
    ])
  })

  it('puts a clear after the save it was issued beside, not inside it', async () => {
    const g = gatedStorage()
    const index = indexOf({ '/vault/note1.md': doc('one', 1) }, 1)

    // A rebuild starts by dropping the persisted index (`reset`/`rebuild` call
    // clear without awaiting it), and a save issued a moment earlier may still
    // be writing. Unordered, the two interleave and the save's marker can be
    // the last write standing — over a store the clear already emptied, so the
    // index the rebuild dropped is back. The order of the storage effects IS
    // the property under test, so it is what is asserted.
    const save = saveIndex(index, g.storage)
    const clear = clearIndex(VAULT, g.storage)
    await Promise.all([save, clear])

    // The save's own atomic writes remove their `.tmp` staging key, so the
    // clear is the first removal of a key that is not one of those.
    const lastSet = g.ops.reduce((last, op, i) => (op.startsWith('set:') ? i : last), -1)
    const firstClear = g.ops.findIndex((op) => op.startsWith('remove:') && !op.endsWith('.tmp'))
    expect(g.ops[lastSet].endsWith('.meta')).toBe(true)
    expect(firstClear).toBeGreaterThan(lastSet)
    expect(await loadIndex(VAULT, g.storage)).toBeNull()
  })
})

/**
 * What the user sees after the drop, and what repairs it.
 *
 * Nothing in the running session reads the persisted marker: content search
 * answers from the in-memory mirror, and the index status comes from the build
 * state machine, so the loss is invisible until the vault is opened again. The
 * incremental build is what repairs it: it walks the vault's file list and
 * re-reads every path the loaded index has no entry for, so a note that is
 * missing from the marker is re-indexed — and the rebuilt index is saved — on
 * the next open.
 */
describe('the index heals at the next open, not at the next search', () => {
  it('an incremental build re-adds a note the committed marker left out', async () => {
    const g = gatedStorage()
    // The state a lost race leaves behind: the marker names note1's shard only,
    // while note2's shard file is on disk and unreachable.
    await saveIndex(indexOf({ '/vault/note1.md': doc('one', 1) }, 1), g.storage)
    await saveIndex(indexOf({ '/vault/note2.md': doc('two', 2) }, 2), g.storage)
    await saveIndex(indexOf({ '/vault/note1.md': doc('one', 1) }, 1), g.storage)

    const loaded = await loadIndex(VAULT, g.storage)
    expect(Object.keys(loaded?.notes ?? {})).toEqual(['/vault/note1.md'])

    // What `search.build` runs on the next vault open: the vault's whole file
    // list, against the index that was loaded.
    const paths = ['/vault/note1.md', '/vault/note2.md']
    const bodies: Record<string, string> = { '/vault/note1.md': 'one', '/vault/note2.md': 'two' }
    const built = await buildIndexIncremental(
      VAULT,
      paths,
      {
        stat: async () => ({ mtime: 1, size: 3 }),
        read: async (p) => bodies[p],
      },
      loaded,
    )

    expect(Object.keys(built.index.notes).sort()).toEqual([
      '/vault/note1.md',
      '/vault/note2.md',
    ])
    await saveIndex(built.index, g.storage)
    expect(
      Object.keys((await loadIndex(VAULT, g.storage))?.notes ?? {}).sort(),
    ).toEqual(['/vault/note1.md', '/vault/note2.md'])
  })
})
