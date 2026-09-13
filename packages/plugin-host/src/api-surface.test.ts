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
