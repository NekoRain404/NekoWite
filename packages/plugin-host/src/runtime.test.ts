import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  activatePlugin,
  deactivatePlugin,
  DEFAULT_MAX_IN_FLIGHT_ACTIVATIONS,
  DEFAULT_PLUGIN_SESSION_QUOTA_MS,
  getInFlightActivationCount,
  getPluginSessionUsage,
  getUnstablePluginIds,
  isPluginUnstable,
  resetUnstablePlugin,
  setMaxInFlightActivations,
  setPluginAiProvider,
  setPluginSessionQuota,
} from './runtime'
import { emitLifecycle, onLifecycleError } from './lifecycle'
import { onPluginEvent, getAuditLog } from './index'
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
  unregisterCommand('slow.cmd')
  unregisterCommand('cancel.cmd')
  unregisterCommand('crasher.cmd')
  deactivatePlugin('withai')
  deactivatePlugin('noai')
  unregisterComponent('Callout')
  unregisterComponent('DeactComp')
  unregisterToolbar('p1.toolbar')
  unregisterToolbar('deact.toolbar')
  unregisterToolbar('dup.toolbar')
  deactivatePlugin('p1')
  deactivatePlugin('p2')
  deactivatePlugin('bad')
  deactivatePlugin('deact')
  deactivatePlugin('dupbad')
  deactivatePlugin('slow')
  deactivatePlugin('cancel')
  deactivatePlugin('crasher')
})

