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
  decl: { permissions?: readonly PluginPermission[] } | undefined,
): boolean {
  return (decl?.permissions ?? []).some((p) => DANGEROUS_SET.has(p))
}

/** Union of declared permissions across a manifest and a plugin definition,
 *  de-duplicated but preserving the order the sources were given in. */
export function collectPluginPermissions(
  ...sources: Array<{ permissions?: readonly PluginPermission[] } | undefined>
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

/**
 * What a plugin DECLARED, read from the plugin's own object exactly once — the
 * one read every consumer must use.
 *
 * `definition` is the plugin's module export, taken BY REFERENCE (loader.ts) and
 * never cloned, so `definition.permissions` may be an accessor that answers
 * differently each time it is read. The gate that asks the user reads it to
 * decide whether there is anything to ask about; activation reads it again,
 * several awaits later, to decide whether to hand over `ctx.ai`. A getter that
 * answers `[]` to the question and `['ai']` to the grant therefore buys the app's
 * AI key and the user's bill without a dialog ever being shown.
 *
 * So the host reads it here, once: the answer is copied into a host-owned array,
 * frozen, and remembered against the definition object itself. Every consumer
 * asks this function instead of reading the object again, which is what makes the
 * fix cover the class rather than the trick — a second accessor, a later
 * assignment, or a Proxy that keeps answering cannot be consulted at all, because
 * there is no second read to consult. (Freezing the definition would not snap a
 * getter's value, and rewriting the property in place is defeatable: a Proxy's
 * `defineProperty` trap can report success while its `get` trap goes on lying.)
 */
const pinnedDeclarations = new WeakMap<object, readonly PluginPermission[]>()

export function declaredPermissionsOf(
  meta: { permissions?: readonly PluginPermission[] } | undefined,
  definition: { permissions?: readonly PluginPermission[] } | undefined,
): readonly PluginPermission[] {
  const holder: unknown = definition
  // A function is a legal module export and can carry the property, so it is a
  // cache key too; only a non-object has no accessor to vary and nothing to key.
  const key =
    holder !== null && (typeof holder === 'object' || typeof holder === 'function')
      ? (holder as object)
      : undefined
  const pinned = key ? pinnedDeclarations.get(key) : undefined
  if (pinned) return pinned

  const declared = Object.freeze(collectPluginPermissions(meta, definition))
  if (key) pinnedDeclarations.set(key, declared)
  return declared
}

/** True when `permission` is present in the declared set. */
export function hasPermission(
  decl: { permissions?: readonly PluginPermission[] } | undefined,
  permission: PluginPermission,
): boolean {
  return (decl?.permissions ?? []).includes(permission)
}

/** The declared capabilities the host does NOT truly isolate. Plugins run in the
 *  main window context (no webview/worker sandbox), so fs/network/ai are only
 *  gated by user consent, not capability isolation. Returns the intersection of
 *  the merged declared permissions with the not-isolated set, preserving order. */
export function getNonIsolatedPermissions(
  ...sources: Array<{ permissions?: readonly PluginPermission[] } | undefined>
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
  decl: { permissions?: readonly PluginPermission[] } | undefined,
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
