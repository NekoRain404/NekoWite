import { registerCommand, registerComponent, registerToolbar, getComponent, unregisterCommand, unregisterComponent, unregisterToolbar } from '@nekowite/editor-core'
import type { LoadResult } from './loader'
import { registerLifecycleHook, reportPluginCallbackError } from './lifecycle'
import type { LifecycleEvent } from './lifecycle'
import type { PluginContext, PluginDefinition, PluginErrorCode } from './types'
import { PluginError } from './types'
import { withTimeout } from './timing'
/* From the module that owns it, not from `./index`: the barrel this package
 * exports re-exports this file, so going through it would close a cycle. */
import { recordPluginEvent, type PluginAuditEventType } from './audit-log'
import { declaredPermissionsOf } from './permissions'
import { addSessionUsage, beginInFlightActivation, cancelInFlightActivation, getPluginSessionQuota, getPluginSessionUsage, isActivationInFlight, resetPluginSessionUsage } from './activation-registry'
import { aiApiFor } from './ai-provider'

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
 *  init timed out, or the session resource quota was exhausted). The host
 *  deactivates them and records the failure so a crashing/looping plugin is never
 *  silently left half-registered. A plugin in this set is REFUSED on the next
 *  activation until it is explicitly re-approved with `resetUnstablePlugin`. */
const unstable = new Set<string>()

/* ------------------------------------------------------------------------- *
 * Resource quota (P0.1 — honest scope). This is NOT OS-process/Worker
 * isolation. It bounds two things on the current in-window host:
 *   1. a max wall-clock budget per plugin per session (cumulative activation
 *      time), after which the plugin is quarantined (marked unstable) and must
 *      be explicitly re-approved;
 *   2. a max number of concurrent in-flight activations.
 * It does NOT bound a plugin's memory, globals, or synchronous CPU — a plugin
 * that spins the event loop synchronously still cannot be pre-empted (see
 * documentation in docs/SECURITY.md). The existing per-hook/activation timeout +
 * AbortSignal cancel remain the primary pre-emption mechanism.
 *
 * The state itself is in `./activation-registry`, which also owns the in-flight
 * set: a teardown has to be able to SEE and cancel an activation that has not
 * finished, so that bookkeeping cannot live inside the activation. The `ai`
 * surface this file hands out is in `./ai-provider`. Both are re-exported below
 * because this file is the entry point `@nekowite/plugin-host` and direct
 * importers have always used.
 * ------------------------------------------------------------------------- */

export * from './activation-registry'
export * from './ai-provider'

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
 *  the failure to the audit log. The host keeps running — isolation, not a crash.
 *  `eventType` lets the caller record WHY it became unstable (crash / timeout /
 *  cancel / quota-exceeded), defaulting to 'crash'. */
