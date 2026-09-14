/* ------------------------------------------------------------------------- *
 * Running the given plugins in the host, and knowing which ones are running.
 *
 * This module owns everything that happens AFTER a plugin's code has been
 * imported and every gate has passed: activating it, rolling back a failing
 * activation, and reporting the failure with the plugin's name on it. It also
 * owns the resulting fact — which plugin ids this session has live — because
 * that is what a vault switch has to take back down.
 * ------------------------------------------------------------------------- */

import {
  activatePlugin,
  createPluginError,
  DEFAULT_PLUGIN_ACTIVATION_TIMEOUT_MS,
  deactivatePlugin,
} from '@nekowite/plugin-host'
import type { LoadResult, PluginErrorCode, PluginMeta } from '@nekowite/plugin-host'
import { describePluginError, notifyError } from '../../../services/errors'
import { MAX_PARALLEL_PLUGIN_LOADS, runBounded, type PreloadedPlugin } from './discovery'
import { clearUnsandboxedPlugins } from './permissions'

// Every vault plugin id this module has activated. Switching vaults must
// fully deactivate the previous vault's plugins before loading the next one;
// otherwise a plugin from vault A keeps its components/commands/lifecycle hooks
// registered in vault B (and because re-activating the same id is a silent
// no-op, going back to A would never re-register the reloaded definition).
const activeVaultPluginIds: string[] = []

// Ids whose activation has started but has not committed. They are NOT in the
// list above — the host only records a plugin as active once its init resolves —
// so a vault switch that walked that list alone never cancelled them, and they
// went on to register into the vault the app had already left.
const activatingVaultPluginIds = new Set<string>()

/** The plugin ids currently activated from the vault. */
export function getActiveVaultPluginIds(): string[] {
  return [...activeVaultPluginIds]
}

/** Record a plugin as activated for this session. */
export function markVaultPluginActive(pluginId: string): void {
  activeVaultPluginIds.push(pluginId)
}

/** Forget a plugin that was taken down (switched off), without deactivating it
 *  again — its caller already did. */
export function forgetActiveVaultPlugin(pluginId: string): void {
  const at = activeVaultPluginIds.indexOf(pluginId)
  if (at >= 0) activeVaultPluginIds.splice(at, 1)
}

/**
 * Which claim on the plugin set this is. Every `deactivateVaultPlugins` (the top
 * of each vault load, the registry's reload, the app discarding a superseded
 * one) starts a new claim, and a scan that began under an older one must not
 * activate: activation registers into a process-wide host, so a scan that was
 * overtaken by a vault switch would put the old vault's components, commands and
 * hooks on top of the set the new vault just installed - and nothing would take
 * them down again, because the load that owns them has already finished.
 */
let vaultPluginClaim = 0

/** The claim a scan must still hold at activation time (see `vaultPluginClaim`). */
export function getVaultPluginClaim(): number {
  return vaultPluginClaim
}

/** Deactivate every vault plugin loaded so far and forget their ids. */
export function deactivateVaultPlugins(): void {
  vaultPluginClaim += 1
  for (const id of activeVaultPluginIds) deactivatePlugin(id)
  activeVaultPluginIds.length = 0
  // An activation parked at its await has not committed, so the loop above
  // cannot reach it; cancel it here. This is also why the host's teardown call
  // is the one used rather than aborting `ActivatePluginOptions.signal`: the
  // abort lands in `activatePlugin`'s FAILURE branch, which quarantines the
  // plugin as unstable, where this rolls the registrations back and leaves it
  // OFF. Switching vaults is not a crash, and it must not ask the user to
  // re-approve a plugin that never misbehaved.
  for (const id of activatingVaultPluginIds) deactivatePlugin(id)
  clearUnsandboxedPlugins()
}

/**
 * Activate the consented plugins concurrently, recording the results in
 * deterministic (consented) order.
 *
 * An activation rejection is captured into an ok:false result so one failing
 * plugin cannot abort the rest. Each activation is time-boxed (async init that
 * exceeds the budget is cancelled and the plugin marked unstable). A vault
 * switch cancels an activation it catches in flight; a timeout/cancel leaves
 * the plugin deactivated and the host continues.
 */
