/**
 * A slow save must not be read back as somebody else's edit.
 *
 * The two real modules meet here: the write path that claims the file
 * (`stores/tab-save.ts`) and the watcher handler that decides whether a reported
 * change is ours (`services/external-doc-sync.ts`). The claim used to be a fixed
 * 2 s from the START of the write, so a write that ran longer fell out of it
 * while `tab.savedContent` still held the pre-save text — and the app then read
 * its own echo as an external edit. On a dirty tab that is a keep-or-reload
 * prompt about a change the app made itself, and its "use the disk version"
 * answer is the one reload allowed to overwrite unsaved work.
 *
 * `external-doc-sync.test.ts` covers the decision table with `isSelfWrite`
 * stubbed; this file covers the claim itself, driving the real one.
 */

import { describe, expect, it, vi } from 'vitest'
import { ref, computed } from 'vue'
import { createTabSave } from '../stores/tab-save'
import { createExternalDocSync } from './external-doc-sync'
import type { OpenTab } from '../stores/tabs'

interface Harness {
  save: ReturnType<typeof createTabSave>
  tab: OpenTab
  written: string[]
  disk: { value: string }
  releaseWrite(): void
  advance(ms: number): void
  deliver(): Promise<void>
  /** Hold the watcher's next read open, so a test can move the world inside it
   *  (a save settling, a keystroke) before the bytes are handed back. */
  holdNextRead(): void
  releaseRead(): void
  settle(): Promise<void>
  conflicts: Array<{ tabId: string; path: string }>
  reloads: string[]
}

/** `savedContent` is what the PREVIOUS save wrote, and the tab holds newer text
 *  — so the write's bytes are not the bytes the tab already agrees are on disk.
 *  That is what makes the claim load-bearing: with the two equal, the content
 *  comparison in `external-doc-sync` would answer for it and the claim would
 *  never be exercised. */
const ON_DISK = 'what the last save wrote'
const IN_TAB = 'what the user has written since, being saved now'

function harness(dirty: boolean, opts: { failWrite?: boolean } = {}): Harness {
  let clock = 1_000_000
  const tab: OpenTab = {
    id: 'tab-1',
    path: '/vault/a.md',
    content: IN_TAB,
    savedContent: ON_DISK,
    dirty,
    pendingAssetPaths: [],
  }
  const tabs = ref<OpenTab[]>([tab])
  const vault = ref<string | null>('/vault')
  const written: string[] = []
  let release: () => void = () => {}
  const disk = { value: ON_DISK }

  const save = createTabSave({
    tabs,
    activeTab: computed(() => tabs.value[0] ?? null),
    vault,
    settings: { maxHistory: 10 },
    files: {
      // The same one-value disk the sync above reads and `commitWrite` moves. A
      // save reads the file before it writes (L05's save-time half), and this
      // harness is the one place the real write path and the real watcher
      // handler meet, so the read has to answer the disk rather than nothing:
      // the save in `harness(true)` starts from a file that agrees with
      // `savedContent` (ON_DISK), which is what lets the claim be what is under
      // test here.
      read: async () => disk.value,
      write: (_v, _p, content: string) =>
        new Promise<string | null>((resolve, reject) => {
          written.push(content)
          release = () => (opts.failWrite ? reject(new Error('disk full')) : resolve(null))
        }),
      saveFileDialog: async () => null,
      createDir: async () => '',
      renameEntry: async () => '',
    },
    t: (k: string) => k,
    notifyError: () => {},
    announce: () => {},
    now: () => clock,
  })

  const conflicts: Array<{ tabId: string; path: string }> = []
  const reloads: string[] = []
  let deliver: (() => void) | null = null
  let holding = false
  let openGate: (() => void) | null = null
  const sync = createExternalDocSync({
    // The watcher's read, and only the watcher's: the save path reads the same
    // disk through its own port, so holding this one open does not stall the
    // write whose race is under test.
    read: async () => {
      if (holding) {
        holding = false
        await new Promise<void>((resolve) => { openGate = resolve })
      }
      return disk.value
    },
    onFsChange: async (cb) => {
      deliver = () => cb({ path: '/vault/a.md', kind: 'modified' })
      return () => {
        deliver = null
      }
    },
    getVault: () => vault.value,
    getOpenTabs: () => tabs.value.map((t) => ({
      id: t.id,
      path: t.path,
      dirty: t.dirty,
      savedContent: t.savedContent,
    })),
    isSelfWrite: (path, contents) => save.isSelfWrite(path, contents),
    isPendingMove: () => false,
    reload: async (id) => {
      reloads.push(id)
    },
    onConflict: (req) => conflicts.push(req),
    onMissing: () => {},
  })

  return {
    save,
    tab,
    written,
    disk,
    releaseWrite: () => release(),
    advance: (ms) => {
      clock += ms
    },
    deliver: async () => {
      await sync.start()
      deliver?.()
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    },
    holdNextRead: () => {
      holding = true
    },
    releaseRead: () => {
      openGate?.()
      openGate = null
    },
    settle: async () => {
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    },
    conflicts,
    reloads,
  }
}