export function markPluginUnstable(id: string, reason?: string, eventType: PluginAuditEventType = 'crash'): void {
  deactivatePlugin(id)
  unstable.add(id)
  recordPluginEvent(id, eventType, reason ?? 'entered unstable state')
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

/** Explicitly re-approve an unstable plugin so it can run again ("crash-restart-
 *  on-unstable" recovery). This is user-mediated: a plugin never auto-restarts
 *  after being marked unstable. Re-approval also grants a fresh session resource
 *  budget (the previous usage is reset), so the re-approval is a genuine restart
 *  rather than an immediate re-quarantine. */
export function resetUnstablePlugin(id: string): void {
  if (unstable.delete(id)) {
    resetPluginSessionUsage(id)
    recordPluginEvent(id, 'reset-unstable', 're-approved by user')
  }
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

  // Re-approval gate ("crash-restart-on-unstable"): a plugin that entered an
  // unstable state (activation crashed, a hook timed out, or the session resource
  // quota was exhausted) is REFUSED here rather than silently auto-restarting. It
  // must be explicitly reset (re-approved) via `resetUnstablePlugin` to run again.
  if (isPluginUnstable(id)) {
    return {
      ok: false,
      id,
      code: 'PLUGIN_UNSTABLE',
      error: `Plugin "${definition.name ?? id}" is in an unstable state and requires re-approval before it can run again.`,
    }
  }

  // Resource quota: a plugin whose cumulative activation budget for the session is
  // already exhausted is quarantined (marked unstable) so it cannot keep burning
  // wall-clock. Recovery is an explicit `resetUnstablePlugin`.
  const quotaMs = getPluginSessionQuota()
  const used = getPluginSessionUsage(id)
  if (used >= quotaMs) {
    markPluginUnstable(id, `session resource quota exhausted (${used}ms >= ${quotaMs}ms)`, 'quota-exceeded')
    return {
      ok: false,
      id,
      code: 'PLUGIN_QUOTA_EXCEEDED',
      error: `Plugin "${definition.name ?? id}" exceeded its session resource quota and was deactivated; re-approve it to run again.`,
    }
  }

  // An activation of this id is already under way: it owns the registrations, so
  // a second one must not add its own. Both would register the same component
  // names and hook ids into the process-global registries while only the entry
  // that `active.set` writes last keeps its unregisters — the other's hooks
  // would then survive deactivation and fire from a plugin the host believes is
  // gone. Like the already-active case above, idempotence beats an error: the
  // caller is told the id is being activated, and the outcome belongs to the
  // first call.
  if (isActivationInFlight(id)) return { ok: true, id }

  // Register the activation in flight BEFORE the first await, which is only
  // possible because this is also where the concurrent-activation cap is
  // consulted: a teardown arriving while the init is awaited can then find and
  // cancel it. Bounding the count keeps a burst of slow inits from piling up.
  const pending = beginInFlightActivation(id, options?.signal)
  if (!pending) {
    return {
      ok: false,
      id,
      code: 'PLUGIN_ACTIVATE_FAILED',
      error: `Plugin "${definition.name ?? id}" could not start: too many plugins are activating concurrently.`,
    }
  }

  const registeredComponents: string[] = []
  const registeredCommands: string[] = []
  const registeredToolbar: string[] = []
  const hookUnregisters: Array<() => void> = []

  /**
   * Wrap a callback the plugin handed us so its failure cannot escape into the
   * host's UI. These run from a click (a toolbar button, a command in the
   * palette), OUTSIDE the activation try/catch and outside `emitLifecycle`'s
   * isolation, so before this a throwing plugin callback propagated out of the
   * DOM event handler: the app logged an unhandled error, the user got no
   * message and no plugin name, and the palette's own bookkeeping (a running
   * flag, a spinner) was left stuck.
   *
   * The notice is raised once per callback per session - a broken button that
   * is clicked repeatedly must not turn into a wall of identical toasts - while
   * every failure is still logged.
   */
  const reportedCallbacks = new Set<string>()
  function isolate(label: string, origin: `toolbar:${string}` | `command:${string}`, run: () => void): () => void {
    const report = (err: unknown): void => {
      if (reportedCallbacks.has(label)) {
        console.error(`[NekoWite:plugin-host] callback failed again plugin="${id}" origin="${origin}"`, err)
        return
      }
      reportedCallbacks.add(label)
      recordPluginEvent(id, 'crash', `callback "${label}" threw: ${err instanceof Error ? err.message : String(err)}`)
      reportPluginCallbackError(id, origin, err)
    }
    return () => {
      try {
        const returned = run() as unknown
        // A callback may be async — `() => Promise<void>` is assignable to a
        // void-returning type — and then its failure does NOT arrive at the
        // catch below: it becomes an unhandled rejection in the host with no
        // plugin name on it, which is the failure this wrapper exists to
        // prevent. Contain the thenable as well as the synchronous throw.
        if (returned && typeof (returned as { then?: unknown }).then === 'function') {
          Promise.resolve(returned).catch(report)
        }
      } catch (err) {
        report(err)
      }
    }
  }
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PLUGIN_ACTIVATION_TIMEOUT_MS
  const startedAt = Date.now()
  try {
    const components = definition.components ?? {}
    for (const name of Object.keys(components)) {
      registerComponent(name, components[name])
      registeredComponents.push(name)
    }
    for (const cmd of definition.commands ?? []) {
      registerCommand({ ...cmd, run: isolate(cmd.id, `command:${cmd.id}`, cmd.run) })
      registeredCommands.push(cmd.id)
    }
    for (const item of definition.toolbar ?? []) {
      registerToolbar({ ...item, run: isolate(item.id, `toolbar:${item.id}`, item.run) })
      registeredToolbar.push(item.id)
    }
    // What the plugin DECLARED (manifest + definition): the AI capability is
    // gated on it, so a plugin that never asked cannot pick it up by reaching
    // for `ctx.ai`. Read through the PINNED value, never off `definition`
    // itself: the gate the user answered read the same one answer, so a getter
    // (or a reassignment) that varies between the two moments cannot turn "no
    // dialog was needed" into a granted capability.
    const declared = declaredPermissionsOf(result.meta, definition)
    const ctx: PluginContext = {
      id,
      name: definition.name ?? id,
      insertComponent: (insertName) => {
        if (!getComponent(insertName)) throw new Error(`component not found: ${insertName}`)
      },
      ai: aiApiFor(id, declared),
    }
    const onLoadResult = (definition.onLoad?.(ctx) ?? undefined) as
      | void
      | (() => void)
      | Promise<void | (() => void)>
      | undefined
    if (onLoadResult && typeof (onLoadResult as { then?: unknown }).then === 'function') {
      // Async init: bound it so a hung onLoad is cancelled, not a stall. The
      // signal is the activation's own, composed with the caller's, so this is
      // the point a teardown reaches: it aborts, the wait ends, and the catch
      // below rolls back what was registered before this await.
      const resolved = await withTimeout(Promise.resolve(onLoadResult), timeoutMs, { signal: pending.signal })
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
    recordPluginEvent(id, 'activate', 'activated', { version: result.meta?.version })
    // Account the elapsed wall-clock against the session budget. If this
    // activation pushed the plugin over its quota, quarantine it (it already
    // registered, so markPluginUnstable tears it down) and require re-approval.
    const total = addSessionUsage(id, startedAt)
    if (total >= quotaMs) {
      markPluginUnstable(id, `session resource quota exceeded (${total}ms >= ${quotaMs}ms)`, 'quota-exceeded')
      return {
        ok: false,
        id,
        code: 'PLUGIN_QUOTA_EXCEEDED',
        error: `Plugin "${definition.name ?? id}" exceeded its session resource quota and was deactivated; re-approve it to run again.`,
      }
    }
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
    // A teardown arrived while the init was awaited: `deactivatePlugin` has
    // already run its own bookkeeping, and the rollback above is the rest of it.
    // The plugin is off, NOT unstable — the user's own switch must not quarantine
    // it, or switching it back on would demand a re-approval.
    if (pending.cancelled()) {
      recordPluginEvent(id, 'cancel', 'activation cancelled by deactivatePlugin', { version: result.meta?.version })
      return { ok: false, id, code: 'PLUGIN_ABORTED', error: 'Plugin activation was cancelled.' }
    }
    // Recognise a structured timeout/cancel so the host can route a distinct
    // message; everything else is a plain activation failure.
    const code: PluginErrorCode | undefined =
      err instanceof PluginError &&
      (err.code === 'PLUGIN_HOOK_TIMEOUT' || err.code === 'PLUGIN_ABORTED')
        ? err.code
        : undefined
    const eventType: PluginAuditEventType =
      code === 'PLUGIN_HOOK_TIMEOUT' ? 'timeout' : code === 'PLUGIN_ABORTED' ? 'cancel' : 'crash'
    addSessionUsage(id, startedAt)
    markPluginUnstable(id, code ?? undefined, eventType)
    return {
      ok: false,
      id,
      error: err instanceof Error ? err.message : String(err),
      ...(code ? { code } : {}),
    }
  } finally {
    pending.release()
  }
}

export function deactivatePlugin(id: string): void {
  const plugin = active.get(id)
  if (!plugin) {
    // An activation may still be in flight: it registers its components,
    // commands and toolbar items BEFORE its awaited init and only `active.set`s
    // afterwards, so this used to find nothing to take down and return — leaving
    // the plugin registered and running after the user switched it off. Cancel
    // it instead: the activation rolls back its own registrations when its await
    // settles, and no longer commits.
    cancelInFlightActivation(id)
    return
  }
  try {
    for (const un of plugin.hookUnregisters) runUnregister(un)
    for (const componentName of plugin.registeredComponents) unregisterComponent(componentName)
    for (const commandId of plugin.registeredCommands) unregisterCommand(commandId)
    for (const toolbarId of plugin.registeredToolbar) unregisterToolbar(toolbarId)
    const name = plugin.definition.name ?? id
    const unloaded = plugin.definition.onUnload?.({
      id,
      name,
      insertComponent: (insertName) => {
        if (!getComponent(insertName)) throw new Error(`component not found: ${insertName}`)
      },
    }) as unknown
    // `deactivatePlugin` is synchronous and the teardown must complete, but a
    // rejecting async onUnload would otherwise surface as an unhandled rejection
    // in the host: detached, observed, and reported against the plugin.
    if (unloaded && typeof (unloaded as { then?: unknown }).then === 'function') {
      void Promise.resolve(unloaded).catch((err: unknown) => {
        console.error(`[NekoWite:plugin-host] onUnload failed plugin="${id}"`, err)
      })
    }
  } catch {
    // isolation: a plugin's failure must never propagate
  } finally {
    active.delete(id)
    unstable.delete(id)
    recordPluginEvent(id, 'deactivate', 'deactivated')
  }
}
