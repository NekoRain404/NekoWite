import { registerCommand, registerComponent, registerToolbar, getComponent, unregisterCommand, unregisterComponent, unregisterToolbar } from '@nekowite/editor-core'
import type { LoadResult } from './loader'
import { registerLifecycleHook } from './lifecycle'
import type { LifecycleEvent } from './lifecycle'
import type { PluginContext, PluginDefinition } from './types'

interface ActivePlugin {
  definition: PluginDefinition
  registeredComponents: string[]
  registeredCommands: string[]
  registeredToolbar: string[]
  hookUnregisters: Array<() => void>
}

const active = new Map<string, ActivePlugin>()

function runUnregister(un: () => void): void {
  try {
    un()
  } catch {
    // isolation: a plugin's failure must never propagate
  }
}

export async function activatePlugin(result: LoadResult): Promise<{ ok: boolean; id: string; error?: string }> {
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
  const registeredComponents: string[] = []
  const registeredCommands: string[] = []
  const registeredToolbar: string[] = []
  const hookUnregisters: Array<() => void> = []
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
    const onLoadUnlisten = definition.onLoad?.(ctx) as unknown
    if (typeof onLoadUnlisten === 'function') hookUnregisters.push(onLoadUnlisten as () => void)

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
    return { ok: true, id }
  } catch (err) {
    for (const un of hookUnregisters) runUnregister(un)
    for (const componentName of registeredComponents) unregisterComponent(componentName)
    for (const commandId of registeredCommands) unregisterCommand(commandId)
    for (const toolbarId of registeredToolbar) unregisterToolbar(toolbarId)
    return { ok: false, id, error: err instanceof Error ? err.message : String(err) }
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
  }
}
