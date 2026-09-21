import { describe, expect, it, vi } from 'vitest'
import { createFileOpsArea } from './memory-file-ops'
import { tauriFsPort } from './tauri'

const invoke = vi.hoisted(() => vi.fn(async () => null))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('filesystem write preconditions', () => {
  it('forwards expected bytes through IPC, including an empty file', async () => {
    await tauriFsPort.write('/vault', 'a.md', 'new', 10, '')
    expect(invoke).toHaveBeenCalledWith('write_file', {
      vault_root: '/vault', path: 'a.md', content: 'new', max_history: 10,
      expected_content: '',
    })
  })

  it.each([undefined, 'external'])('rejects stale memory writes when current bytes are %s', async (old) => {
    const files = new Map<string, string>()
    if (old !== undefined) files.set('a.md', old)
    const snapshot = vi.fn()
    const port = createFileOpsArea({ files, snapshot, virtualDirs: new Set(), modified: new Map() })
    await expect(port.write('/vault', 'a.md', 'local', 10, 'expected')).rejects.toThrow()
    expect(files.get('a.md')).toBe(old)
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('accepts matching empty bytes and explicit creation without a guard', async () => {
    const files = new Map([['a.md', '']])
    const port = createFileOpsArea({ files, snapshot: vi.fn(), virtualDirs: new Set(), modified: new Map() })
    await port.write('/vault', 'a.md', 'local', 10, '')
    await port.write('/vault', 'b.md', 'created')
    expect(files.get('a.md')).toBe('local')
    expect(files.get('b.md')).toBe('created')
  })
})
