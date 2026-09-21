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
  setDisabledPluginRecord,
} from './governance-store'
import type { DisabledPluginsRead, GovernanceSaveResult } from './governance-store'
import { resetPermissionStateForTests } from './permissions'
import { resetIntegrityStateForTests } from './integrity'
import { resetTrustPolicyStateForTests } from './trust-policy'
import { resetAuditRouterForTests } from './audit-log'
import {
  deactivateVaultPlugins,
  forgetActiveVaultPlugin,
  getActiveVaultPluginIds,
} from './vault-plugin-activate'
import { loadVaultPlugins } from './vault-plugin-load'

export interface VaultPluginSummary {
  id: string
  name: string
  version: string
  disabled: boolean
  active: boolean
  unstable: boolean
}

/** The vault's plugins, and what the stored switch state could be established as. */
export interface VaultPluginListing {
  rows: VaultPluginSummary[]
  /** What the read of the vault's switch file established. The rows' `disabled`
   *  flags come out of the in-memory record either way — this is the fact that
   *  says whether that record can be trusted to match the vault, and it is the
   *  caller's to report because a row cannot see it. */
  switches: DisabledPluginsRead
}

/**
 * List the plugins in a vault for the settings surface: manifests are read, but
 * nothing is imported or executed (`preloadVaultPlugin` only reads files). The
 * flags come from the live state, so a row always describes what is actually
 * loaded rather than what the last load happened to do.
 *
 * The switch file's state is returned beside the rows rather than logged: a
 * panel that draws every switch as "on" because the file could not be verified
 * is describing a state the app does not hold, which is the defect the toggle
 * path was fixed for (`setVaultPluginDisabled`) one layer up.
 */
export async function readVaultPlugins(vault: string): Promise<VaultPluginListing> {
  // The switch is stored in the vault's governance file, which the strict-CSP
  // build never loads through the plugin path; read it here so the rows show
  // what is actually configured.
  const switches = await refreshDisabledPlugins(vault)
  const adapter = makeVaultPluginFsAdapter(vault)
  let entries: PluginFsEntry[]
  try {
    entries = await adapter.readdir(joinPath(vault, 'plugins'))
  } catch {
    return { rows: [], switches }
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
  return { rows: out, switches }
}

/** The rows alone, for a caller that has nothing to say about the switch file's
 *  state. New callers should prefer [`readVaultPlugins`]: the state is the half
 *  a panel needs to avoid drawing switches it cannot vouch for. */
export async function listVaultPlugins(vault: string): Promise<VaultPluginSummary[]> {
  return (await readVaultPlugins(vault)).rows
}

/**
 * Switch a plugin off (or back on) for this vault. Resolves to what the app now
 * holds for the plugin and what the vault's file said about it — the two facts a
 * row, which is read back out of the in-memory record, cannot see for itself.
 *
 * Switching OFF takes effect immediately: the plugin is deactivated in the host
 * (its components, commands, toolbar buttons and lifecycle hooks are
 * unregistered, and `onUnload` runs) and every future load skips it BEFORE the
 * consent/trust/integrity gates - a plugin the user switched off must not be
 * re-asked about or have its code read, let alone run. No reload is needed: the
 * plugin is already out. The decision is written to the vault's governance file
 * in the same call, and the outcome reports whether the file took it, because a
 * decision that never reached the file is gone after a restart.
 *
 * Switching back ON is a REQUEST, not a state: it is not applied until the gates
 * (revocation, version policy, consent, trust, integrity) have re-run, which
 * happens through a fresh vault load. The file is written FIRST, because the
 * loader reads the disabled set out of that file - a file that still said
 * "disabled" would make every gate skip the plugin and the switch would report a
 * plugin as running that never came back. If the reload then refuses it, agent
 * and file both go back to disabled, so memory and file agree again. `reload` is
 * injectable so tests can observe the reload without building a whole vault.
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

/** What a toggle did, in the two facts a row cannot see for itself. */
export interface VaultPluginToggleOutcome {
  /** The state the app holds for this plugin now — what a re-read of the row shows. */
  disabled: boolean
  /** Why the request was put back, or null when it was applied. */
  refused: string | null
  /** The vault's answer for the record, or null when nothing had to be written. */
  saved: GovernanceSaveResult | null
}

/** Why a switch was put back when the file did not accept it. The row shows this
 *  reason verbatim, and the two cases have different remedies: one is a write
 *  that did not land, the other is a file someone else has changed. */
function unwrittenReason(result: Exclude<GovernanceSaveResult, 'saved'>): string {
  return result === 'tampered'
    ? "the library's plugin state file was changed outside the app, so nothing was written"
    : "the library's plugin state file could not be written"
}

export async function setVaultPluginDisabled(
  pluginId: string,
  disabled: boolean,
  opts: SetVaultPluginDisabledOptions = {},
): Promise<VaultPluginToggleOutcome> {
  // No id, no decision: the record answers both facts and nothing was written.
  if (!pluginId) return { disabled: isVaultPluginDisabled(pluginId), refused: null, saved: null }
  // '' is what the panel passes while no library is open - the absence of a
  // vault, not a path - so it falls back like an omitted one.
  const vault = opts.vault || getCurrentVault() || undefined

  if (disabled) {
    setDisabledPluginRecord(pluginId, true)
    deactivatePlugin(pluginId)
    forgetActiveVaultPlugin(pluginId)
    recordPluginEvent(pluginId, 'deactivate', 'disabled by the user')
    // No reload: re-running the gates for a plugin that is already out could
    // only ask the user about the plugin they just switched off.
    const saved = vault ? await persistDisabledPlugins(vault, pluginId) : null
    return { disabled: true, refused: null, saved }
  }

  if (!vault) {
    // Nothing can re-run the gates, so the request cannot be applied: recording
    // "enabled" here would be a state no load ever honours.
    return {
      disabled: isVaultPluginDisabled(pluginId),
      refused: 'no library is open to re-run the plugin checks against',
      saved: null,
    }
  }

  setDisabledPluginRecord(pluginId, false)
  const written = await persistDisabledPlugins(vault, pluginId)
  if (written !== 'saved') {
    // The file did not take the decision, so the app must not hold it either:
    // reloading now would only skip the plugin (the file still says disabled)
    // and the row would read "running" for a plugin that never ran.
    setDisabledPluginRecord(pluginId, true)
    return { disabled: true, refused: unwrittenReason(written), saved: written }
  }

  try {
    await (opts.reload ?? loadVaultPlugins)(vault)
  } catch (e) {
    setDisabledPluginRecord(pluginId, true)
    // A plugin the record calls disabled must not be left running: a load can
    // fail after this plugin has already been activated.
    deactivatePlugin(pluginId)
    forgetActiveVaultPlugin(pluginId)
    // Put the FILE back too: leaving it saying "enabled" would undo the refusal
    // at the next launch, which is the state the user was just told about.
    const putBack = await persistDisabledPlugins(vault, pluginId)
    return {
      disabled: true,
      refused: e instanceof Error ? e.message : String(e),
      saved: putBack,
    }
  }
  return { disabled: false, refused: null, saved: written }
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
