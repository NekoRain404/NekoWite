import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the Tauri IPC entry: capture the exact arg objects the adapter passes.
// @tauri-apps/api forwards args VERBATIM to the Rust #[tauri::command], whose
// parameters are snake_case (rename_all = "snake_case"). A camelCase key makes
// the invoke reject and silently breaks e.g. image save/display in the REAL
// WebView (browser E2E passes because the memory gateway ignores arg names).
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
  convertFileSrc: vi.fn((p: string) => `asset://${p}`),
}))

import { invoke } from '@tauri-apps/api/core'
import { tauriFsPort } from './tauri'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockResolvedValue(undefined as never)
})

describe('tauri gateway arg names (must equal the Rust snake_case params)', () => {
  it('saveAttachment sends file_name (not fileName)', async () => {
    mockedInvoke.mockResolvedValue('attachments/2026-09/a.png' as never)
    await tauriFsPort.saveAttachment('/vault', 'a.png', 'QUJD', 'attachments/x')
    expect(mockedInvoke).toHaveBeenCalledWith('save_attachment', {
      vault: '/vault',
      file_name: 'a.png',
      base64: 'QUJD',
      dir: 'attachments/x',
    })
  })

  it('resolveMediaPath sends rel_path (not relPath) and convertFileSrcs the result', async () => {
    mockedInvoke.mockResolvedValue('/abs/pic.png' as never)
    const url = await tauriFsPort.resolveMediaPath('/vault', 'attachments/pic.png')
    expect(mockedInvoke).toHaveBeenCalledWith('resolve_media_path', {
      vault: '/vault',
      rel_path: 'attachments/pic.png',
    })
    expect(url).toBe('asset:///abs/pic.png')
  })

  it('read / list / history use vault_root (snake_case) consistently', async () => {
    mockedInvoke.mockResolvedValue([] as never)
    await tauriFsPort.read('/vault', 'a.md')
    expect(mockedInvoke).toHaveBeenCalledWith('read_file', { vault_root: '/vault', path: 'a.md' })
    await tauriFsPort.listHistory('/vault', 'a.md')
    expect(mockedInvoke).toHaveBeenCalledWith('list_history', { vault_root: '/vault', path: 'a.md' })
  })

  it('create_dir / rename_entry use the exact Rust param names', async () => {
    mockedInvoke.mockResolvedValue('notes' as never)
    await tauriFsPort.createDir('/vault', 'notes')
    expect(mockedInvoke).toHaveBeenCalledWith('create_dir', { vault: '/vault', path: 'notes' })
    await tauriFsPort.renameEntry('/vault', 'a.md', 'b.md')
    expect(mockedInvoke).toHaveBeenCalledWith('rename_entry', {
      vault: '/vault',
      from: 'a.md',
      to: 'b.md',
    })
  })
})
