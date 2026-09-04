import { registerCommand, registerComponent, registerToolbar, getComponent, unregisterCommand, unregisterComponent, unregisterToolbar } from '@nekowite/editor-core'
import type { LoadResult } from './loader'
import { registerLifecycleHook } from './lifecycle'
import type { LifecycleEvent } from './lifecycle'
import type { PluginContext, PluginDefinition, PluginErrorCode } from './types'
import { PluginError } from './types'
import { withTimeout } from './timing'

interface ActivePlugin {
  definition: PluginDefinition
  registeredComponents: string[]
  registeredCommands: string[]
  registeredToolbar: string[]
  hookUnregisters: Array<() => void>
}

const active = new Map<string, ActivePlugin>()

/** Default budget for a plugin's async `onLoad`/activation work. Once elapses the
 *  host stops waiting and marks the plugin unstable instead of hanging. */
export const DEFAULT_PLUGIN_ACTIVATION_TIMEOUT_MS = 5000

/** Plugins that entered an unstable state (activation threw, or a hook or the
 *  init timed out). The host deactivates them and records the failure so a
 *  crashing/looping plugin is never silently left half-registered. */
const unstable = new Set<string>()

function runUnregister(un: () => void): void {
  try {
    un()
  } catch {
    // isolation: a plugin's failure must never propagate
  }
}

export interface ActivatePluginOptions {
  /** Budget (ms) for the plugin's async init/onLoad. Defaults to
   *  DEFAULT_PLUGIN_ACTIVATION_TIMEOUT_MS. A plugin that exceeds it is cancelled
   *  (its awaited init is stopped), rolled back, and marked unstable. */
  timeoutMs?: number
  /** Thread an abort signal so a caller (e.g. vault switch) can cancel a running
   *  activation. On abort the plugin is rolled back and marked unstable. */
  signal?: AbortSignal
}

export interface ActivationResult {
  ok: boolean
  id: string
  error?: string
  /** Structured code when the failure is a recognised plugin failure mode, so
   *  the host can route it to a distinct message instead of a generic "failed". */
  code?: PluginErrorCode
}

/** Mark a plugin as having entered an unstable state: deactivate it (so its
 *  registrations/hooks are released and it is left in a safe state) and record
 *  the failure. The host keeps running — isolation, not a crash. */
export function markPluginUnstable(id: string, reason?: string): void {
  deactivatePlugin(id)
  unstable.add(id)
  if (reason) {
    console.warn(`[NekoWite:plugin-host] plugin "${id}" entered unstable state: ${reason}`)
  }
}

/** The ids of plugins disabled because they entered an unstable state. */
export function getUnstablePluginIds(): string[] {
  return [...unstable]
}

/** True when a plugin has been disabled for instability. */
export function isPluginUnstable(id: string): boolean {
  return unstable.has(id)
}

