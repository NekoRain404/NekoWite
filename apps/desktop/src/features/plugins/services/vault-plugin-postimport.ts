/* ------------------------------------------------------------------------- *
 * The gates that can only run AFTER a plugin's code has been imported.
 *
 * Until the module was executed, everything the app knew about a plugin's
 * capabilities came from its manifest. A plugin may declare more in its code, so
 * the consent question is asked again with that declaration in hand, the
 * declared set is asserted at the point of use, and a capability the host does
 * not isolate is surfaced rather than pretended away. This module owns that
 * sequence; the vault scan (./vault-plugin-load) owns WHEN it runs, and what a
 * permission MEANS stays with ./permissions and the host's own permission model.
 * ------------------------------------------------------------------------- */

import {
  assertPermission,
  createPluginError,
  declaredPermissionsOf,
  getNonIsolatedPermissions,
  recordPluginEvent,
} from '@nekowite/plugin-host'
import type { PluginDefinition, PluginMeta } from '@nekowite/plugin-host'
import { describePluginError, notifyError } from '../../../services/errors'
import { t } from '../../../i18n'
import { setRecordedDigest } from './governance-store'
import { askPluginPermission, signalUnsandboxedCapabilities } from './permissions'

export interface PostImportGateInput {
  meta: PluginMeta
  /** The plugin's module export, taken by reference by the loader — every read of
   *  its declaration below goes through `declaredPermissionsOf`. */
  definition: PluginDefinition
  vault: string
  /** The fingerprint to adopt as the approved baseline once the plugin is clear
   *  to run, or null when the integrity gate had none to record. */
  baseline: { id: string; version: string; digest: string } | null
}

/**
 * Run the post-import gates for one plugin. Returns whether it may be activated:
 * false means the caller must drop it (the denial has already been surfaced).
 */
export async function applyPostImportGates(input: PostImportGateInput): Promise<boolean> {
  const { meta, definition, vault, baseline } = input

  // Post-import defensive consent: a plugin may declare capabilities in its
  // code that were not in the manifest. Re-verify the merged set so a
  // code-level declaration is still consent-gated. (Top-level has run by now,
  // but we refuse to register/activate the plugin and surface the denial.)
  if (!(await askPluginPermission(meta, definition, vault))) {
    // Pinned, like the host's own grant: a live read of `permissions` can
    // answer differently, and this text must describe what was denied.
    const declared = declaredPermissionsOf(meta, definition)
    recordPluginEvent(meta.id, 'permission-denied', `declared permissions: ${declared.join(', ') || 'none'}`, { version: meta.version })
    notifyError(
      describePluginError(
        createPluginError('PLUGIN_PERMISSION_DENIED', {
          pluginId: meta.id,
          message:
            declared.length > 0
              ? `Plugin "${meta.name}" requires permission(s): ${declared.join(', ')} but consent was not granted.`
              : t('plugin.permissionSkipped', { name: meta.name }),
          // A denial is cached for the session (see the permission verdicts in
          // ./permissions), so reloading the vault cannot re-ask — only a
          // restart starts a session where the plugin is asked about again.
          recovery: 'Restart NekoWrite to be asked again (a denial is remembered for this session), or remove the plugin.',
        }),
      ),
    )
    return false
  }

  // Point-of-use guard: re-verify every declared permission is present before
  // activation; a missing capability rejects loudly instead of silently
  // proceeding. Today consent is all-or-nothing, so the granted set equals the
  // declared set — this is where a future per-capability grant is enforced.
  // Through the pin, so the guard reads the set the host granted from.
  const granted = declaredPermissionsOf(meta, definition)
  for (const permission of granted) {
    assertPermission({ permissions: granted }, permission, {
      pluginId: meta.id,
      detail: 'activate its declared capabilities',
    })
  }

  // Adopt the (re-)approved fingerprint as the new baseline now that we have
  // committed to running this plugin.
  if (baseline) setRecordedDigest(vault, baseline.id, baseline.version, baseline.digest)

  // A declared capability is not capability-isolated while the plugin runs in
  // the main window; once we have decided to run it, make that explicit rather
  // than pretending to sandbox it.
  const nonIsolated = getNonIsolatedPermissions({ permissions: declaredPermissionsOf(meta, definition) })
  signalUnsandboxedCapabilities(meta, nonIsolated)
  return true
}