describe('activatePlugin', () => {
  it('registers commands and components', async () => {
    // The host registers a WRAPPER (see the isolation cases below), so identity
    // with the plugin's own function is not what is being asserted any more:
    // calling the registered command must reach the plugin's function.
    const cmdRun = vi.fn()
    const toolbarRun = vi.fn()
    const res = await activatePlugin(
      ok('p1', { components: { Callout: {} as never }, commands: [{ id: 'p1.cmd', run: cmdRun }], toolbar: [{ id: 'p1.toolbar', label: 'T', run: toolbarRun }] }),
    )
    expect(res.ok).toBe(true)
    getCommand('p1.cmd')?.run()
    expect(cmdRun).toHaveBeenCalledTimes(1)
    expect(getComponent('Callout')).toBeDefined()
    getToolbar().find((t) => t.id === 'p1.toolbar')?.run()
    expect(toolbarRun).toHaveBeenCalledTimes(1)
  })

  it('offers the ai capability only to a plugin that declared it', async () => {
    // `permissions: ['ai']` used to buy nothing at all: the host had no AI
    // surface, so the capability the permission dialog described did not exist.
    // It exists now, but only for a plugin that ASKED - reaching for ctx.ai
    // without declaring it must not be a way to get one.
    setPluginAiProvider(async (id, prompt) => `from ${id}: ${prompt}`)
    try {
      let declaredCtx: { ai?: { complete(p: string): Promise<string> } } | null = null
      let undeclaredCtx: { ai?: unknown } | null = null
      await activatePlugin(
        ok('withai', {
          permissions: ['ai'],
          onLoad: (ctx) => {
            declaredCtx = ctx as never
          },
        }),
      )
      await activatePlugin(
        ok('noai', {
          onLoad: (ctx) => {
            undeclaredCtx = ctx as never
          },
        }),
      )

      expect(declaredCtx!.ai).toBeDefined()
      await expect(declaredCtx!.ai!.complete('hello')).resolves.toBe('from withai: hello')
      expect(undeclaredCtx!.ai).toBeUndefined()
    } finally {
      setPluginAiProvider(null)
      deactivatePlugin('withai')
      deactivatePlugin('noai')
    }
  })

  it('has no ai capability at all when the app installed no provider', async () => {
    // The host does not implement AI: with no provider from the app, `ctx.ai`
    // is absent rather than a call that fails at the wire.
    let ctxAi: unknown = 'unset'
    await activatePlugin(
      ok('withai', {
        permissions: ['ai'],
        onLoad: (ctx) => {
          ctxAi = ctx.ai
        },
      }),
    )
    expect(ctxAi).toBeUndefined()
    deactivatePlugin('withai')
  })

  it('isolates a throwing command and reports it through the error channel', async () => {
    // This callback runs from a click, outside the activation try/catch and
    // outside emitLifecycle's isolation. Before this, a throwing plugin command
    // propagated out of the DOM handler: an unhandled error, no plugin name,
    // and the palette left holding a stuck running flag.
    const failures: Array<{ pluginId: string; event: string; code?: string }> = []
    const off = onLifecycleError((e) => failures.push({ pluginId: e.pluginId, event: e.event, code: e.error.code }))
    try {
      await activatePlugin(
        ok('crasher', {
          commands: [
            {
              id: 'crasher.cmd',
              run: () => {
                throw new Error('bad command')
              },
            },
          ],
        }),
      )
      expect(() => getCommand('crasher.cmd')?.run()).not.toThrow()
      expect(failures).toEqual([
        { pluginId: 'crasher', event: 'command:crasher.cmd', code: 'PLUGIN_CALLBACK_ERROR' },
      ])
    } finally {
      off()
      deactivatePlugin('crasher')
    }
  })

  it('isolates a throwing toolbar button the same way', async () => {
    const failures: string[] = []
    const off = onLifecycleError((e) => failures.push(`${e.pluginId}:${e.event}`))
    try {
      await activatePlugin(
        ok('crasher', {
          toolbar: [
            {
              id: 'crasher.btn',
              label: 'B',
              run: () => {
                throw new Error('bad button')
              },
            },
          ],
        }),
      )
      expect(() => getToolbar().find((t) => t.id === 'crasher.btn')?.run()).not.toThrow()
      expect(failures).toEqual(['crasher:toolbar:crasher.btn'])
    } finally {
      off()
      deactivatePlugin('crasher')
    }
  })

  it('reports a broken callback once per session, and keeps logging after that', async () => {
    // A button that throws on every click must not turn into a wall of
    // identical toasts - but the failure must stay visible in the log.
    const failures: string[] = []
    const off = onLifecycleError((e) => failures.push(e.event))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await activatePlugin(
        ok('crasher', {
          commands: [
            {
              id: 'crasher.cmd',
              run: () => {
                throw new Error('again')
              },
            },
          ],
        }),
      )
      getCommand('crasher.cmd')?.run()
      getCommand('crasher.cmd')?.run()
      getCommand('crasher.cmd')?.run()
      expect(failures).toHaveLength(1)
      expect(errorLog.mock.calls.length).toBeGreaterThanOrEqual(3)
    } finally {
      errorLog.mockRestore()
      off()
      deactivatePlugin('crasher')
    }
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

  it('re-activating an active id is an ok no-op (no duplicate hooks or toolbar)', async () => {
    const run = () => {}
    const firstHook = vi.fn()
    const secondHook = vi.fn()
    await activatePlugin(ok('p1', { toolbar: [{ id: 'p1.toolbar', label: 'T', run }], onDocChange: firstHook }))
    const second = await activatePlugin(ok('p1', { toolbar: [{ id: 'p1.toolbar', label: 'T', run }], onDocChange: secondHook }))
    expect(second).toEqual({ ok: true, id: 'p1' })
    expect(getToolbar().filter((t) => t.id === 'p1.toolbar')).toHaveLength(1)
    emitLifecycle('onDocChange', { doc: 'x' })
    expect(firstHook).toHaveBeenCalledTimes(1)
    expect(secondHook).not.toHaveBeenCalled()
    deactivatePlugin('p1')
    expect(getToolbar().some((t) => t.id === 'p1.toolbar')).toBe(false)
    emitLifecycle('onDocChange', { doc: 'y' })
    expect(firstHook).toHaveBeenCalledTimes(1)
    expect(secondHook).not.toHaveBeenCalled()
  })

  it('onSave transforms from multiple plugins compose in activation order', async () => {
    await activatePlugin(ok('p1', { onSave: (_ctx, _editor, content) => content.toUpperCase() }))
    await activatePlugin(ok('p2', { onSave: (_ctx, _editor, content) => `${content}!` }))
    expect(emitLifecycle('onSave', null, 'hello')).toBe('HELLO!')
    deactivatePlugin('p1')
    deactivatePlugin('p2')
    expect(emitLifecycle('onSave', null, 'hello')).toBeUndefined()
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

  it('runs a hook cleanup exactly once even after multiple emits', async () => {
    const cleanups = [vi.fn(), vi.fn(), vi.fn()]
    let emit = 0
    await activatePlugin(ok('p1', { onDocChange: () => cleanups[emit++] }))
    emitLifecycle('onDocChange', { doc: '1' })
    emitLifecycle('onDocChange', { doc: '2' })
    emitLifecycle('onDocChange', { doc: '3' })
    // a superseded cleanup is released as the next one arrives, never queued up
    expect(cleanups[0]).toHaveBeenCalledTimes(1)
    expect(cleanups[1]).toHaveBeenCalledTimes(1)
    expect(cleanups[2]).not.toHaveBeenCalled()
    deactivatePlugin('p1')
    expect(cleanups[2]).toHaveBeenCalledTimes(1)
    emitLifecycle('onDocChange', { doc: '4' })
    expect(cleanups[2]).toHaveBeenCalledTimes(1)
  })
})

describe('activation timeout, cancel & crash isolation', () => {
  it('times out and cancels an async onLoad that never settles (host continues)', async () => {
    const run = () => {}
    const res = await activatePlugin(
      ok('slow', {
        commands: [{ id: 'slow.cmd', run }],
        // An async init that never settles: would hang the host if untimed.
        onLoad: () => new Promise<() => void>(() => {}),
      }),
      { timeoutMs: 30 },
    )
    expect(res.ok).toBe(false)
    expect(res.code).toBe('PLUGIN_HOOK_TIMEOUT')
    // Rolled back: the command that was registered before the hung onLoad is gone.
    expect(getCommand('slow.cmd')).toBeUndefined()
    // The plugin is marked failed (unstable), NOT left half-registered.
    expect(isPluginUnstable('slow')).toBe(true)
    expect(getUnstablePluginIds()).toContain('slow')
  })

  it('cancels a running activation when the abort signal fires', async () => {
    const ac = new AbortController()
    const resPromise = activatePlugin(
      ok('cancel', {
        onLoad: () => new Promise<() => void>(() => {}),
      }),
      { signal: ac.signal, timeoutMs: 10000 },
    )
    // Let the activation start, then cancel it — the host should stop waiting.
    await new Promise((r) => setTimeout(r, 20))
    ac.abort()
    const res = await resPromise
    expect(res.ok).toBe(false)
    expect(res.code).toBe('PLUGIN_ABORTED')
    expect(isPluginUnstable('cancel')).toBe(true)
  })

  it('refuses an already-aborted signal without doing any work', async () => {
    const ac = new AbortController()
    ac.abort()
    const run = () => {}
    const res = await activatePlugin(ok('cancel', { commands: [{ id: 'cancel.cmd', run }] }), { signal: ac.signal })
    expect(res).toEqual({ ok: false, id: 'cancel', code: 'PLUGIN_ABORTED', error: 'Plugin activation was cancelled.' })
    expect(getCommand('cancel.cmd')).toBeUndefined()
  })

  it('isolates a plugin whose activation throws: rolls back and marks it unstable', async () => {
    const run = () => {}
    const res = await activatePlugin(
      ok('crasher', {
        components: { Callout: {} as never },
        commands: [{ id: 'crasher.cmd', run }],
        onLoad: () => {
          throw new Error('boom')
        },
      }),
    )
    expect(res.ok).toBe(false)
    expect(getComponent('Callout')).toBeUndefined()
    expect(getCommand('crasher.cmd')).toBeUndefined()
    expect(isPluginUnstable('crasher')).toBe(true)
  })
})

describe('resource quota & crash-restart-on-unstable', () => {
  const defaults = { quota: DEFAULT_PLUGIN_SESSION_QUOTA_MS, inFlight: DEFAULT_MAX_IN_FLIGHT_ACTIVATIONS }

  afterEach(() => {
    setPluginSessionQuota(defaults.quota)
    setMaxInFlightActivations(defaults.inFlight)
    deactivatePlugin('quota')
    deactivatePlugin('inflight-a')
    deactivatePlugin('inflight-b')
    deactivatePlugin('reset')
  })

  it('quarantines a plugin whose session resource quota is exceeded', async () => {
    setPluginSessionQuota(5)
    const res = await activatePlugin(
      ok('quota', { onLoad: () => new Promise((r) => setTimeout(r, 30)) }),
      { timeoutMs: 2000 },
    )
    expect(res.ok).toBe(false)
    expect(res.code).toBe('PLUGIN_QUOTA_EXCEEDED')
    expect(isPluginUnstable('quota')).toBe(true)
    expect(getPluginSessionUsage('quota')).toBeGreaterThanOrEqual(5)
  })

  it('refuses to auto-restart an unstable plugin until it is explicitly reset', async () => {
    // Make it unstable.
    const first = await activatePlugin(ok('reset', { onLoad: () => { throw new Error('boom') } }))
    expect(first.ok).toBe(false)
    expect(isPluginUnstable('reset')).toBe(true)

    // An automatic re-activation is refused (crash-restart-on-unstable).
    const retry = await activatePlugin(ok('reset', {}))
    expect(retry.ok).toBe(false)
    expect(retry.code).toBe('PLUGIN_UNSTABLE')
    expect(retry.error).toContain('re-approval')

    // Explicit user re-approval clears the flag and grants a fresh budget.
    resetUnstablePlugin('reset')
    expect(isPluginUnstable('reset')).toBe(false)
    expect(getPluginSessionUsage('reset')).toBe(0)

    const recovered = await activatePlugin(ok('reset', {}))
    expect(recovered.ok).toBe(true)
    deactivatePlugin('reset')
  })

  it('bounds concurrent in-flight activations and refuses overflow', async () => {
    setMaxInFlightActivations(1)
    const ac = new AbortController()
    const firstPromise = activatePlugin(
      ok('inflight-a', { onLoad: () => new Promise<() => void>(() => {}) }),
      { signal: ac.signal, timeoutMs: 10000 },
    )
    // Let the first activation start (and hold the in-flight slot).
    await new Promise((r) => setTimeout(r, 20))
    expect(getInFlightActivationCount()).toBe(1)

    // A second activation while the cap is reached is refused without doing work.
    const second = await activatePlugin(ok('inflight-b', {}))
    expect(second.ok).toBe(false)
    expect(second.code).toBe('PLUGIN_ACTIVATE_FAILED')
    expect(second.error).toContain('concurrently')

    // Cancelling the first releases the slot.
    ac.abort()
    const first = await firstPromise
    expect(first.ok).toBe(false)
    expect(first.code).toBe('PLUGIN_ABORTED')
    expect(getInFlightActivationCount()).toBe(0)
  })

  it('records activate/deactivate/crash/timeout events in the audit log', async () => {
    const events: string[] = []
    const off = onPluginEvent((e) => events.push(`${e.pluginId}:${e.event}`))
    try {
      const res = await activatePlugin(ok('aud', { onLoad: () => { throw new Error('boom') } }))
      expect(res.ok).toBe(false)
      deactivatePlugin('aud') // no-op (never active)
      const log = getAuditLog()
      expect(log.some((e) => e.pluginId === 'aud' && e.event === 'crash')).toBe(true)
      expect(events).toContain('aud:crash')
    } finally {
      off()
    }
  })
})