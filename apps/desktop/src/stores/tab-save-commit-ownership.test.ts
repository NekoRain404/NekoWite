import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createTabSave } from './tab-save'
import type { OpenTab } from './tabs'

function harness() {
  const tabs = ref<OpenTab[]>([{
    id: 'one', path: '/vault/a.md', content: 'local', savedContent: 'old',
    dirty: true, pendingAssetPaths: [],
  }])
  const vault = ref<string | null>('/vault')
  const read = vi.fn(async () => 'old')
  let finish!: (warning: string | null) => void
  const write = vi.fn(() => new Promise<string | null>((resolve) => { finish = resolve }))
  const announce = vi.fn()
  const save = createTabSave({
    tabs, vault, activeTab: computed(() => tabs.value[0]), settings: { maxHistory: 10 },
    files: { read, write, saveFileDialog: async () => null,
      createDir: async () => '', renameEntry: async () => '' },
    t: (key) => key, notifyError: vi.fn(), announce,
  })
  return { tabs, vault, read, write, announce, save, finish: () => finish(null) }
}

describe('save commit preconditions and ownership', () => {
  it('passes the observed disk bytes to the commit, not the edited bytes', async () => {
    const h = harness()
    const saving = h.save.saveTab('one')
    await vi.waitFor(() => expect(h.write).toHaveBeenCalled())
    h.finish()
    await saving
    expect(h.write).toHaveBeenCalledWith('/vault', '/vault/a.md', 'local', 10, 'old')
  })

  it('guards an explicitly acknowledged overwrite with the acknowledged disk bytes', async () => {
    const h = harness()
    h.read.mockResolvedValue('external')
    h.tabs.value[0].externalConflict = { disk: 'external', answer: 'keep-local' }
    const saving = h.save.saveTab('one')
    await vi.waitFor(() => expect(h.write).toHaveBeenCalled())
    h.finish()
    await saving
    expect(h.write).toHaveBeenCalledWith('/vault', '/vault/a.md', 'local', 10, 'external')
  })

  it.each(['detach', 'rename', 'replace', 'vault'] as const)(
    'does not mark stale work clean after %s during the write', async (change) => {
      const h = harness()
      const original = h.tabs.value[0]
      const saving = h.save.saveTab('one')
      await vi.waitFor(() => expect(h.write).toHaveBeenCalled())
      if (change === 'detach') original.path = null
      if (change === 'rename') original.path = '/vault/b.md'
      if (change === 'replace') h.tabs.value = [{ ...original }]
      if (change === 'vault') h.vault.value = '/other'
      h.finish()
      await saving
      expect(original.dirty).toBe(true)
      expect(original.savedContent).toBe('old')
      expect(h.announce).not.toHaveBeenCalled()
    },
  )

  it('does not submit a write after replacement during the preflight read', async () => {
    const h = harness()
    h.read.mockImplementation(async () => {
      h.tabs.value = [{ ...h.tabs.value[0] }]
      return 'old'
    })
    const saving = h.save.saveTab('one')
    await vi.waitFor(() => expect(h.read).toHaveBeenCalled())
    // Allow the old implementation to finish rather than leave a pending test.
    await Promise.resolve()
    if (h.write.mock.calls.length) h.finish()
    expect(await saving).toBe(false)
    expect(h.write).not.toHaveBeenCalled()
  })
})
