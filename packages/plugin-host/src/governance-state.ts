import { resetAuditLog } from './audit-log'

/* ------------------------------------------------------------------------- *
 * The governance store: the persisted schema, and the serialize/load surface
 * an embedder writes to its own storage (localStorage / a file).
 *
 * Two of the three governance concerns share this object — the version policy
 * records versions, bad versions and ranges; the revocation list owns its
 * entries — so the schema and the singleton live here rather than in either of
 * them. Keeping the store below both is what stops the two from having to
 * import each other: `version-policy.ts` and `revocation.ts` depend on this
 * module, and this module depends on neither.
 *
 * The three record shapes below are declared here for the same reason: they are
 * the persisted schema. `RecordedPluginVersion` and `PluginVersionRange` are
 * read by the version policy and `PluginRevocation` by the revocation list, but
 * a snapshot written by one host has to load into another, so their shape is
 * this module's business, not the behaviour modules'.
 * ------------------------------------------------------------------------- */

/** An inclusive-or-open lower/upper bound for a plugin's supported versions.
 *  `min`/`max` are `major.minor.patch` (or a comparator like `>=1.2.0`). */
export interface PluginVersionRange {
  min?: string
  max?: string
}

export interface RecordedPluginVersion {
  version: string
  digest?: string
  timestamp: number
}

/** A revoked plugin id (and optionally a specific version or semver range). */
export interface PluginRevocation {
  pluginId: string
  /** 'all' (default), an exact version, or a semver range (e.g. '<2.0.0'). */
  version: string
  reason?: string
  revokedAt: number
}

/** Where the persisted governance state lives (in-memory by default; the
 *  embedder may back it with localStorage / a file via serialize/load). */
interface GovernanceState {
  /** pluginId -> version -> { digest, timestamp } for every recorded version. */
  recordedPlugins: Record<string, Record<string, RecordedPluginVersion>>
  /** pluginId -> the order versions were recorded (used for last-known-good). */
  recordedOrder: Record<string, string[]>
  badVersions: Record<string, string[]>
  versionRanges: Record<string, PluginVersionRange>
  revocations: PluginRevocation[]
}

/** The in-memory store the version policy and the revocation list both mutate.
 *  Exported for those two modules only: it is a mutable singleton, and an
 *  embedder reaches this state through serializeGovernance/loadGovernance, so
 *  the package barrel re-exports this module by name and never `*`. */
export const state: GovernanceState = {
  recordedPlugins: {},
  recordedOrder: {},
  badVersions: {},
  versionRanges: {},
  revocations: [],
}

/** The union of every plugin id referenced by any governance record (recorded
 *  version, bad version, version range, or revocation). Used by an embedder to
 *  enumerate the governance state for a surface. */
export function getGovernancePluginIds(): string[] {
  const ids = new Set<string>([
    ...Object.keys(state.recordedOrder),
    ...Object.keys(state.badVersions),
    ...Object.keys(state.versionRanges),
    ...state.revocations.map((r) => r.pluginId),
  ])
  return [...ids]
}

/* -------------------- serialization (embedder store) ------------------- */

/** Serialize the governance state (versions, last-good, bad versions, ranges,
 *  revocations) to JSON so an embedder can persist it (localStorage / file). */
export function serializeGovernance(): string {
  return JSON.stringify(state)
}

/** Load a previously-serialized governance snapshot. Entries are merged; a
 *  revoked-id-only entry is preserved atomically. */
export function loadGovernance(json: string): void {
  try {
    const parsed = JSON.parse(json) as Partial<GovernanceState>
    if (parsed.recordedPlugins && typeof parsed.recordedPlugins === 'object') {
      for (const [id, byVersion] of Object.entries(parsed.recordedPlugins)) {
        state.recordedPlugins[id] = { ...(state.recordedPlugins[id] ?? {}), ...byVersion }
      }
    }
    if (parsed.recordedOrder && typeof parsed.recordedOrder === 'object') {
      for (const [id, order] of Object.entries(parsed.recordedOrder)) state.recordedOrder[id] = [...order]
    }
    if (parsed.badVersions && typeof parsed.badVersions === 'object') {
      for (const [id, list] of Object.entries(parsed.badVersions)) state.badVersions[id] = [...list]
    }
    if (parsed.versionRanges && typeof parsed.versionRanges === 'object') Object.assign(state.versionRanges, parsed.versionRanges)
    if (Array.isArray(parsed.revocations)) state.revocations = parsed.revocations.map((r) => ({ ...r }))
  } catch (err) {
    console.warn('[NekoWite:governance] failed to restore governance snapshot', err)
  }
}

/** Reset ALL in-memory governance state (audit ring + versions + revocations) to
 *  a clean baseline. Mainly for tests, and for the embedder to start a fresh
 *  governance session. */
export function resetGovernanceForTests(): void {
  resetAuditLog()
  state.recordedPlugins = {}
  state.recordedOrder = {}
  state.badVersions = {}
  state.versionRanges = {}
  state.revocations = []
}
