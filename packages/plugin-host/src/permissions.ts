import type { PluginPermission } from './types'
import { createPluginError } from './types'

/**
 * Capabilities that grant a plugin access well beyond rendering registerable
 * UI (components/toolbar/commands must go through the host). Because plugins
 * currently run in the main window context (no webview/worker sandbox), these
 * are the ones that can reach Tauri IPC or the file system, so the host treats
 * them as requiring explicit user consent before activation.
 */
export const DANGEROUS_PERMISSIONS: readonly PluginPermission[] = ['ai', 'fs', 'network']

const DANGEROUS_SET = new Set<string>(DANGEROUS_PERMISSIONS)

/** True when a plugin (or a manifest with a `permissions` field) declares at
 *  least one capability the host should gate behind user confirmation. */
export function hasDangerousPermissions(
  decl: { permissions?: PluginPermission[] } | undefined,
): boolean {
  return (decl?.permissions ?? []).some((p) => DANGEROUS_SET.has(p))
}

/** Union of declared permissions across a manifest and a plugin definition,
 *  de-duplicated but preserving the order the sources were given in. */
export function collectPluginPermissions(
  ...sources: Array<{ permissions?: PluginPermission[] } | undefined>
): PluginPermission[] {
  const out: PluginPermission[] = []
  const seen = new Set<string>()
  for (const src of sources) {
    for (const p of src?.permissions ?? []) {
      if (!seen.has(p)) {
        seen.add(p)
        out.push(p)
      }
    }
  }
  return out
}

/** True when `permission` is present in the declared set. */
export function hasPermission(
  decl: { permissions?: PluginPermission[] } | undefined,
  permission: PluginPermission,
): boolean {
  return (decl?.permissions ?? []).includes(permission)
}

/** The declared capabilities the host does NOT truly isolate. Plugins run in the
 *  main window context (no webview/worker sandbox), so fs/network/ai are only
 *  gated by user consent, not capability isolation. Returns the intersection of
 *  the merged declared permissions with the not-isolated set, preserving order. */
export function getNonIsolatedPermissions(
  ...sources: Array<{ permissions?: PluginPermission[] } | undefined>
): PluginPermission[] {
  const nonIsolated = new Set<string>(DANGEROUS_PERMISSIONS)
  return collectPluginPermissions(...sources).filter((p) => nonIsolated.has(p))
}

/**
 * Thin, observable guard for "point of use" permission checks. Call this right
 * before an action that needs a capability; if the required permission is
 * absent it throws a structured PLUGIN_PERMISSION_DENIED error (with a clear
 * ask + recovery hint) instead of silently proceeding. This is NOT full IPC
 * sandboxing — it just makes a missing permission loud and actionable. The
 * host can catch it and reject the action.
 */
export function assertPermission(
  decl: { permissions?: PluginPermission[] } | undefined,
  permission: PluginPermission,
  opts?: { pluginId?: string; detail?: string; recovery?: string },
): void {
  if (hasPermission(decl, permission)) return
  const pluginId = opts?.pluginId ?? 'unknown'
  const ask = opts?.detail ? ` to ${opts.detail}` : ''
  throw createPluginError('PLUGIN_PERMISSION_DENIED', {
    pluginId,
    message: `Plugin "${pluginId}" needs the "${permission}" permission${ask} but it was not granted.`,
    recovery: opts?.recovery ?? `Grant the "${permission}" permission in the plugin settings.`,
  })
}
