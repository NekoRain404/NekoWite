import { describe, expect, it, vi } from 'vitest'
import { emitLifecycle, hasLifecycleListeners, registerLifecycleHook } from './lifecycle'

const ctx = { id: 'p1', name: 'P1', insertComponent: () => {} } as never

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

  it('unregister removes the hook', () => {
    const fn = vi.fn()
    const un = registerLifecycleHook('p1', 'onOpenDocument', fn, ctx)
    un()
    emitLifecycle('onOpenDocument', { id: 't1' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('onSave last non-void string wins', () => {
    registerLifecycleHook('p1', 'onSave', () => 'first', ctx)
    registerLifecycleHook('p2', 'onSave', () => 'second', ctx)
    expect(emitLifecycle('onSave', null, 'orig')).toBe('second')
  })

  it('hasLifecycleListeners reflects registration', () => {
    const un = registerLifecycleHook('p1', 'onViewModeChange', () => {}, ctx)
    expect(hasLifecycleListeners('onViewModeChange')).toBe(true)
    un()
    expect(hasLifecycleListeners('onViewModeChange')).toBe(false)
  })
})