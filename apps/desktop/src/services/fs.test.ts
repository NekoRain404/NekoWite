import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { fsService } from './fs'

describe('fsService', () => {
  beforeEach(() => invokeMock.mockReset())

  it('reads a file', async () => {
    invokeMock.mockResolvedValue('# hi')
    await expect(fsService.read('/vault', 'a.md')).resolves.toBe('# hi')
    expect(invokeMock).toHaveBeenCalledWith('read_file', { vault_root: '/vault', path: 'a.md' })
  })

  it('lists a directory', async () => {
    invokeMock.mockResolvedValue([{ name: 'b.md', path: '/vault/b.md', is_dir: false, is_mdx: true }])
    const out = await fsService.list('/vault', '.')
    expect(out[0].name).toBe('b.md')
    expect(invokeMock).toHaveBeenCalledWith('list_dir', { vault_root: '/vault', path: '.' })
  })
})