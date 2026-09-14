import { versionSatisfies } from './semver'
import {
  state,
  type PluginVersionRange,
  type RecordedPluginVersion,
} from './governance-state'

/* ------------------------------------------------------------------------- *
 * Version policy: which version of a plugin may load, and what a rollback is.
 *
 * Honest scope (documented in docs/SECURITY.md + docs/PLUGIN_SDK.md):
 *   - Version policy / rollback is BEST-EFFORT, NOT isolation. Because the host
 *     can only run code in-window (no sandbox), it will NEVER auto-run a rolled
 *     back version: a `rollbackPoint` result carries `requiresReapproval: true`
 *     and the embedder must subject it to the same digest + trust gate as any
 *     other plugin before it runs. We surface the last-known-good version so the
 *     user can make an informed decision; we do not pretend to sandbox old code.
 *
 * `isVersionAllowed` is a load gate: a plugin outside its range, or on a version
 * marked bad, must not run at all. The comparisons it rests on are in
 * `semver.ts` and must not be "tidied" — see the note there.
 * ------------------------------------------------------------------------- */

/** Record the version + digest the host is about to load for a plugin. Because a
 *  successful load implies it passed the gates, this contributes to the
 *  last-known-good baseline (unless that version is later marked bad). */
export function recordPluginVersion(pluginId: string, version: string, digest?: string): void {
  const byVersion = state.recordedPlugins[pluginId] ?? {}
  byVersion[version] = { version, digest, timestamp: Date.now() }
  state.recordedPlugins[pluginId] = byVersion
  const order = state.recordedOrder[pluginId] ?? []
  if (!order.includes(version)) order.push(version)
  state.recordedOrder[pluginId] = order
}

/** The most recently recorded version (+ digest) for a plugin, if any. */
export function getRecordedPluginVersion(pluginId: string): RecordedPluginVersion | undefined {
  const order = state.recordedOrder[pluginId] ?? []
  const latest = order[order.length - 1]
  if (!latest) return undefined
  return state.recordedPlugins[pluginId]?.[latest]
}

/** Mark a plugin version as bad (e.g. known-broken or withdrawn). A bad version
 *  is never a rollback target and is refused on load. Returns true when the
 *  version becomes disallowed. */
export function markBadVersion(pluginId: string, version: string): boolean {
  const list = state.badVersions[pluginId] ?? []
  if (!list.includes(version)) list.push(version)
  state.badVersions[pluginId] = list
  return isVersionAllowed(pluginId, version) === false
}

/** The versions recorded as bad for a plugin. */
export function getBadPluginVersions(pluginId: string): string[] {
  return [...(state.badVersions[pluginId] ?? [])]
}

/** Configure the min/max supported version range for a plugin. A version outside
 *  this range is refused on load. */
export function setPluginVersionRange(pluginId: string, range: PluginVersionRange): void {
  state.versionRanges[pluginId] = range
}

/** The configured supported-version range for a plugin, if any. */
export function getPluginVersionRange(pluginId: string): PluginVersionRange | undefined {
  return state.versionRanges[pluginId]
}

function withinRange(version: string, range: PluginVersionRange): boolean {
  if (!range.min && !range.max) return true
  const minOk = !range.min || versionSatisfies(version, range.min.startsWith('>') || range.min.startsWith('<') ? range.min : `>=${range.min}`)
  const maxOk = !range.max || versionSatisfies(version, range.max.startsWith('<') || range.max.startsWith('>') ? range.max : `<=${range.max}`)
  return minOk && maxOk
}

/** True when a plugin version may be loaded: it is not a recorded bad version and
 *  it falls within the configured supported range (if any). */
export function isVersionAllowed(pluginId: string, version: string): boolean {
  const bad = state.badVersions[pluginId] ?? []
  if (bad.includes(version)) return false
  const range = state.versionRanges[pluginId]
  if (range && !withinRange(version, range)) return false
  return true
}

/** The last-known-good version for a plugin (the most recent recorded version
 *  that was not later marked bad), or undefined. */
export function getLastKnownGoodVersion(pluginId: string): string | undefined {
  const order = state.recordedOrder[pluginId] ?? []
  const bad = new Set(state.badVersions[pluginId] ?? [])
  for (let i = order.length - 1; i >= 0; i--) {
    if (!bad.has(order[i])) return order[i]
  }
  return undefined
}

/**
 * The rollback point for an unstable plugin: the last-known-good version + its
 * recorded digest, if any. `rollbackPoint` NEVER auto-runs: a host that uses it
 * must first subject the rolled-back version to the same digest + trust gate as
 * any other plugin (see `PLUGIN_SDK.md` § rollback honesty). Returns null when
 * there is no recorded good baseline to fall back to.
 */
export function rollbackPoint(
  pluginId: string,
): { version: string; digest?: string; requiresReapproval: true } | null {
  const version = getLastKnownGoodVersion(pluginId)
  if (!version) return null
  const digest = state.recordedPlugins[pluginId]?.[version]?.digest
  return { version, digest, requiresReapproval: true }
}
