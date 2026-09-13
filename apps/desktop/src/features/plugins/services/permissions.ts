/* ------------------------------------------------------------------------- *
 * Capability consent, and the unsandboxed-capability signal (task #23/#28).
 *
 * This is the gate that decides whether the USER agreed to the capabilities a
 * plugin declares; the host's own permission model (which capabilities exist,
 * which are dangerous, the point-of-use assertion) lives in
 * `@nekowite/plugin-host/permissions`. What is owned here is the desktop
 * session's consent record and the question it asks.
 * ------------------------------------------------------------------------- */

import {
  collectPluginPermissions,
  createPluginError,
  hasDangerousPermissions,
} from '@nekowite/plugin-host'
import type { PluginDefinition, PluginMeta, PluginPermission } from '@nekowite/plugin-host'
import { describePluginError, notifyError } from '../../../services/errors'
import { getCurrentVault, vaultScopedKey } from './governanceStore'

// Per-session permission verdicts, keyed by vault + plugin id (NOT by id alone:
// approving a dangerous plugin in vault A must never silently authorise a
// different plugin that happens to share the id in vault B). The verdict is
// remembered for the session so a plugin is not re-prompted on every vault
// switch — including a DENIAL, which is the safe verdict: re-asking for a plugin
// the user already refused each time they switch vaults is nagging, and the
// refusal message now names the recovery that actually works (a restart starts a
// fresh session; reloading a vault cannot clear a session verdict).
const permissionDecisions = new Map<string, boolean>()

type PermissionDecider = (
  meta: PluginMeta,
  permissions: PluginPermission[],
) => Promise<boolean>

let permissionDecider: PermissionDecider | null = null

/** A pending permission question for the host to render. `resolve(true)` grants
 *  dangerous capabilities; `resolve(false)` skips the plugin's activation. */
export interface PluginPermissionRequest {
  meta: PluginMeta
  permissions: PluginPermission[]
  resolve: (allowed: boolean) => void
}

/** Install the callback used to confirm dangerous capabilities before a plugin
 *  is activated. Pass `null` to fall back to the safe default (deny). */
export function setPluginPermissionDecider(fn: PermissionDecider | null): void {
  permissionDecider = fn
}

/**
 * Ask the user to grant a plugin's declared dangerous capabilities, caching the
 * verdict for the session under (vault, plugin id, capabilities).
 *
 * The verdict is keyed by the CAPABILITY SET as well as the plugin, because a
 * plugin declares permissions in two places: its manifest, and its code — and
 * the code's declarations are only visible after the module is imported. Keying
 * by (vault, id) alone meant a plugin the user approved for `fs` could later add
 * `ai` (or `network`) inside its own code and be activated without any further
 * prompt, while the "trusted but unsandboxed" notice cheerfully listed the new
 * capability among those "already approved". Approving `fs` is not approving
 * `network`; a new capability is a new question.
 *
 * Callers inside a vault scan pass the vault explicitly so the verdict is scoped
 * to it; a call with no vault (a test, or a caller outside a scan) is cached
 * under the empty vault and never merged with a real vault's slot.
 */
export async function askPluginPermission(
  meta: PluginMeta,
  definition: PluginDefinition,
  vault: string | null = getCurrentVault(),
): Promise<boolean> {
  // Merge manifest- and definition-declared permissions. Pure UI plugins declare
  // nothing and always pass; anything reaching the user is a dangerous one.
  const declared = collectPluginPermissions(meta, definition)
  if (!hasDangerousPermissions({ permissions: declared })) return true
  const key = `${vaultScopedKey(vault, meta.id)}::${[...declared].sort().join(',')}`
  const cached = permissionDecisions.get(key)
  if (typeof cached === 'boolean') return cached
  // Safe default: without an installed decider, deny risky plugins.
  const decision = permissionDecider ? await permissionDecider(meta, declared) : false
  permissionDecisions.set(key, decision)
  return decision
}

/* ------------------------------------------------------------------------- *
 * Unsandboxed-capability signal. Plugins run in the main window (no
 * webview/worker sandbox), so a declaration of fs/network/ai is consent-gated
 * but NOT capability-isolated. We surface a clear, observable notice that the
 * plugin is "trusted-but-unsandboxed" rather than pretending to sandbox it.
 * ------------------------------------------------------------------------- */

const unsandboxedVaultPlugins = new Map<string, PluginPermission[]>()
const unsandboxedNotified = new Set<string>()

/** The ids of active vault plugins that declare non-isolated capabilities. */
export function getActiveUnsandboxedPluginIds(): string[] {
  return [...unsandboxedVaultPlugins.keys()]
}

/** The declared non-isolated capabilities for a plugin (fs/network/ai). */
export function getUnsandboxedPermissions(id: string): PluginPermission[] {
  return unsandboxedVaultPlugins.get(id) ?? []
}

/** Record a plugin as trusted-but-unsandboxed and, once per session, surface a
 *  user-visible notice so a declared capability is never silently "confirmed". */
export function signalUnsandboxedCapabilities(
  meta: PluginMeta,
  permission: PluginPermission[],
): void {
  if (permission.length === 0) return
  unsandboxedVaultPlugins.set(meta.id, permission)
  if (unsandboxedNotified.has(meta.id)) return
  unsandboxedNotified.add(meta.id)
  const listing = permission.join(', ')
  const verb = permission.length === 1 ? 'capability is' : 'capabilities are'
  console.warn(
    `[NekoWite] plugin "${meta.id}" is trusted-but-unsandboxed; it declared ${listing} which run in the main window (no capability isolation).`,
  )
  notifyError(
    describePluginError(
      createPluginError('PLUGIN_UNSANDBOXED', {
        pluginId: meta.id,
        message: `Plugin "${meta.name}" runs unsandboxed in the main window; its ${listing} ${verb} NOT isolated.`,
        recovery: 'Only approve plugins from a source you trust.',
      }),
    ),
  )
}

/** Forget every unsandboxed record (a vault switch must not carry vault A's
 *  declared capabilities into vault B). */
export function clearUnsandboxedPlugins(): void {
  unsandboxedVaultPlugins.clear()
  unsandboxedNotified.clear()
}

/** Drop the session's consent verdicts and decider (test-only). */
export function resetPermissionStateForTests(): void {
  permissionDecisions.clear()
  permissionDecider = null
  unsandboxedVaultPlugins.clear()
  unsandboxedNotified.clear()
}
