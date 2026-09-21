import { describe, expect, it } from 'vitest'
import * as pluginHost from './index'

// The stable public API surface of `@nekowite/plugin-host`. This is the curated
// barrel (`index.ts`); plugin authors and the desktop host are expected to
// depend ONLY on these names, never on a deep path into the package. Removing
// or renaming any of these is a breaking change to the plugin SDK and must fail
// this snapshot so the change is deliberate and versioned (see
// docs/PLUGIN_SDK.md § API versioning).
const REQUIRED_RUNTIME_EXPORTS = [
  // version
  'version',
  // types.ts
  'definePlugin',
  'createPluginError',
  'PluginError',
  // loader.ts
  'joinPath',
  'loadPlugin',
  'loadPluginsFromDir',
  'computePluginDigest',
  'verifyPluginIntegrity',
  // runtime.ts
  'activatePlugin',
  'deactivatePlugin',
  'markPluginUnstable',
  'getUnstablePluginIds',
  'isPluginUnstable',
  'resetUnstablePlugin',
  // lifecycle.ts
  'setActiveEditor',
  'getActiveEditor',
  'registerLifecycleHook',
  'hasLifecycleListeners',
  'onLifecycleError',
  'emitLifecycle',
  'reportPluginCallbackError',
  // permissions.ts
  'DANGEROUS_PERMISSIONS',
  'hasDangerousPermissions',
  'collectPluginPermissions',
  'hasPermission',
  'getNonIsolatedPermissions',
  'assertPermission',
  // governance.ts
  'recordPluginEvent',
  'onPluginEvent',
  'getAuditLog',
  'clearAuditLog',
  'sanitizeAuditDetail',
  'flushAuditLogToFile',
  'loadAuditLogFromFile',
  'recordPluginVersion',
  'getRecordedPluginVersion',
  'markBadVersion',
  'setPluginVersionRange',
  'isVersionAllowed',
  'getLastKnownGoodVersion',
  'rollbackPoint',
  'revokePlugin',
  'unrevokePlugin',
  'isPluginRevoked',
  'getRevokedPlugins',
  // The names below were missing from this list until 2026-09-22, and the gap was
  // invisible because both sides agreed with the document rather than with the
  // barrel: `docs/PLUGIN_SDK.md` §1 names them as part of the surface, the barrel
  // exports them, and nothing required them — so any of them could have been
  // deleted with this snapshot still green, which is the one thing it exists to
  // prevent. (`docs/DOC-AUDIT.md` §1.3 counted 17 of 62; those counts are wrong,
  // the finding is not.)
  //
  // **Counts, measured twice.** The first pass said the barrel re-exports 74 runtime
  // values and that the eleven it found were the whole gap. Both were wrong: the
  // scan followed one level of `export *`, and the quota family reaches the barrel
  // through `runtime.ts`'s own `export * from './activation-registry'` two levels
  // down. A recursive walk gives the real figures — **90** values re-exported,
  // **63** now required here, and the six quota names below were still unenforced
  // after the first pass claimed the table was covered. The lesson is on the record
  // because it is the one this file is about: a reading that was not checked against
  // its own method.
  //
  // They stay because the document says they are public: the signature family a
  // publisher needs, the hook-timeout budget, the audit-log file sink, the
  // governance serialize/load pair — the embedder's only supported way into the
  // singletons — and the quota/in-flight readings a caller needs to reason about a
  // plugin that was quarantined. Removing one is now a deliberate change to this
  // list.
  //
  // signatures / trust
  'createPluginSignature',
  'verifyPluginSignature',
  'buildPluginSignaturePayload',
  'encodePluginKeyMaterial',
  'publisherIdOf',
  // lifecycle
  'setLifecycleHookTimeout',
  'getLifecycleHookTimeout',
  // audit log
  'setAuditLogFileSink',
  'getPluginAuditEvents',
  // governance state
  'serializeGovernance',
  'loadGovernance',
  // resource quota (through runtime.ts → activation-registry.ts)
  'getInFlightActivationCount',
  'getMaxInFlightActivations',
  'setMaxInFlightActivations',
  'getPluginSessionQuota',
  'setPluginSessionQuota',
  'getPluginSessionUsage',
] as const

describe('plugin-host public API surface', () => {
  it('exposes every stable runtime export (removing one fails this snapshot)', () => {
    for (const name of REQUIRED_RUNTIME_EXPORTS) {
      expect(pluginHost, `plugin-host must export "${name}"`).toHaveProperty(name)
    }
  })

  it('keeps the exported version stable and explicit', () => {
    expect(typeof pluginHost.version).toBe('string')
    expect(pluginHost.version.length).toBeGreaterThan(0)
  })

  it('does not leak a deep-path namespace into the barrel', () => {
    // The plugin SDK contract is that consumers import from the root only. A
    // barrel that re-exports a module namespace (e.g. `* as loader`) would force
    // consumers into an unstable `pluginHost.loader.*` shape; assert the barrel
    // stays flat for the core modules by checking the loader's named exports are
    // available at the top level (already asserted above) and no `loader`
    // / `lifecycle` / `permissions` namespace keys exist.
    for (const ns of ['loader', 'lifecycle', 'permissions', 'runtime', 'types']) {
      expect(pluginHost).not.toHaveProperty(ns)
    }
  })
})
