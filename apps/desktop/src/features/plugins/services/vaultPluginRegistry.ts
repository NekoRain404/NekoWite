/* ------------------------------------------------------------------------- *
 * The settings-facing view of a vault's plugins, and the user's on/off switch.
 *
 * This module owns the two questions the app asks about vault plugins that are
 * not "should this one run": WHAT the settings panel should show for a vault,
 * and HOW the user switches a plugin off (or back on). It gates nothing itself —
 * it reports the state the gates leave behind, and switching a plugin back on
 * re-runs every gate by reloading the vault.
 * ------------------------------------------------------------------------- */

import { deactivatePlugin, isPluginUnstable, joinPath, recordPluginEvent } from '@nekowite/plugin-host'
import type { PluginFsEntry } from '@nekowite/plugin-host'
import {
  MAX_PARALLEL_PLUGIN_LOADS,
  makeVaultPluginFsAdapter,
  preloadVaultPlugin,
  resetDiscoveryStateForTests,
  runBounded,
} from './discovery'
import {
  getCurrentVault,
  isVaultPluginDisabled,
  persistDisabledPlugins,
  refreshDisabledPlugins,
  resetGovernanceStoreForTests,
  scheduleGovernanceSave,
  setDisabledPluginRecord,
} from './governanceStore'
import { resetPermissionStateForTests } from './permissions'
import { resetIntegrityStateForTests } from './integrity'
import { resetTrustPolicyStateForTests } from './trustPolicy'
import { resetAuditRouterForTests } from './auditLog'
import {
  deactivateVaultPlugins,
  forgetActiveVaultPlugin,
  getActiveVaultPluginIds,
} from './vaultPluginActivate'
import { loadVaultPlugins } from './vaultPluginLoad'

export interface VaultPluginSummary {
  id: string
  name: string
  version: string
  disabled: boolean
  active: boolean
  unstable: boolean
}

/**
 * List the plugins in a vault for the settings surface: manifests are read, but
 * nothing is imported or executed (`preloadVaultPlugin` only reads files). The
 * flags come from the live state, so a row always describes what is actually
 * loaded rather than what the last load happened to do.
 */
export async function listVaultPlugins(vault: string): Promise<VaultPluginSummary[]> {
  // The switch is stored in the vault's governance file, which the strict-CSP
  // build never loads through the plugin path; read it here so the rows show
  // what is actually configured.
  await refreshDisabledPlugins(vault)
  const adapter = makeVaultPluginFsAdapter(vault)
  let entries: PluginFsEntry[]
  try {
    entries = await adapter.readdir(joinPath(vault, 'plugins'))
  } catch {
    return []
  }
  // Same shape the loader uses: only directories are candidate plugins.
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  const preloaded = await runBounded(
    dirs.map((name) => () => preloadVaultPlugin(adapter, vault, name)),
    MAX_PARALLEL_PLUGIN_LOADS,
  )
  const active = new Set(getActiveVaultPluginIds())
  const out: VaultPluginSummary[] = []
  for (const p of preloaded) {
    const meta = p.meta
    if (!meta) continue
    out.push({
      id: meta.id,
      name: meta.name,
      version: meta.version,
      disabled: isVaultPluginDisabled(meta.id),
      active: active.has(meta.id),
      unstable: isPluginUnstable(meta.id),
    })
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

/**
 * Switch a plugin off (or back on) for this vault.
 *
 * Switching OFF takes effect immediately: the plugin is deactivated in the host
 * (its components, commands, toolbar buttons and lifecycle hooks are
 * unregistered, and `onUnload` runs) and every future load skips it BEFORE the
 * consent/trust/integrity gates - a plugin the user switched off must not be
 * re-asked about or have its code read, let alone run. The decision is
 * persisted, so it survives a restart and a vault switch.
 *
 * Switching back ON has to re-run the gates (revocation, version policy,
 * consent, trust, integrity) because none of them stopped being relevant while
 * it was off: it happens through a fresh vault load, which is exactly that
 * sequence. `reload` is injectable so tests can observe the reload without
 * building a whole vault.
 */
export interface SetVaultPluginDisabledOptions {
  /** The vault this decision belongs to. Supplied by the settings panel, which
   *  knows it; without it the decision could only be saved when a plugin load
   *  had already set the module's current vault - and the strict-CSP build never
   *  reaches that point, so the switch would look like it worked and be gone
   *  after a restart (measured on the device). */
  vault?: string
  /** How to re-run the gates when a plugin is switched back on. Injectable so
   *  tests can observe the reload without building a vault. */
  reload?: (vault: string) => Promise<void>
}

export function setVaultPluginDisabled(
  pluginId: string,
  disabled: boolean,
  opts: SetVaultPluginDisabledOptions = {},
): void {
  if (!pluginId) return
  if (disabled) {
    setDisabledPluginRecord(pluginId, true)
    deactivatePlugin(pluginId)
    forgetActiveVaultPlugin(pluginId)
    recordPluginEvent(pluginId, 'deactivate', 'disabled by the user')
  } else {
    setDisabledPluginRecord(pluginId, false)
  }
  // Persist against the vault the user is looking at. The read-modify-write
  // keeps this file's other records (trust, revocations, digests) intact.
  if (opts.vault) void persistDisabledPlugins(opts.vault)
  else scheduleGovernanceSave()
  const reload = opts.reload ?? loadVaultPlugins
  const vault = opts.vault ?? getCurrentVault() ?? undefined
  // Enabling has to re-run every gate, and the reload is the one path that does
  // it in order. Disabling needs no reload: the plugin is already out.
  if (!disabled && vault) void reload(vault).catch(() => undefined)
}

/** Reset in-memory state (active ids, permission verdicts, deciders, unsandboxed
 *  registry, trust config, integrity baselines, governance). Test-only. */
export function resetVaultPluginStateForTests(): void {
  deactivateVaultPlugins()
  resetPermissionStateForTests()
  resetIntegrityStateForTests()
  resetTrustPolicyStateForTests()
  resetDiscoveryStateForTests()
  resetGovernanceStoreForTests()
  resetAuditRouterForTests()
}
