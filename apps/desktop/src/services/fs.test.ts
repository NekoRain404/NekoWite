import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { fsService } from './fs'

describe('fsService', () => {
  beforeEach(() => invokeMock.mockReset())

  it('reads a file', async () => {
    invokeMock.mockResolvedValue('# hi')
    await expect(fsService.read('a.md')).resolves.toBe('# hi')
    expect(invokeMock).toHaveBeenCalledWith('read_file', { path: 'a.md' })
  })

  it('lists a directory', async () => {
    invokeMock.mockResolvedValue([{ name: 'b.md', path: 'b.md', is_dir: false, is_mdx: true }])
    const out = await fsService.list('.')
    expect(out[0].name).toBe('b.md')
    expect(invokeMock).toHaveBeenCalledWith('list_dir', { path: '.' })
  })
})