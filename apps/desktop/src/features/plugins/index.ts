/**
 * The plugins feature's public API.
 *
 * Nothing outside this feature imports one of its files by path (§13.11): a
 * caller goes through this entry point, so the internal layout
 * (services / components) can change without touching a call site, and two
 * features cannot reach into each other's internals.
 *
 * The plugin governance RULES are not re-exported from here because they are not
 * this feature's to own: revocation, version policy / rollback, the audit ring
 * and the MAC envelope live in `@nekowite/plugin-host/governance`, which is
 * environment-agnostic and equally usable from a test or a browser demo. What
 * this feature owns is the desktop half — persisting those records to a
 * vault-relative, MAC-protected file, running the gates in order, and asking the
 * user the consent / integrity / trust questions none of them can answer alone.
 *
 * Only what a caller genuinely uses is exported. The pipeline's steps (the fs
 * adapter, the manifest preload, the bounded runner, the gate helpers, the
 * record accessors) stay private: they are how the load works, not an API.
 */

/* ------------------------------ the vault ------------------------------ */

export { loadVaultPlugins } from './services/vault-plugin-load'

export { listVaultPlugins, setVaultPluginDisabled } from './services/vault-plugin-registry'
export type { SetVaultPluginDisabledOptions, VaultPluginSummary } from './services/vault-plugin-registry'

export { deactivateVaultPlugins, getActiveVaultPluginIds } from './services/vault-plugin-activate'

/** Whether THIS build can run plugin code at all (the strict-CSP webview cannot
 *  import a blob: module). The settings panel reads it to say so honestly rather
 *  than offering switches that could never take effect. */
export { isPluginImportAllowedByCsp } from './services/discovery'

/* ---------------------------- consent gates ---------------------------- */

export { askPluginPermission, setPluginPermissionDecider } from './services/permissions'
export type { PluginPermissionRequest } from './services/permissions'

/** The ids and declared capabilities of plugins running unsandboxed in the main
 *  window. Recorded by the load pipeline; there is no UI reader yet, and the
 *  record is the evidence behind the "trusted-but-unsandboxed" notice. */
export { getActiveUnsandboxedPluginIds, getUnsandboxedPermissions } from './services/permissions'

export { setPluginIntegrityDecider } from './services/integrity'
export type { PluginIntegrityRequest } from './services/integrity'

export { getPluginTrustPolicy, setPluginTrustPolicy, setPluginTrustDecider } from './services/trust-policy'
export type { PluginTrustPolicy, PluginTrustRequest } from './services/trust-policy'

/* --------------------- vault-scoped records (stored) ------------------- */

export { PLUGIN_GOVERNANCE_FILE, PLUGIN_GOVERNANCE_MACKEY_FILE } from './services/governance-file'

export {
  getPluginRecordedDigestForTest,
  getPluginTrustedKey,
  getPluginTrustedSourceIds,
  isPluginTrustedSource,
  revokeVaultPlugin,
  setPluginRecordedDigestForTest,
  setPluginTrustedKey,
  setPluginTrustedSource,
  setVaultPluginVersionRange,
} from './services/governance-store'

/* ------------------------- the audit log file -------------------------- */

export { PLUGIN_AUDIT_LOG_FILE, getVaultPluginAuditEvents, getVaultPluginAuditLogPath } from './services/audit-log'

/* ------------------------------ test seams ----------------------------- */

/** Reset every piece of in-memory plugin state this feature holds. Test-only. */
export { resetVaultPluginStateForTests } from './services/vault-plugin-registry'
