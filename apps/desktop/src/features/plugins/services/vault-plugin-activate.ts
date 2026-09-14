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

/** Deactivate every vault plugin loaded so far and forget their ids. */
export function deactivateVaultPlugins(): void {
  for (const id of activeVaultPluginIds) deactivatePlugin(id)
  activeVaultPluginIds.length = 0
  clearUnsandboxedPlugins()
}

/**
 * Activate the consented plugins concurrently, recording the results in
 * deterministic (consented) order.
 *
 * An activation rejection is captured into an ok:false result so one failing
 * plugin cannot abort the rest. Each activation is time-boxed (async init that
 * exceeds the budget is cancelled and the plugin marked unstable), and a single
 * AbortController lets the host cancel a running activation (e.g. when the user
 * switches vaults). A timeout/cancel leaves the plugin deactivated and the host
 * continues.
 */
export async function activateVaultPlugins(consented: PreloadedPlugin[]): Promise<void> {
  const activationController = new AbortController()
  const activated = await runBounded(
    consented.map((p) => async () => {
      const loadResult = p.loadResult as LoadResult
      const res = await activatePlugin(loadResult, {
        signal: activationController.signal,
        timeoutMs: DEFAULT_PLUGIN_ACTIVATION_TIMEOUT_MS,
      }).catch((e) => ({
        ok: false as const,
        id: loadResult.id,
        error: e instanceof Error ? e.message : String(e),
        code: undefined as PluginErrorCode | undefined,
      }))
      return { meta: p.meta as PluginMeta, res }
    }),
    MAX_PARALLEL_PLUGIN_LOADS,
  )
  for (const { meta, res } of activated) {
    if (!res.ok) {
      // A structured timeout/cancel is routed to a distinct message; anything
      // else is a generic activation failure. In all cases the plugin was
      // already rolled back/marked unstable by the host, so the host continues.
      const code = res.code
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
