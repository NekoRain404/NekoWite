import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createTabFileOperations } from './tab-file-operations'
import type { OpenTab } from './tabs'

function harness() {
  const tabs = ref<OpenTab[]>([{
    id: 'one', path: '/vault/a.md', content: 'saved', savedContent: 'saved',
    dirty: false, pendingAssetPaths: [],
  }])
  const vault = ref<string | null>('/vault')
  let revision = 0
  let finish!: (value: string) => void
  let fail!: (error: Error) => void
  const deletion = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject })
  const cancelAutosave = vi.fn()
  const notifyError = vi.fn()
  const deleteFile = vi.fn(() => deletion)
  const operations = createTabFileOperations({
    tabs, vault, files: { read: async () => '', stat: async () => ({}), deleteFile },
    t: (key) => key, notifyError, cancelAutosave, noteSelfWrite: vi.fn(),
    revisionOf: () => revision,
    removeTab: (id) => { tabs.value = tabs.value.filter((tab) => tab.id !== id) },
  })
  return { tabs, vault, operations, finish, fail, cancelAutosave, notifyError, deleteFile,
    edit: () => { revision++; tabs.value[0].dirty = true } }
}

describe('delete completion ownership', () => {
  it('preserves edits made while deletion is pending as an untitled buffer', async () => {
    const h = harness()
    const pending = h.operations.deleteTabFile('one')
    h.tabs.value[0].content = 'new unsaved text'
    h.edit()
    h.finish('trash')
    await pending
    expect(h.tabs.value).toHaveLength(1)
    expect(h.tabs.value[0]).toMatchObject({ path: null, content: 'new unsaved text', dirty: true, savedContent: '' })
    expect(h.cancelAutosave).toHaveBeenCalledWith('one')
  })

  it('keeps keystrokes whose publish is still pending even if the tab was already dirty', async () => {
    const h = harness()
    h.edit()
    const pending = h.operations.deleteTabFile('one')
    h.edit()
    h.finish('trash')
    await pending
    expect(h.tabs.value).toHaveLength(1)
    expect(h.tabs.value[0].path).toBeNull()
  })

  it('does not close a replacement tab at the same path', async () => {
    const h = harness()
    const pending = h.operations.deleteTabFile('one')
    h.tabs.value = [{ ...h.tabs.value[0], id: 'replacement', content: 'new draft', dirty: true }]
    h.finish('trash')
    await pending
    expect(h.tabs.value).toHaveLength(1)
    expect(h.tabs.value[0]).toMatchObject({ id: 'replacement', path: null, content: 'new draft', dirty: true })
  })

  it('does not detach or close tabs after a vault switch', async () => {
    const h = harness()
    const pending = h.operations.deleteTabFile('one')
    h.vault.value = '/other'
    h.tabs.value = [{ ...h.tabs.value[0], id: 'other' }]
    h.finish('trash')
    await pending
    expect(h.tabs.value[0]).toMatchObject({ id: 'other', path: '/vault/a.md' })
  })

  it('leaves a renamed tab at its new path', async () => {
    const h = harness()
    const pending = h.operations.deleteTabFile('one')
    h.operations.retargetAfterRename('/vault/a.md', '/vault/b.md')
    h.finish('trash')
    await pending
    expect(h.tabs.value[0].path).toBe('/vault/b.md')
  })

  it('keeps the original tab and path if deletion fails', async () => {
    const h = harness()
    const pending = h.operations.deleteTabFile('one')
    await vi.waitFor(() => expect(h.deleteFile).toHaveBeenCalled())
    h.fail(new Error('permission denied'))
    await pending
    expect(h.tabs.value[0].path).toBe('/vault/a.md')
    expect(h.notifyError).toHaveBeenCalledWith('tabs.deleteFailed')
  })

  it('still closes unchanged original tabs after successful deletion', async () => {
    const h = harness()
    h.tabs.value.push({ ...h.tabs.value[0], id: 'two' })
    const pending = h.operations.deleteTabFile('one')
    h.finish('trash')
    await pending
    expect(h.tabs.value).toEqual([])
  })
})
