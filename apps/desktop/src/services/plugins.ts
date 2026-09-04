import {
  activatePlugin,
  deactivatePlugin,
  hasDangerousPermissions,
  loadPlugin,
} from '@nekowite/plugin-host'
import type { PluginDefinition, PluginMeta, PluginPermission } from '@nekowite/plugin-host'
import { fsService } from './fs'
import { notifyError } from './errors'
import { t } from '../i18n'

interface VaultPluginPackage {
  name?: string
  version?: string
  main?: string
  permissions?: PluginPermission[]
}

function joinVault(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/')
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  )
}

// Every vault plugin id this module has activated. Switching vaults must
// fully deactivate the previous vault's plugins before loading the next one;
// otherwise a plugin from vault A keeps its components/commands/lifecycle hooks
// registered in vault B (and because re-activating the same id is a silent
// no-op, going back to A would never re-register the reloaded definition).
const activeVaultPluginIds: string[] = []

// Per-session permission verdicts, so a plugin the user already approved (or
// denied) is not re-prompted on every vault switch.
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

/** Permissions declared by a plugin's manifest (package.json `permissions`). */
export function getPluginPermissions(meta: PluginMeta): PluginPermission[] {
  return meta.permissions ?? []
}

/** The plugin ids currently activated from the vault. */
export function getActiveVaultPluginIds(): string[] {
  return [...activeVaultPluginIds]
}

export async function askPluginPermission(meta: PluginMeta, definition: PluginDefinition): Promise<boolean> {
  // Merge manifest- and definition-declared permissions. Pure UI plugins declare
  // nothing and always pass; anything reaching the user is a dangerous one.
  const declared = [...getPluginPermissions(meta), ...(definition.permissions ?? [])]
  if (!hasDangerousPermissions({ permissions: declared })) return true
  const cached = permissionDecisions.get(meta.id)
  if (typeof cached === 'boolean') return cached
  // Safe default: without an installed decider, deny risky plugins.
  const decision = permissionDecider ? await permissionDecider(meta, declared) : false
  permissionDecisions.set(meta.id, decision)
  return decision
}

/** Deactivate every vault plugin loaded so far and forget their ids. */
export function deactivateVaultPlugins(): void {
  for (const id of activeVaultPluginIds) deactivatePlugin(id)
  activeVaultPluginIds.length = 0
}

/** Read a plugin's JS source from the vault and evaluate it as an ES module via
 *  a blob URL. In the Tauri app the webview has no Node fs access, so the source
 *  is read through the Rust commands; the "vite-ignore" annotation keeps Vite
 *  from statically analyzing the runtime blob specifier. Bare imports inside
 *  the plugin (e.g. `import { defineComponent } from 'vue'`) will NOT resolve
 *  from a blob URL — a vault plugin must be self-contained or use absolute URLs
 *  — which is one visible consequence of plugins running in the main window
 *  context without a real sandbox. */
async function importTauriSource(
  vault: string,
  relPath: string,
): Promise<{ default?: PluginDefinition }> {
  const code = await fsService.read(vault, relPath)
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  try {
    return (await import(/* @vite-ignore */ url)) as { default?: PluginDefinition }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function createVaultImporter(vault: string): (main: string) => Promise<{ default?: PluginDefinition }> {
  if (isTauriRuntime()) return (main) => importTauriSource(vault, main)
  // Browser/memory demo: there is no real plugin file on disk, so vault plugins
  // cannot load. loadPlugin surfaces this as an ok:false result.
  return () => Promise.reject(new Error('browser-demo: no real vault plugin files'))
}

/** Reset in-memory state (active ids, permission verdicts, decider). Test-only. */
export function resetVaultPluginStateForTests(): void {
  deactivateVaultPlugins()
  permissionDecisions.clear()
  permissionDecider = null
}

/**
 * Scan `vault/plugins/<id>/` for user plugins and activate each one.
 *
 * Reading goes through the Rust fs commands (the webview has no Node fs
 * access) while `loadPlugin`/`activatePlugin` keep the plugin-host contract.
 * Every previously-activated vault plugin is deactivated first so switching
 * vaults never leaks a plugin's components/commands/lifecycle hooks into the
 * next vault. Best-effort: a missing plugins dir is not an error; per-plugin
 * failures are surfaced through the app's error toast.
 */
export async function loadVaultPlugins(vault: string): Promise<void> {
  deactivateVaultPlugins()
  const importer = createVaultImporter(vault)
  let dirs
  try {
    dirs = await fsService.list(vault, 'plugins')
  } catch {
    return
  }
  for (const dir of dirs.filter((d) => d.is_dir)) {
    let pkg: VaultPluginPackage
    try {
      pkg = JSON.parse(
        await fsService.read(vault, joinVault('plugins', dir.name, 'package.json')),
      ) as VaultPluginPackage
    } catch {
      continue
    }
    if (!pkg.name || !pkg.version || !pkg.main) continue
    const meta: PluginMeta = {
      id: pkg.name,
      name: pkg.name,
      version: pkg.version,
      main: joinVault('plugins', dir.name, pkg.main),
      permissions: pkg.permissions,
    }
    const result = await loadPlugin(meta, importer)
    if (!result.ok) {
      notifyError(t('plugin.loadFailed', { id: result.id, error: result.error }))
      continue
    }
    if (!(await askPluginPermission(meta, result.definition))) {
      notifyError(t('plugin.permissionSkipped', { name: meta.name }))
      continue
    }
    const res = await activatePlugin(result)
    if (!res.ok) notifyError(t('plugin.loadFailed', { id: res.id, error: res.error }))
    else {
      activeVaultPluginIds.push(res.id)
      console.info(`[NekoWite] vault plugin activated: ${res.id}`)
    }
  }
}
