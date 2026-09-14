import { parseSemver, versionSatisfies } from './semver'
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

/** Whether revocation `range` covers `version`.
 *
 *  An id-wide revocation ('all' / '*') covers everything, and a comparable
 *  version is judged against the range on its merits. A version the host cannot
 *  parse is a DIFFERENT answer from "provably outside the range", and it must
 *  not be read as one: `loadPluginsFromDir` takes the manifest's `version` field
 *  verbatim, so a withdrawn plugin can present `"1.0"` and no comparator can
 *  evaluate it — answering "not revoked" there fails OPEN, letting the one
 *  plugin the rule exists to stop load. An unevaluable revocation therefore
 *  refuses. `isVersionAllowed` independently fails closed on the same input
 *  (its synthesised `>=min` matches nothing either), so both gates agree.
 *
 *  This stays local to revocation on purpose: `versionSatisfies` is shared with
 *  the version policy, which relies on an unparseable version being "not in
 *  range", so the comparator's answer must not be changed for this gate. */
function revocationCovers(version: string, range: string): boolean {
  if (versionSatisfies(version, range)) return true
  return parseSemver(version) === null
}

/** Whether a specific plugin version is revoked. Returns a structured result so
 *  the host can surface the recorded reason, never silently — including when the
 *  reason is that the version could not be compared at all. */
export function isPluginRevoked(
  pluginId: string,
  version: string,
): { revoked: boolean; reason?: string; matching?: PluginRevocation } {
  const matching = state.revocations.find((r) => r.pluginId === pluginId && revocationCovers(version, r.version))
  if (!matching) return { revoked: false }
  const compared = parseSemver(version) !== null || versionSatisfies(version, matching.version)
  const reason = compared
    ? matching.reason
    : `${matching.reason ? `${matching.reason}; ` : ''}declared version "${version}" cannot be compared against the revocation and is refused rather than assumed unrevoked`
  return { revoked: true, reason, matching }
}
