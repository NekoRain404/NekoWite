import { describe, expect, it } from 'vitest'
import { createMemoryFsGateway } from './memory'

describe('memoryFsGateway', () => {
  it('reads and writes to an in-memory map', async () => {
    const fs = createMemoryFsGateway({ 'welcome.md': '# hi' })
    expect(await fs.read('memoir://demo', 'welcome.md')).toBe('# hi')
    await fs.write('memoir://demo', 'new.md', 'x')
    expect(await fs.read('memoir://demo', 'new.md')).toBe('x')
  })

  it('rejects reading a missing file', async () => {
    const fs = createMemoryFsGateway()
    await expect(fs.read('memoir://demo', 'nope.md')).rejects.toThrow(
      'No such file in demo vault: nope.md',
    )
  })

  it('lists a virtual directory tree', async () => {
    const fs = createMemoryFsGateway({
      'welcome.md': '# hi',
      'docs/a.md': 'a',
      'docs/sub/b.md': 'b',
    })
    const root = await fs.list('memoir://demo', '.')
    const names = root.map((e) => e.name)
    expect(names).toContain('welcome.md')
    expect(names).toContain('docs')
    const docs = await fs.list('memoir://demo', 'docs')
    expect(docs.map((e) => e.name)).toEqual(['sub', 'a.md'])
  })

  it('treats the vault root path as the root dir', async () => {
    const fs = createMemoryFsGateway({ 'welcome.md': '# hi' })
    const root = await fs.list('memoir://demo', 'memoir://demo')
    expect(root.map((e) => e.name)).toContain('welcome.md')
  })

  it('openFolderDialog returns the demo root', async () => {
    const fs = createMemoryFsGateway()
    expect(await fs.openFolderDialog()).toBe('memoir://demo')
  })

  it('seeds welcome.md by default', async () => {
    const fs = createMemoryFsGateway()
    expect(await fs.read('memoir://demo', 'welcome.md')).toContain(
      '# Welcome to NekoWite (demo)',
    )
  })
})
