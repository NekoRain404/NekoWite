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

export async function activatePlugin(result: LoadResult): Promise<{ ok: boolean; id: string; error?: string }> {
  if (!result.ok) return { ok: false, id: result.id, error: result.error }
  const { id, definition } = result
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
      const wrapped: (...args: unknown[]) => unknown = (c, ...args) => {
        const r = (fn as (...a: unknown[]) => unknown)(c, ...args)
        if (typeof r === 'function') hookUnregisters.unshift(r as () => void)
        return r
      }
      hookUnregisters.push(registerLifecycleHook(id, event, wrapped, ctx))
    }

    active.set(id, { definition, registeredComponents, registeredCommands, registeredToolbar, hookUnregisters })
    return { ok: true, id }
  } catch (err) {
    for (const un of hookUnregisters) {
      try {
        un()
      } catch {
        // isolation: a plugin's failure must never propagate
      }
    }
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
    for (const un of plugin.hookUnregisters) {
      try {
        un()
      } catch {
        // isolation: a plugin's failure must never propagate
      }
    }
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
