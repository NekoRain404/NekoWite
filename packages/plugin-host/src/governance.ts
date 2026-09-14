/* ------------------------------------------------------------------------- *
 * Plugin governance: audit log, version policy / rollback, & revocation.
 *
 * Compatibility surface — the implementation moved to the modules below, and
 * nothing outside this package should import them directly:
 *
 *   audit-log.ts          what gets recorded and the record shape, + its file sink
 *   version-policy.ts     which version may load, and what a rollback point is
 *   revocation.ts         what revoking a plugin means and what it invalidates
 *   governance-state.ts   the persisted schema, and the serialize/load surface
 *   mac-envelope.ts       tamper-detection over that persisted state
 *   semver.ts             the version comparisons both load gates rest on
 *   governance-refusal.ts the error a gate refuses a load with
 *
 * These are the *policy* functions that sit on top of the loader/trust/integrity
 * gates. They are environment-agnostic (no `localStorage`, no `node:fs`, no Tauri
 * IPC): all persistent state is held in memory and exposed via a deliberate
 * serialize/load surface so an embedding host (the desktop app) can persist it to
 * its own store (localStorage) and/or to a file through its file service. This is
 * the same injection pattern the loader uses for `PluginFsAdapter` /
 * `PluginDigestStore`.
 *
 * Honest scope (documented in docs/SECURITY.md + docs/PLUGIN_SDK.md) travels with
 * the code it constrains: the audit log's non-secrecy in `audit-log.ts`, version
 * policy's best-effort status in `version-policy.ts`, and revocation's
 * load-time enforcement in `revocation.ts`.
 * ------------------------------------------------------------------------- */

export * from './audit-log'
export * from './semver'
export * from './mac-envelope'
export * from './version-policy'
export * from './revocation'
export * from './governance-refusal'

// governance-state.ts is re-exported by name, never `*`: it holds the mutable
// singleton both the version policy and the revocation list write to, and an
// embedder's supported way in is serializeGovernance/loadGovernance.
export type { PluginVersionRange, RecordedPluginVersion, PluginRevocation } from './governance-state'
export {
  serializeGovernance,
  loadGovernance,
  getGovernancePluginIds,
  resetGovernanceForTests,
} from './governance-state'
