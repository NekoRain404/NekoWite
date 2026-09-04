import { describe, expect, it, vi } from 'vitest'
import { emitLifecycle, getActiveEditor, hasLifecycleListeners, onLifecycleError, registerLifecycleHook, setActiveEditor } from './lifecycle'
import type { LifecycleErrorEvent } from './lifecycle'
import type { PluginContext } from './types'
import { PluginError } from './types'

const ctx = { id: 'p1', name: 'P1', insertComponent: () => {} } as PluginContext

describe('lifecycle hooks', () => {
  it('emitLifecycle calls registered hooks in order with ctx', () => {
    const a = vi.fn()
    const b = vi.fn()
    registerLifecycleHook('p1', 'onDocChange', a, ctx)
    registerLifecycleHook('p2', 'onDocChange', b, ctx)
    emitLifecycle('onDocChange', { doc: 'x' })
    expect(a).toHaveBeenCalledWith(ctx, { doc: 'x' })
    expect(b).toHaveBeenCalledWith(ctx, { doc: 'x' })
  })

  it('isolation: a throwing hook does not block others', () => {
    const boom = vi.fn(() => {
      throw new Error('boom')
    })
    const ok = vi.fn()
    registerLifecycleHook('p1', 'onSaved', boom, ctx)
    registerLifecycleHook('p2', 'onSaved', ok, ctx)
    expect(() => emitLifecycle('onSaved', null, 'c')).not.toThrow()
    expect(ok).toHaveBeenCalled()
  })

  it('surfaces a thrown hook through onLifecycleError without blocking others', () => {
    const events: LifecycleErrorEvent[] = []
    const off = onLifecycleError((e) => events.push(e))
    const boom = vi.fn(() => {
      throw new Error('boom')
    })
    const ok = vi.fn()
    registerLifecycleHook('p1', 'onDocChange', boom, ctx)
    registerLifecycleHook('p2', 'onDocChange', ok, ctx)
    expect(() => emitLifecycle('onDocChange', { doc: 'x' })).not.toThrow()
    expect(ok).toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect(events[0].pluginId).toBe('p1')
    expect(events[0].event).toBe('onDocChange')
    expect(events[0].error).toBeInstanceOf(PluginError)
    expect(events[0].error.code).toBe('PLUGIN_HOOK_ERROR')
    expect(events[0].error.pluginId).toBe('p1')
    expect(events[0].error.recovery).toContain('Disable the plugin')
    off()
  })

  it('a throwing error subscriber does not break delivery to later subscribers', () => {
    const events: LifecycleErrorEvent[] = []
    const bad = onLifecycleError(() => {
      throw new Error('subscriber boom')
    })
    const good = onLifecycleError((e) => events.push(e))
    registerLifecycleHook('p1', 'onSave', () => {
      throw new Error('hook boom')
    }, ctx)
    expect(() => emitLifecycle('onSave', null, 'c')).not.toThrow()
    expect(events).toHaveLength(1)
    bad()
    good()
  })

  it('unregister removes the hook', () => {
    const fn = vi.fn()
    const un = registerLifecycleHook('p1', 'onOpenDocument', fn, ctx)
    un()
    emitLifecycle('onOpenDocument', { id: 't1' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('onSave hooks chain: each hook receives the previous hook output', () => {
    const unA = registerLifecycleHook('p1', 'onSave', (_ctx, _editor, content) => `${content}-a`, ctx)
    const unB = registerLifecycleHook('p2', 'onSave', (_ctx, _editor, content) => `${content}-b`, ctx)
    expect(emitLifecycle('onSave', null, 'orig')).toBe('orig-a-b')
    unA()
    unB()
  })

  it('onSave non-string returns pass the running value through unchanged', () => {
    const seen: unknown[] = []
    const unA = registerLifecycleHook(
      'p1',
      'onSave',
      (_ctx, _editor, content) => {
        seen.push(content)
      },
      ctx,
    )
    const unB = registerLifecycleHook(
      'p2',
      'onSave',
      (_ctx, _editor, content) => {
        seen.push(content)
        return `${content}!`
      },
      ctx,
    )
    expect(emitLifecycle('onSave', null, 'x')).toBe('x!')
    expect(seen).toEqual(['x', 'x'])
    unA()
    unB()
  })

  it('a hook that unregisters another hook mid-emit does not skip the following hook', () => {
    const first = vi.fn()
    const third = vi.fn()
    const unFirst = registerLifecycleHook('p1', 'onCloseTab', first, ctx)
    const unSecond = registerLifecycleHook('p2', 'onCloseTab', () => unFirst(), ctx)
    const unThird = registerLifecycleHook('p3', 'onCloseTab', third, ctx)
    emitLifecycle('onCloseTab', { id: 't1' })
    expect(first).toHaveBeenCalledTimes(1)
    expect(third).toHaveBeenCalledTimes(1)
    // p1 stays unregistered for later emits, and p3 keeps firing
    emitLifecycle('onCloseTab', { id: 't2' })
    expect(first).toHaveBeenCalledTimes(1)
    expect(third).toHaveBeenCalledTimes(2)
    unSecond()
    unThird()
  })

  it('hasLifecycleListeners reflects registration', () => {
    const un = registerLifecycleHook('p1', 'onViewModeChange', () => {}, ctx)
    expect(hasLifecycleListeners('onViewModeChange')).toBe(true)
    un()
    expect(hasLifecycleListeners('onViewModeChange')).toBe(false)
  })

  it('onSave receives the active editor after setActiveEditor', () => {
    const editor = { kind: 'test-editor' }
    const spy = vi.fn()
    setActiveEditor(editor)
    const un = registerLifecycleHook('p1', 'onSave', spy, ctx)
    emitLifecycle('onSave', editor, 'content')
    expect(spy).toHaveBeenCalledWith(ctx, editor, 'content')
    setActiveEditor(null)
    un()
  })

  it('ctx.editor reflects the active editor at emit time', () => {
    const editor = { kind: 'test-editor' }
    const freshCtx = { id: 'p2', name: 'P2', insertComponent: () => {} } as PluginContext
    const hookCtx = vi.fn()
    setActiveEditor(editor)
    const un = registerLifecycleHook('p2', 'onDocChange', hookCtx, freshCtx)
    emitLifecycle('onDocChange', { doc: 'x' })
    expect(hookCtx).toHaveBeenCalled()
    expect(freshCtx.editor).toBe(editor)
    setActiveEditor(null)
    un()
  })

  it('getActiveEditor returns null when no editor is set', () => {
    setActiveEditor(null)
    expect(getActiveEditor()).toBeNull()
  })
})
