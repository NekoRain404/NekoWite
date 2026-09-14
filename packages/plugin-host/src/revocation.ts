import { versionSatisfies } from './semver'
import { state, type PluginRevocation } from './governance-state'

/* ------------------------------------------------------------------------- *
 * Revocation: what revoking a plugin means, and what it invalidates.
 *
 * Honest scope (documented in docs/SECURITY.md + docs/PLUGIN_SDK.md):
 *   - Revocation is enforced at load, BEFORE any import.
 *
 * `isPluginRevoked` is the gate that enforcement reads: it matches the version
 * being loaded against the entry's exact version or semver range, so a rule like
 * `<2.0.0` covers every version below it. That comparison is the point of the
 * rule — do not narrow it.
 * ------------------------------------------------------------------------- */

/** Revoke a plugin id (all versions) or a specific version/range. A revoked
 *  plugin is refused at load, BEFORE any import, with a clear reason. */
export function revokePlugin(pluginId: string, version: string = 'all', reason?: string): void {
  const existing = state.revocations.find((r) => r.pluginId === pluginId && r.version === version)
  if (existing) {
    existing.reason = reason ?? existing.reason
    existing.revokedAt = Date.now()
    return
  }
  state.revocations.push({ pluginId, version, reason, revokedAt: Date.now() })
}

/** Remove a revocation (defaults to the 'all' entry for a plugin id). */
export function unrevokePlugin(pluginId: string, version: string = 'all'): void {
  state.revocations = state.revocations.filter((r) => !(r.pluginId === pluginId && r.version === version))
}

/** A copy of the current revocation list. */
export function getRevokedPlugins(): PluginRevocation[] {
  return state.revocations.map((r) => ({ ...r }))
}

/** Whether a specific plugin version is revoked. Returns a structured result so
 *  the host can surface the recorded reason, never silently. */
export function isPluginRevoked(
  pluginId: string,
  version: string,
): { revoked: boolean; reason?: string; matching?: PluginRevocation } {
  const matching = state.revocations.find((r) => r.pluginId === pluginId && versionSatisfies(version, r.version))
  if (!matching) return { revoked: false }
  return { revoked: true, reason: matching.reason, matching }
}
