import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { registerLifecycleHook, setActiveEditor } from '@nekowite/plugin-host'
import type { PluginContext } from '@nekowite/plugin-host'
import { consumeSuppressReapply, shouldSuppressReapply } from '../services/suppressReapply'
import { useTabsStore } from './tabs'

const readMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())
vi.mock('../services/fs', () => ({ fsService: { read: readMock, write: writeMock, list: vi.fn(), watch: vi.fn() } }))

const ctx = { id: 'test', name: 'Test', insertComponent: () => {} } as PluginContext

describe('useTabsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    readMock.mockReset()
    writeMock.mockReset()
  })

  it('opens a tab and marks dirty on edit', async () => {
    readMock.mockResolvedValue('# hello')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    expect(s.tabs.length).toBe(1)
    expect(s.activeId).toBe(s.tabs[0].id)
    expect(readMock).toHaveBeenCalledWith('/vault', '/vault/a.md')
    s.tabs[0].content = '# changed'
    s.markDirty(s.tabs[0].id)
    expect(s.tabs[0].dirty).toBe(true)
  })

  it('does not read without a vault set', async () => {
    const s = useTabsStore()
    await s.openTab('/vault/a.md')
    expect(readMock).not.toHaveBeenCalled()
    expect(s.tabs.length).toBe(0)
  })
})

describe('save state indicator', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    readMock.mockReset()
    writeMock.mockReset()
  })

  it('reports saving while write is pending, then saved', async () => {
    let resolveWrite: () => void = () => {}
    writeMock.mockImplementation(() => new Promise<void>((r) => { resolveWrite = r }))
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    const pending = s.saveActive()
    expect(s.saveStateOf(tab.id)).toBe('saving')
    resolveWrite()
    await pending
    expect(s.saveStateOf(tab.id)).toBe('saved')
  })

  it('returns dirty after markDirty', async () => {
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    s.markDirty(tab.id)
    expect(s.saveStateOf(tab.id)).toBe('dirty')
  })

  it('falls back to dirty (not stuck saving) when the write fails', async () => {
    writeMock.mockRejectedValueOnce(new Error('disk full'))
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    s.markDirty(tab.id)
    await s.saveActive()
    expect(s.saveStateOf(tab.id)).toBe('dirty')
  })
})

describe('lifecycle broadcast from tabs store', () => {
  const unregister: Array<() => void> = []

  beforeEach(() => {
    setActivePinia(createPinia())
    readMock.mockReset()
    writeMock.mockReset()
  })

  afterEach(() => {
    for (const un of unregister.splice(0)) un()
    setActiveEditor(null)
    consumeSuppressReapply()
  })

  it('onSave rewrite changes what is written to disk', async () => {
    unregister.push(registerLifecycleHook('test', 'onSave', () => 'abc!', ctx))
    const s = useTabsStore()
    s.setVault('/vault')
    readMock.mockResolvedValue('abc')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    await s.saveActive()
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'abc!')
    expect(tab.content).toBe('abc!')
    expect(tab.savedContent).toBe('abc!')
  })

  it('onOpenDocument and onCloseTab are fired with the tab payload', async () => {
    const openSpy = vi.fn()
    const closeSpy = vi.fn()
    unregister.push(registerLifecycleHook('test', 'onOpenDocument', openSpy, ctx))
    unregister.push(registerLifecycleHook('test', 'onCloseTab', closeSpy, ctx))
    const s = useTabsStore()
    s.setVault('/vault')
    readMock.mockResolvedValue('# hello')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    expect(openSpy).toHaveBeenCalledWith(ctx, { id: tab.id, path: tab.path })
    s.closeTab(tab.id)
    expect(closeSpy).toHaveBeenCalledWith(ctx, { id: tab.id, path: tab.path })
  })

  it('onSaved is emitted after a successful write', async () => {
    const savedSpy = vi.fn()
    unregister.push(registerLifecycleHook('test', 'onSaved', savedSpy, ctx))
    const s = useTabsStore()
    s.setVault('/vault')
    readMock.mockResolvedValue('abc')
    await s.openTab('/vault/a.md')
    await s.saveActive()
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'abc')
    expect(savedSpy).toHaveBeenCalledWith(ctx, null, 'abc')
  })

  it('onSave and onSaved receive the active editor from setActiveEditor', async () => {
    const editor = { kind: 'test-editor' }
    setActiveEditor(editor)
    const saveSpy = vi.fn()
    const savedSpy = vi.fn()
    unregister.push(registerLifecycleHook('test', 'onSave', saveSpy, ctx))
    unregister.push(registerLifecycleHook('test', 'onSaved', savedSpy, ctx))
    const s = useTabsStore()
    s.setVault('/vault')
    readMock.mockResolvedValue('abc')
    await s.openTab('/vault/a.md')
    await s.saveActive()
    expect(saveSpy).toHaveBeenCalledWith(ctx, editor, 'abc')
    expect(savedSpy).toHaveBeenCalledWith(ctx, editor, 'abc')
  })

  it('rewritten save arms the suppress-reapply guard, consume-once clears it', async () => {
    unregister.push(registerLifecycleHook('test', 'onSave', () => 'abc!', ctx))
    const s = useTabsStore()
    s.setVault('/vault')
    readMock.mockResolvedValue('abc')
    await s.openTab('/vault/a.md')
    await s.saveActive()
    expect(shouldSuppressReapply()).toBe(true)
    expect(consumeSuppressReapply()).toBe(true)
    expect(shouldSuppressReapply()).toBe(false)
  })

  it('does not emit onSaved when the write fails', async () => {
    const savedSpy = vi.fn()
    unregister.push(registerLifecycleHook('test', 'onSaved', savedSpy, ctx))
    writeMock.mockRejectedValueOnce(new Error('disk full'))
    const s = useTabsStore()
    s.setVault('/vault')
    readMock.mockResolvedValue('abc')
    await s.openTab('/vault/a.md')
    await s.saveActive()
    expect(savedSpy).not.toHaveBeenCalled()
  })

  it('keeps content and dirty intact when a rewritten save fails', async () => {
    unregister.push(registerLifecycleHook('test', 'onSave', () => 'abc!', ctx))
    writeMock.mockRejectedValueOnce(new Error('disk full'))
    const s = useTabsStore()
    s.setVault('/vault')
    readMock.mockResolvedValue('abc')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    tab.dirty = true
    await s.saveActive()
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'abc!')
    expect(tab.content).toBe('abc')
    expect(tab.savedContent).toBe('abc')
    expect(tab.dirty).toBe(true)
  })
})