export async function activatePlugin(
  result: LoadResult,
  options?: ActivatePluginOptions,
): Promise<ActivationResult> {
  if (!result.ok) return { ok: false, id: result.id, error: result.error }
  const { id, definition } = result
  // Already active: re-activation is an ok no-op. Registering twice would
  // append a duplicate toolbar item, run lifecycle hooks twice, and orphan the
  // first registration's unlistens (they only live on the entry that
  // `active.set` overwrites), leaving ghost hooks after deactivatePlugin. The
  // desktop callers treat ok:false as an activation failure worth surfacing
  // (main.ts builtin bootstrap, services/plugins.ts vault scan) and can
  // legitimately re-run for the same ids, so idempotence beats an error here.
  if (active.has(id)) return { ok: true, id }
  // Cancel before doing any work: a caller that already aborted should never
  // have the plugin registered.
  if (options?.signal?.aborted) {
    return { ok: false, id, code: 'PLUGIN_ABORTED', error: 'Plugin activation was cancelled.' }
  }
  const registeredComponents: string[] = []
  const registeredCommands: string[] = []
  const registeredToolbar: string[] = []
  const hookUnregisters: Array<() => void> = []
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PLUGIN_ACTIVATION_TIMEOUT_MS
  try {
    const components = definition.components ?? {}
    for (const name of Object.keys(components)) {
      registerComponent(name, components[name])
      registeredComponents.push(name)
    }
    for (const cmd of definition.commands ?? []) {
      registerCommand(cmd)
      registeredCommands.push(cmd.id)
    }
    for (const item of definition.toolbar ?? []) {
      registerToolbar(item)
      registeredToolbar.push(item.id)
    }
    const ctx: PluginContext = {
      id,
      name: definition.name ?? id,
      insertComponent: (insertName) => {
        if (!getComponent(insertName)) throw new Error(`component not found: ${insertName}`)
      },
    }
    const onLoadResult = (definition.onLoad?.(ctx) ?? undefined) as
      | void
      | (() => void)
      | Promise<void | (() => void)>
      | undefined
    if (onLoadResult && typeof (onLoadResult as { then?: unknown }).then === 'function') {
      // Async init: bound it so a hung onLoad is cancelled, not a stall.
      const resolved = await withTimeout(Promise.resolve(onLoadResult), timeoutMs, { signal: options?.signal })
      if (typeof resolved === 'function') hookUnregisters.push(resolved as () => void)
    } else if (typeof onLoadResult === 'function') {
      hookUnregisters.push(onLoadResult as () => void)
    }

    const lifecycleFns: Array<[LifecycleEvent, unknown]> = [
      ['onEditorReady', definition.onEditorReady],
      ['onDocChange', definition.onDocChange],
      ['onSave', definition.onSave],
      ['onSaved', definition.onSaved],
      ['onOpenDocument', definition.onOpenDocument],
      ['onCloseTab', definition.onCloseTab],
      ['onViewModeChange', definition.onViewModeChange],
    ]
    for (const [event, fn] of lifecycleFns) {
      if (typeof fn !== 'function') continue
      // A hook may return a cleanup (e.g. an editor unlisten). Hold ONE per
      // hook registration: a later emit swaps the new cleanup in and releases
      // the superseded one instead of queueing duplicates, so deactivate runs
      // each cleanup exactly once no matter how often the hook fired.
      let cleanup: (() => void) | undefined
      hookUnregisters.unshift(() => {
        const un = cleanup
        cleanup = undefined
        if (un) runUnregister(un)
      })
      const wrapped: (...args: unknown[]) => unknown = (c, ...args) => {
        const r = (fn as (...a: unknown[]) => unknown)(c, ...args)
        if (typeof r === 'function') {
          const prev = cleanup
          cleanup = r as () => void
          if (prev && prev !== cleanup) runUnregister(prev)
        }
        return r
      }
      hookUnregisters.push(registerLifecycleHook(id, event, wrapped, ctx))
    }

    active.set(id, { definition, registeredComponents, registeredCommands, registeredToolbar, hookUnregisters })
    unstable.delete(id)
    return { ok: true, id }
  } catch (err) {
    // Isolation + safe state: roll back everything we registered, then mark the
    // plugin unstable so the host keeps running but the plugin is disabled, not
    // half-registered. Synchronous registration can throw (duplicate command id)
    // and async init can time out / abort — all land here, none escape.
    for (const un of hookUnregisters) runUnregister(un)
    for (const componentName of registeredComponents) unregisterComponent(componentName)
    for (const commandId of registeredCommands) unregisterCommand(commandId)
    for (const toolbarId of registeredToolbar) unregisterToolbar(toolbarId)
    // Recognise a structured timeout/cancel so the host can route a distinct
    // message; everything else is a plain activation failure.
    const code: PluginErrorCode | undefined =
      err instanceof PluginError &&
      (err.code === 'PLUGIN_HOOK_TIMEOUT' || err.code === 'PLUGIN_ABORTED')
        ? err.code
        : undefined
    markPluginUnstable(id, code ?? undefined)
    return {
      ok: false,
      id,
      error: err instanceof Error ? err.message : String(err),
      ...(code ? { code } : {}),
    }
  }
}

export function deactivatePlugin(id: string): void {
  const plugin = active.get(id)
  if (!plugin) return
  try {
    for (const un of plugin.hookUnregisters) runUnregister(un)
    for (const componentName of plugin.registeredComponents) unregisterComponent(componentName)
    for (const commandId of plugin.registeredCommands) unregisterCommand(commandId)
    for (const toolbarId of plugin.registeredToolbar) unregisterToolbar(toolbarId)
    const name = plugin.definition.name ?? id
    plugin.definition.onUnload?.({
      id,
      name,
      insertComponent: (insertName) => {
        if (!getComponent(insertName)) throw new Error(`component not found: ${insertName}`)
      },
    })
  } catch {
    // isolation: a plugin's failure must never propagate
  } finally {
    active.delete(id)
    unstable.delete(id)
  }
}
