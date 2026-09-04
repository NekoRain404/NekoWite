import type { PluginPermission } from './types'

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
