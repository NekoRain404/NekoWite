import { registerCommand, registerComponent, registerToolbar, getComponent, unregisterCommand, unregisterComponent, unregisterToolbar } from '@nekowite/editor-core'
import type { LoadResult } from './loader'
import { registerLifecycleHook, reportPluginCallbackError } from './lifecycle'
import type { LifecycleEvent } from './lifecycle'
import type { PluginAiApi, PluginContext, PluginDefinition, PluginErrorCode, PluginPermission } from './types'
import { PluginError } from './types'
import { withTimeout } from './timing'
/* From the module that owns it, not from `./index`: the barrel this package
 * exports re-exports this file, so going through it would close a cycle. */
import { recordPluginEvent, type PluginAuditEventType } from './audit-log'
import { collectPluginPermissions } from './permissions'

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
 * ------------------------------------------------------------------------- */

/** Default cumulative wall-clock budget (ms) a plugin may consume on activation
 *  work during a session before it is quarantined. */
export const DEFAULT_PLUGIN_SESSION_QUOTA_MS = 15000

/** Default max number of plugins activating concurrently in the host. */
export const DEFAULT_MAX_IN_FLIGHT_ACTIVATIONS = 4

let sessionQuotaMs = DEFAULT_PLUGIN_SESSION_QUOTA_MS
let maxInFlightActivations = DEFAULT_MAX_IN_FLIGHT_ACTIVATIONS
let inFlightActivations = 0
const sessionUsageMs = new Map<string, number>()

/** Configure the per-plugin per-session wall-clock budget (ms). */
export function setPluginSessionQuota(ms: number): void {
  sessionQuotaMs = ms
}

/** The current per-plugin per-session wall-clock budget (ms). */
export function getPluginSessionQuota(): number {
  return sessionQuotaMs
}

/** Configure the max number of concurrent in-flight activations. */
export function setMaxInFlightActivations(n: number): void {
  maxInFlightActivations = n
}

/** The current max concurrent activation cap. */
export function getMaxInFlightActivations(): number {
  return maxInFlightActivations
}

/** How many activations are currently in flight (awaiting an async init). */
export function getInFlightActivationCount(): number {
  return inFlightActivations
}

/** A plugin's recorded cumulative activation wall-clock for the session (ms). */
export function getPluginSessionUsage(id: string): number {
  return sessionUsageMs.get(id) ?? 0
}

/** Reset a plugin's recorded session usage (grants a fresh budget). Used by
 *  `resetUnstablePlugin` so re-approval is a genuine fresh start. */
export function resetPluginSessionUsage(id: string): void {
  sessionUsageMs.delete(id)
}

/** Add the elapsed activation wall-clock to a plugin's session budget. Returns the
 *  new cumulative total. Guarded so a bad clock never throws. */
function addSessionUsage(id: string, startedAt: number): number {
  const now = Date.now()
  const elapsed = Math.max(0, now - startedAt)
  const total = (sessionUsageMs.get(id) ?? 0) + elapsed
  sessionUsageMs.set(id, total)
  return total
}

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

/**
 * The AI provider the host offers to plugins that declared the `ai` permission.
 *
 * The model belongs to the app (its settings, its key, its bill, and its write
 * policy), so the host does not implement AI - the app installs the provider.
 * With none installed, `ctx.ai` is simply absent: a plugin that declared `ai`
 * gets no capability rather than a call that fails at the wire.
 */
type PluginAiProvider = (pluginId: string, prompt: string) => Promise<string>

let pluginAiProvider: PluginAiProvider | null = null

/** Install (or clear) the provider the host hands to `ai`-declaring plugins. */
export function setPluginAiProvider(provider: PluginAiProvider | null): void {
  pluginAiProvider = provider
}

/**
 * The `ai` surface for a plugin, or undefined when it may not have one: the
 * plugin must have DECLARED the permission (a plugin that did not must not gain
 * the capability by asking) and the app must have installed a provider.
 */
function aiApiFor(
  id: string,
  declared: PluginPermission[],
): PluginAiApi | undefined {
  if (!declared.includes('ai') || !pluginAiProvider) return undefined
  const provider = pluginAiProvider
  return {
    complete: (prompt: string) => provider(id, String(prompt ?? '')),
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
  const used = sessionUsageMs.get(id) ?? 0
  if (used >= sessionQuotaMs) {
    markPluginUnstable(id, `session resource quota exhausted (${used}ms >= ${sessionQuotaMs}ms)`, 'quota-exceeded')
    return {
      ok: false,
      id,
      code: 'PLUGIN_QUOTA_EXCEEDED',
      error: `Plugin "${definition.name ?? id}" exceeded its session resource quota and was deactivated; re-approve it to run again.`,
    }
  }

  // Concurrent-activation cap: bound how many plugins may be mid-activation at
  // once, so a burst of slow inits cannot pile up on the host.
  if (inFlightActivations >= maxInFlightActivations) {
    return {
      ok: false,
      id,
      code: 'PLUGIN_ACTIVATE_FAILED',
      error: `Plugin "${definition.name ?? id}" could not start: too many plugins are activating concurrently.`,
    }
  }
  inFlightActivations++
  const releaseInFlight = (): void => {
    if (inFlightActivations > 0) inFlightActivations--
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
    return () => {
      try {
        run()
      } catch (err) {
        if (reportedCallbacks.has(label)) {
          console.error(`[NekoWite:plugin-host] callback failed again plugin="${id}" origin="${origin}"`, err)
          return
        }
        reportedCallbacks.add(label)
        recordPluginEvent(id, 'crash', `callback "${label}" threw: ${err instanceof Error ? err.message : String(err)}`)
        reportPluginCallbackError(id, origin, err)
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
    // for `ctx.ai`.
    const declared = collectPluginPermissions(result.meta, definition)
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
    recordPluginEvent(id, 'activate', 'activated', { version: result.meta?.version })
    // Account the elapsed wall-clock against the session budget. If this
    // activation pushed the plugin over its quota, quarantine it (it already
    // registered, so markPluginUnstable tears it down) and require re-approval.
    const total = addSessionUsage(id, startedAt)
    if (total >= sessionQuotaMs) {
      markPluginUnstable(id, `session resource quota exceeded (${total}ms >= ${sessionQuotaMs}ms)`, 'quota-exceeded')
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
    releaseInFlight()
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
    recordPluginEvent(id, 'deactivate', 'deactivated')
  }
}
