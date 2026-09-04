import type { PluginContext } from './types'
import { createPluginError } from './types'
import type { PluginError } from './types'

export type LifecycleEvent =
  | 'onEditorReady'
  | 'onDocChange'
  | 'onSave'
  | 'onSaved'
  | 'onOpenDocument'
  | 'onCloseTab'
  | 'onViewModeChange'

export interface LifecycleEventArgMap {
  onEditorReady: [editor: unknown]
  onDocChange: [e: { doc: string }]
  onSave: [editor: unknown, content: string]
  onSaved: [editor: unknown, content: string]
  onOpenDocument: [tab: unknown]
  onCloseTab: [tab: unknown]
  onViewModeChange: [mode: unknown]
}

/** A hook failure surfaced through the lifecycle error channel. Carries a
 *  structured `PluginError` (code PLUGIN_HOOK_ERROR) so the host/UI can show an
 *  actionable message without breaking hook isolation. */
export interface LifecycleErrorEvent {
  pluginId: string
  event: LifecycleEvent
  error: PluginError
}

interface HookEntry {
  id: string
  fn: (...args: unknown[]) => unknown
  ctx: PluginContext
}

const hooks = new Map<LifecycleEvent, HookEntry[]>()

let activeEditor: unknown = null

export function setActiveEditor(editor: unknown): void {
  activeEditor = editor
}

export function getActiveEditor(): unknown {
  return activeEditor
}

export function registerLifecycleHook(
  id: string,
  event: LifecycleEvent,
  fn: (...args: unknown[]) => unknown,
  ctx: PluginContext,
): () => void {
  const entry: HookEntry = { id, fn, ctx }
  const list = hooks.get(event) ?? []
  list.push(entry)
  hooks.set(event, list)
  return () => {
    const cur = hooks.get(event) ?? []
    const i = cur.indexOf(entry)
    if (i >= 0) cur.splice(i, 1)
  }
}

export function hasLifecycleListeners(event: LifecycleEvent): boolean {
  return (hooks.get(event)?.length ?? 0) > 0
}

// Lifecycle error channel: a throwing hook is never allowed to block other
// hooks, but its failure must be observable. Subscribers (e.g. the app's error
// toast) receive a structured PluginError so the user sees an actionable
// message instead of silent swallowing.
const lifecycleErrorListeners = new Set<(e: LifecycleErrorEvent) => void>()

/** Subscribe to lifecycle hook errors. Returns an unsubscribe function. */
export function onLifecycleError(cb: (e: LifecycleErrorEvent) => void): () => void {
  lifecycleErrorListeners.add(cb)
  return () => lifecycleErrorListeners.delete(cb)
}

function emitLifecycleError(e: LifecycleErrorEvent): void {
  for (const l of [...lifecycleErrorListeners]) {
    try {
      l(e)
    } catch {
      // A subscriber that throws must not break delivery to the rest.
    }
  }
}

export function emitLifecycle(event: LifecycleEvent, ...args: unknown[]): string | void {
  const isSave = event === 'onSave'
  // onSave transforms chain: once a hook returns a string, that string becomes
  // the content argument for the following hooks; a non-string return passes
  // the running value through unchanged. Other events fan out with the
  // original args.
  let next: string | undefined
  // Iterate a snapshot of the hook list: a hook that unregisters another hook
  // mid-emit must not shift indices and skip the hook after it. Hooks
  // registered during this emit are picked up on the next emit.
  for (const entry of [...(hooks.get(event) ?? [])]) {
    try {
      // Keep ctx.editor truthful: it always reflects the active editor at emit
      // time, so hooks that opt into ctx (rather than the editor ARG) see the
      // right instance.
      entry.ctx.editor = activeEditor
      const hookArgs = isSave && next !== undefined ? [args[0], next] : args
      const r = entry.fn(entry.ctx, ...hookArgs)
      if (isSave && typeof r === 'string') next = r
    } catch (err) {
      // Isolation: one plugin's failure never blocks others. But failures are
      // surfaced through the error channel + logged instead of being swallowed.
      const cause = err instanceof Error ? err.message : String(err)
      const pluginError = createPluginError('PLUGIN_HOOK_ERROR', {
        pluginId: entry.id,
        message: `Plugin "${entry.id}" failed in lifecycle hook "${event}": ${cause}`,
        recovery: 'Disable the plugin or check its logs.',
        cause: err,
      })
      console.error(
        `[NekoWite:plugin-host] lifecycle hook failed plugin="${entry.id}" event="${event}"`,
        pluginError,
      )
      emitLifecycleError({ pluginId: entry.id, event, error: pluginError })
    }
  }
  return next
}
