import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createTabSave } from './tab-save'
import type { OpenTab } from './tabs'

function harness() {
  const tabs = ref<OpenTab[]>([{
    id: 'one', path: '/vault/a.md', content: 'v1', savedContent: 'old', dirty: true,
    pendingAssetPaths: [],
  }])
  const vault = ref<string | null>('/vault')
  let disk = 'old'
  let active = 0
  let peak = 0
  const writes: Array<{ content: string; resolve(): void; reject(): void }> = []
  const write = vi.fn((_vault: string, _path: string, content: string) => {
    active++
    peak = Math.max(peak, active)
    return new Promise<string | null>((resolve, reject) => {
      writes.push({
        content,
        resolve: () => { active--; disk = content; resolve(null) },
        reject: () => { active--; reject(new Error('disk full')) },
      })
    })
  })
  const save = createTabSave({
    tabs, vault, activeTab: computed(() => tabs.value[0]), settings: { maxHistory: 10 },
    files: {
      read: async () => disk, write, saveFileDialog: async () => null,
      createDir: async () => '', renameEntry: async () => '',
    },
    t: (key) => key, notifyError: vi.fn(), announce: vi.fn(),
  })
  const edit = (content: string) => {
    tabs.value[0].content = content
    tabs.value[0].dirty = true
    save.noteEdit('one')
  }
  return { tabs, vault, writes, save, edit, peak: () => peak }
}

describe('per-tab save serialization', () => {
  it('coalesces three waiters after an edit without overlapping writes', async () => {
    const h = harness()
    const first = h.save.saveTab('one')
    await vi.waitFor(() => expect(h.writes).toHaveLength(1))
    const waiting = [h.save.saveTab('one'), h.save.saveTab('one'), h.save.saveTab('one')]
    h.edit('v2')
    h.writes[0].resolve()
    await first
    await vi.waitFor(() => expect(h.writes.length).toBeGreaterThan(1))
    expect(h.writes.map((write) => write.content)).toEqual(['v1', 'v2'])
    expect(h.peak()).toBe(1)
    expect(h.save.stateOf('one')).toBe('saving')
    h.writes[1].resolve()
    expect(await Promise.all(waiting)).toEqual([true, true, true])
    expect(h.tabs.value[0].savedContent).toBe('v2')
    expect(h.save.stateOf('one')).toBe('saved')
  })

  it('propagates a failed write to every existing waiter, then permits a retry', async () => {
    const h = harness()
    const first = h.save.saveTab('one')
    await vi.waitFor(() => expect(h.writes).toHaveLength(1))
    const waiting = [h.save.saveTab('one'), h.save.saveTab('one')]
    h.edit('v2')
    h.writes[0].reject()
    expect(await Promise.all([first, ...waiting])).toEqual([false, false, false])
    expect(h.writes).toHaveLength(1)
    expect(h.save.stateOf('one')).toBe('failed')
    const retry = h.save.saveTab('one')
    await vi.waitFor(() => expect(h.writes).toHaveLength(2))
    h.writes[1].resolve()
    await expect(retry).resolves.toBe(true)
  })

  it('keeps newer waiters behind the second write and propagates its failure', async () => {
    const h = harness()
    const first = h.save.saveTab('one')
    await vi.waitFor(() => expect(h.writes).toHaveLength(1))
    const waiting = [h.save.saveTab('one'), h.save.saveTab('one')]
    h.edit('v2')
    h.writes[0].resolve()
    await first
    await vi.waitFor(() => expect(h.writes).toHaveLength(2))
    h.edit('v3')
    waiting.push(h.save.saveTab('one'))
    expect(h.save.stateOf('one')).toBe('saving')
    h.writes[1].reject()
    expect(await Promise.all(waiting)).toEqual([false, false, false])
    expect(h.writes).toHaveLength(2)
    expect(h.peak()).toBe(1)
    expect(h.tabs.value[0].content).toBe('v3')
    expect(h.tabs.value[0].savedContent).toBe('v1')
    expect(h.save.stateOf('one')).toBe('failed')
  })

  it('cancels waiting intents when the tab set resets', async () => {
    const h = harness()
    const first = h.save.saveTab('one')
    await vi.waitFor(() => expect(h.writes).toHaveLength(1))
    const waiting = [h.save.saveTab('one'), h.save.saveTab('one')]
    h.edit('v2')
    h.save.resetSaveBookkeeping()
    h.writes[0].resolve()
    await first
    await expect(Promise.all(waiting)).resolves.toEqual([false, false])
    expect(h.writes).toHaveLength(1)
  })

  it('does not carry waiting save intents across a vault change', async () => {
    const h = harness()
    const first = h.save.saveTab('one')
    await vi.waitFor(() => expect(h.writes).toHaveLength(1))
    const waiting = [h.save.saveTab('one'), h.save.saveTab('one')]
    h.edit('v2')
    h.vault.value = '/other'
    h.writes[0].resolve()
    await first
    await expect(Promise.all(waiting)).resolves.toEqual([false, false])
    expect(h.writes).toHaveLength(1)
  })

  it('does not redirect waiting saves to a replacement tab with the same id', async () => {
    const h = harness()
    const first = h.save.saveTab('one')
    await vi.waitFor(() => expect(h.writes).toHaveLength(1))
    const waiting = [h.save.saveTab('one'), h.save.saveTab('one')]
    h.tabs.value = [{ ...h.tabs.value[0], path: '/vault/b.md', content: 'replacement' }]
    h.writes[0].resolve()
    await first
    await expect(Promise.all(waiting)).resolves.toEqual([false, false])
    expect(h.writes).toHaveLength(1)
  })
})