export async function activateVaultPlugins(consented: PreloadedPlugin[]): Promise<void> {
  // The claim this batch runs under. Only the plugins past MAX_PARALLEL_PLUGIN_LOADS
  // need it: they have not reached the host yet, so the cancellation in
  // `deactivateVaultPlugins` has nothing to cancel, and a switch that freed the
  // running workers would otherwise let them start the REST of this batch into
  // the vault the app has left - the same leak, one slot further out.
  const claim = vaultPluginClaim
  const activated = await runBounded(
    consented.map((p) => async () => {
      if (claim !== vaultPluginClaim) return null
      const loadResult = p.loadResult as LoadResult
      // Two directories may declare the same plugin id (the loader does not
      // dedupe), and the host answers the second call for an id with its
      // in-flight no-op, which returns at once. Only the task that actually
      // started the activation may register the id — otherwise the no-op's
      // cleanup takes it off the cancel list while the real activation is still
      // parked, and the vault switch has nothing left to cancel.
      const started = !activatingVaultPluginIds.has(loadResult.id)
      if (started) activatingVaultPluginIds.add(loadResult.id)
      try {
        const res = await activatePlugin(loadResult, {
          timeoutMs: DEFAULT_PLUGIN_ACTIVATION_TIMEOUT_MS,
        }).catch((e) => ({
          ok: false as const,
          id: loadResult.id,
          error: e instanceof Error ? e.message : String(e),
          code: undefined as PluginErrorCode | undefined,
        }))
        return { meta: p.meta as PluginMeta, res }
      } finally {
        if (started) activatingVaultPluginIds.delete(loadResult.id)
      }
    }),
    MAX_PARALLEL_PLUGIN_LOADS,
  )
  for (const entry of activated) {
    if (!entry) continue
    const { meta, res } = entry
    if (!res.ok) {
      const code = res.code
      // A vault switch cancels the activations it caught in flight, and that is
      // not an outcome to report: the app cancelled on the user's behalf, there
      // is nothing they can do about it, and a switch that catches several
      // plugins would raise one error per plugin over a routine action. The
      // claim is what tells the two cancellations apart — a switch bumps it
      // (`deactivateVaultPlugins`), while the plugin the user switched OFF goes
      // through `deactivatePlugin` without starting a new vault load, so that
      // one keeps the message its own action produced. Either way the host has
      // already recorded the cancel event in the audit log.
      if (code === 'PLUGIN_ABORTED' && claim !== vaultPluginClaim) continue
      // A structured timeout/cancel is routed to a distinct message; anything
      // else is a generic activation failure. In all cases the plugin was
      // already rolled back/marked unstable by the host, so the host continues.
      const error =
        code === 'PLUGIN_HOOK_TIMEOUT'
          ? createPluginError('PLUGIN_HOOK_TIMEOUT', {
              pluginId: res.id,
              message: `Plugin "${meta.name}" exceeded its activation time budget and was cancelled.`,
              recovery: 'Disable the plugin or check its logs.',
            })
          : code === 'PLUGIN_ABORTED'
            ? createPluginError('PLUGIN_ABORTED', {
                pluginId: res.id,
                message: `Plugin "${meta.name}" activation was cancelled.`,
                recovery: 'Retry activation, or disable the plugin.',
              })
            : code === 'PLUGIN_UNSTABLE'
              ? createPluginError('PLUGIN_UNSTABLE', {
                  pluginId: res.id,
                  message: `Plugin "${meta.name}" is in an unstable state and requires re-approval before it can run again.`,
                  recovery: 'Re-approve it by reloading the vault: a reload resets the quarantine and retries it.',
                })
              : code === 'PLUGIN_QUOTA_EXCEEDED'
                ? createPluginError('PLUGIN_QUOTA_EXCEEDED', {
                    pluginId: res.id,
                    message: `Plugin "${meta.name}" exceeded its session resource quota and was deactivated; re-approve it to run again.`,
                    recovery: 'Re-approve it by reloading the vault to grant a fresh session budget.',
                  })
                : createPluginError('PLUGIN_ACTIVATE_FAILED', {
                    pluginId: res.id,
                    message: `Plugin "${meta.name}" failed to activate: ${res.error ?? ''}`,
                    recovery: 'Disable and re-enable the plugin, or reinstall it.',
                  })
      notifyError(describePluginError(error))
      console.warn(`[NekoWite] vault plugin failed to activate: ${res.id}`, error)
      continue
    }
    markVaultPluginActive(res.id)
    console.info(`[NekoWite] vault plugin activated: ${res.id}`)
  }
}
