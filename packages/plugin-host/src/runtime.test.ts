import { describe, expect, it, beforeEach, vi } from 'vitest'
import { activatePlugin, deactivatePlugin } from './runtime'
import { emitLifecycle } from './lifecycle'
import { getCommand, getComponent, getToolbar, registerCommand, unregisterCommand, unregisterComponent, unregisterToolbar } from '@nekowite/editor-core'
import type { PluginDefinition, PluginMeta } from './types'

const META = (id: string): PluginMeta => ({ id, name: id, version: '1', main: 'x' })

const ok = (id: string, definition: PluginDefinition) => ({ ok: true as const, id, meta: META(id), definition })

beforeEach(() => {
  unregisterCommand('p1.cmd')
  unregisterCommand('bad.cmd')
  unregisterCommand('deact.cmd')
  unregisterCommand('pre.cmd')
  unregisterCommand('dup.cmd')
  unregisterComponent('Callout')
  unregisterComponent('DeactComp')
  unregisterToolbar('p1.toolbar')
  unregisterToolbar('deact.toolbar')
  unregisterToolbar('dup.toolbar')
  deactivatePlugin('p1')
  deactivatePlugin('bad')
  deactivatePlugin('deact')
  deactivatePlugin('dupbad')
})

describe('activatePlugin', () => {
  it('registers commands and components', async () => {
    const run = () => {}
    const res = await activatePlugin(
      ok('p1', { components: { Callout: {} as never }, commands: [{ id: 'p1.cmd', run }], toolbar: [{ id: 'p1.toolbar', label: 'T', run }] }),
    )
    expect(res.ok).toBe(true)
    expect(getCommand('p1.cmd')?.run).toBe(run)
    expect(getComponent('Callout')).toBeDefined()
    expect(getToolbar().some((t) => t.id === 'p1.toolbar')).toBe(true)
  })

  it('returns ok:false for a failed LoadResult', async () => {
    const res = await activatePlugin({ ok: false as const, id: 'p1', error: 'load failed' })
    expect(res).toEqual({ ok: false, id: 'p1', error: 'load failed' })
  })

  it('rolls back registration when onLoad throws', async () => {
    const res = await activatePlugin(
      ok('bad', {
        commands: [{ id: 'bad.cmd', run: () => {} }],
        onLoad: () => {
          throw new Error('boom')
        },
      }),
    )
    expect(res.ok).toBe(false)
    expect((res as { error?: string }).error).toBe('boom')
    expect(getCommand('bad.cmd')).toBeUndefined()
  })

  it('rolls back all registrations when a duplicate registration throws', async () => {
    const run = () => {}
    registerCommand({ id: 'dup.cmd', run })
    const res = await activatePlugin(
      ok('dupbad', {
        components: { Callout: {} as never },
        commands: [
          { id: 'pre.cmd', run },
          { id: 'dup.cmd', run },
        ],
        toolbar: [{ id: 'dup.toolbar', label: 'T', run }],
      }),
    )
    expect(res.ok).toBe(false)
    expect(getCommand('pre.cmd')).toBeUndefined()
    expect(getComponent('Callout')).toBeUndefined()
    expect(getToolbar().some((t) => t.id === 'dup.toolbar')).toBe(false)
    expect(getCommand('dup.cmd')).toBeDefined()
  })

  it('does not throw when activation fails (isolation)', async () => {
    const res = await activatePlugin(
      ok('bad', {
        onLoad: () => {
          throw new Error('boom')
        },
      }),
    )
    expect(res.ok).toBe(false)
  })
})

describe('deactivatePlugin', () => {
  it('removes what was registered', async () => {
    const run = () => {}
    await activatePlugin(
      ok('deact', {
        components: { DeactComp: {} as never },
        commands: [{ id: 'deact.cmd', run }],
        toolbar: [{ id: 'deact.toolbar', label: 'T', run }],
      }),
    )
    expect(getCommand('deact.cmd')).toBeDefined()
    deactivatePlugin('deact')
    expect(getCommand('deact.cmd')).toBeUndefined()
    expect(getComponent('DeactComp')).toBeUndefined()
    expect(getToolbar().some((t) => t.id === 'deact.toolbar')).toBe(false)
  })

  it('is a no-op for an inactive id', () => {
    expect(() => deactivatePlugin('nope')).not.toThrow()
  })

  it('calls onUnload on deactivate', async () => {
    const unload = { called: false }
    const run = () => {}
    await activatePlugin(
      ok('deact', {
        commands: [{ id: 'deact.cmd', run }],
        onUnload: () => {
          unload.called = true
        },
      }),
    )
    deactivatePlugin('deact')
    expect(unload.called).toBe(true)
  })

  it('registers lifecycle hooks on activate and removes them (and their unlisten) on deactivate', async () => {
    const hook = vi.fn()
    const unlisten = vi.fn()
    await activatePlugin(
      ok('p1', {
        onDocChange: (ctx, e) => {
          hook(ctx, e)
          return unlisten
        },
      }),
    )
    expect(emitLifecycle('onDocChange', { doc: 'x' })).toBeUndefined()
    expect(hook).toHaveBeenCalledTimes(1)
    deactivatePlugin('p1')
    expect(unlisten).toHaveBeenCalledTimes(1)
    emitLifecycle('onDocChange', { doc: 'y' })
    expect(hook).toHaveBeenCalledTimes(1)
  })
})