/** The bytes the save put on disk, as the filesystem would now report them. */
function commitWrite(h: Harness): void {
  h.disk.value = h.written[h.written.length - 1]
}

describe('the save echo of a write that outlives its claim', () => {
  it('is not mistaken for an external edit, however long the write took', async () => {
    const h = harness(true)
    const saving = h.save.saveTab('tab-1')
    await vi.waitFor(() => expect(h.written).toEqual([IN_TAB]))

    // The file lands on disk while the invoke is still open...
    commitWrite(h)
    // ...and the write takes far longer than any fixed window would allow.
    h.advance(60_000)

    await h.deliver()
    expect(h.conflicts).toEqual([])
    expect(h.reloads).toEqual([])

    h.releaseWrite()
    await saving
  })

  it('is still recognised after the write settles', async () => {
    const h = harness(true)
    const saving = h.save.saveTab('tab-1')
    await vi.waitFor(() => expect(h.written).toEqual([IN_TAB]))
    commitWrite(h)
    h.releaseWrite()
    await saving

    // The claim is gone by now — identification is by content, because the tab
    // now records what was written. A late echo is still ours.
    await h.deliver()
    expect(h.conflicts).toEqual([])
    expect(h.reloads).toEqual([])
  })

  it('does not swallow an external edit that lands while we are writing', async () => {
    const h = harness(true)
    const saving = h.save.saveTab('tab-1')
    await vi.waitFor(() => expect(h.written).toEqual([IN_TAB]))

    // Somebody else rewrote the file while our write was in flight. Their bytes
    // are not ours, and the tab's `savedContent` is still the pre-save text, so
    // this is a real conflict and has to be reported.
    h.disk.value = 'their text'
    await h.deliver()
    expect(h.conflicts).toEqual([{ tabId: 'tab-1', path: '/vault/a.md' }])

    h.releaseWrite()
    await saving
  })

  it('is not read back as somebody else\'s edit when the write settles mid-read', async () => {
    // The window neither guard covers on its own. The event arrives while the
    // write is still in flight and is read AFTER it has settled: by then the
    // claim is released (so `isSelfWrite` says no) and the tab has recorded what
    // it wrote (so the bytes read are not the ones a handler that took its copy
    // before the read is comparing against). Both lookups miss by one time
    // slice, and what the user got was the keep-or-reload dialog raised by the
    // app's own autosave — on a tab with nothing unsaved, with the status line
    // beside it reading "saved".
    const h = harness(true)
    const saving = h.save.saveTab('tab-1')
    await vi.waitFor(() => expect(h.written).toEqual([IN_TAB]))

    // Our bytes are on disk and the watcher is reading them back...
    commitWrite(h)
    h.holdNextRead()
    await h.deliver()

    // ...and while that read is open the write settles: the claim goes, the tab
    // records the bytes it wrote, and it stops being dirty.
    h.releaseWrite()
    await saving
    h.releaseRead()
    await h.settle()

    expect(h.conflicts).toEqual([])
    expect(h.reloads).toEqual([])
  })

  it('still reports a real external edit that lands right after the save', async () => {
    const h = harness(false)
    const saving = h.save.saveTab('tab-1')
    await vi.waitFor(() => expect(h.written).toEqual([IN_TAB]))
    commitWrite(h)
    h.releaseWrite()
    await saving

    // No pause between our save and their write. The claim is gone and the tab
    // is clean, so nothing about this is ours — and a rule that ignored events
    // for a while after a save would swallow exactly this one, leaving the
    // editor showing text the file no longer has.
    h.disk.value = 'their text'
    await h.deliver()

    expect(h.reloads).toEqual(['tab-1'])
    expect(h.conflicts).toEqual([])
  })

  it('still asks when their edit lands right after a save the user typed across', async () => {
    const h = harness(true)
    const saving = h.save.saveTab('tab-1')
    await vi.waitFor(() => expect(h.written).toEqual([IN_TAB]))
    // A keystroke while the write ran. The tab stays dirty when it lands,
    // because what is on disk is not what the user is looking at.
    h.save.noteEdit('tab-1')
    commitWrite(h)
    h.releaseWrite()
    await saving
    expect(h.tab.dirty).toBe(true)

    h.disk.value = 'their text'
    await h.deliver()

    expect(h.conflicts).toEqual([{ tabId: 'tab-1', path: '/vault/a.md' }])
    expect(h.reloads).toEqual([])
  })

  it('does not let a failed write keep claiming the path', async () => {
    const h = harness(true, { failWrite: true })
    const saving = h.save.saveTab('tab-1')
    await vi.waitFor(() => expect(h.written).toEqual([IN_TAB]))

    h.releaseWrite()
    await saving

    // The write did not land, so nothing claims the path any more: a change
    // reported for it now is somebody else's and has to reach the conflict
    // decision rather than being swallowed.
    h.disk.value = 'their text'
    await h.deliver()
    expect(h.conflicts).toEqual([{ tabId: 'tab-1', path: '/vault/a.md' }])
  })
})
