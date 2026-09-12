import type { PluginContext, PluginErrorCode } from './types'
import { PluginError, createPluginError } from './types'
import { withTimeout } from './timing'
import { markPluginUnstable } from './runtime'

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

/**
 * Where a plugin failure came from. Lifecycle hooks report their event name; a
 * toolbar button or a command reports `toolbar:<id>` / `command:<id>`.
 *
 * A callback that throws when the user clicks it is the same class of failure
 * as a hook that throws when the host emits: the plugin is at fault, the app
 * must survive, and the user must be able to tell WHICH button broke. Sharing
 * the channel is what makes that possible; the label is what makes it useful.
 */
export type PluginFailureOrigin = LifecycleEvent | `toolbar:${string}` | `command:${string}`

/** A plugin failure surfaced through the lifecycle error channel. Carries a
 *  structured `PluginError` so the host/UI can show an actionable message
 *  without breaking isolation. */
export interface LifecycleErrorEvent {
  pluginId: string
  event: PluginFailureOrigin
  error: PluginError
}

interface HookEntry {
  id: string
  fn: (...args: unknown[]) => unknown
  ctx: PluginContext
}

const hooks = new Map<LifecycleEvent, HookEntry[]>()

let activeEditor: unknown = null

/** Default budget (ms) before an *async* lifecycle hook is cancelled. A hook that
 *  returns a thenable and does not settle in time is rejected with
 *  PLUGIN_HOOK_TIMEOUT, the host stops waiting, and the plugin is marked
 *  unstable (deactivated) so a hanging hook cannot leave it half-registered. */
export const DEFAULT_PLUGIN_HOOK_TIMEOUT_MS = 5000

let lifecycleHookTimeoutMs = DEFAULT_PLUGIN_HOOK_TIMEOUT_MS

/** Configure the async-hook timeout budget. Defaults to
 *  DEFAULT_PLUGIN_HOOK_TIMEOUT_MS. */
export function setLifecycleHookTimeout(ms: number): void {
  lifecycleHookTimeoutMs = ms
}

/** The current async-hook timeout budget (ms). */
export function getLifecycleHookTimeout(): number {
  return lifecycleHookTimeoutMs
}

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

/** Time-box an *async* hook (a hook that returned a thenable). The host stops
 *  waiting once the budget elapses; a hung hook is surfaced as PLUGIN_HOOK_TIMEOUT
 *  and the plugin is marked unstable (deactivated) so it cannot leak a running
 *  hook. A hook that rejects with a non-timeout error is surfaced as
 *  PLUGIN_HOOK_ERROR and isolated like a synchronous throw — the plugin itself is
 *  not necessarily deactivated for a one-off rejection. */
function handleAsyncHook(
  entry: HookEntry,
  event: LifecycleEvent,
  result: Promise<unknown>,
  isSave: boolean,
): void {
  void withTimeout(Promise.resolve(result), lifecycleHookTimeoutMs).then(
    (resolved) => {
      // The sync onSave chain can only consume a string returned synchronously;
      // an async hook's eventual string cannot retroactively rewrite what was
      // already written to disk, so it is ignored rather than silently applied.
      if (isSave && typeof resolved === 'string') {
        console.warn(
          `[NekoWite:plugin-host] async onSave hook plugin="${entry.id}" returned a string that was ignored (async onSave chaining is unsupported).`,
        )
      }
    },
    (err) => {
      const code: PluginErrorCode = err instanceof PluginError ? err.code : 'PLUGIN_HOOK_ERROR'
      const timeout = code === 'PLUGIN_HOOK_TIMEOUT'
      const cause = err instanceof Error ? err.message : String(err)
      const pluginError = createPluginError(code, {
        pluginId: entry.id,
        message: timeout
          ? `Plugin "${entry.id}" lifecycle hook "${event}" exceeded its time budget and was cancelled.`
          : `Plugin "${entry.id}" failed in lifecycle hook "${event}": ${cause}`,
        recovery: 'Disable the plugin or check its logs.',
        cause: err,
      })
      console.error(
        `[NekoWite:plugin-host] lifecycle hook plugin="${entry.id}" event="${event}" ${code}`,
        pluginError,
      )
      emitLifecycleError({ pluginId: entry.id, event, error: pluginError })
      if (timeout) {
        // A hung hook must not leave the plugin half-registered: deactivate it.
        markPluginUnstable(entry.id, `lifecycle hook ${event} ${code}`, 'timeout')
      }
    },
  )
}

/**
 * Report a plugin callback that threw (a toolbar button, a registered command).
 *
 * The callback itself is isolated by the host (`activatePlugin` wraps what a
 * plugin registers), so this is the reporting half: it builds the structured
 * error, logs it, and pushes it through the same channel as a failing hook, so
 * the app's existing error router shows the user an actionable message instead
 * of an unhandled exception with no plugin name on it.
 */
export function reportPluginCallbackError(
  pluginId: string,
  origin: PluginFailureOrigin,
  err: unknown,
): PluginError {
  const cause = err instanceof Error ? err.message : String(err)
  const pluginError = createPluginError('PLUGIN_CALLBACK_ERROR', {
    pluginId,
    message: `Plugin "${pluginId}" failed in "${origin}": ${cause}`,
    recovery: 'Disable the plugin or check its logs.',
    cause: err,
  })
  console.error(
    `[NekoWite:plugin-host] callback failed plugin="${pluginId}" origin="${origin}"`,
    pluginError,
  )
  emitLifecycleError({ pluginId, event: origin, error: pluginError })
  return pluginError
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
      // An async hook (thenable) is time-boxed in the background; the sync chain
      // and the other hooks keep running regardless, so a slow hook never hangs
      // the emit or its siblings.
      if (r && typeof (r as { then?: unknown }).then === 'function') {
        handleAsyncHook(entry, event, r as Promise<unknown>, isSave)
      } else if (isSave && typeof r === 'string') {
        next = r
      }
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
