import {
  activatePlugin,
  assertPermission,
  collectPluginPermissions,
  createPluginError,
  deactivatePlugin,
  hasDangerousPermissions,
  loadPlugin,
  onLifecycleError,
} from '@nekowite/plugin-host'
import type {
  DynamicImport,
  LoadResult,
  PluginDefinition,
  PluginError,
  PluginErrorCode,
  PluginMeta,
  PluginPermission,
} from '@nekowite/plugin-host'
import { fsService } from './fs'
import { describePluginError, notifyError } from './errors'
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
  const declared = collectPluginPermissions(meta, definition)
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

// The per-plugin work (read manifest → read code → dynamic import) is
// independent across plugins and is the bulk of startup cost, so it runs
// concurrently with a bounded parallelism that keeps the allocator/IO sane.
// Permission confirmation and activation ordering stay deterministic.
const MAX_PARALLEL_PLUGIN_LOADS = 4

/** Run `tasks` (index-aligned) with at most `limit` concurrent promises, while
 *  preserving the original task order in the returned array. */
async function runBounded<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
    }
  })
  await Promise.all(workers)
  return results
}

let lifecycleErrorOff: (() => void) | null = null

/** Route plugin lifecycle hook errors (a throwing hook, still isolated by the
 *  host) into the app error channel so a failure is observable and actionable. */
function ensureLifecycleErrorRouter(): void {
  if (lifecycleErrorOff) return
  lifecycleErrorOff = onLifecycleError((ev) => {
     
    console.error(`[NekoWite] plugin lifecycle hook failed plugin="${ev.pluginId}" event="${ev.event}"`, ev.error)
    notifyError(describePluginError(ev.error))
  })
}

/** Turn a raw dynamic-import failure string into a structured plugin error code
 *  so the loader can distinguish a code/parse problem from a generic load
 *  failure (missing entry file, unresolved module, etc.). */
function classifyLoadError(error: string): PluginErrorCode {
  if (/syntax|parse|unexpected|SyntaxError|Unexpected/i.test(error)) return 'PLUGIN_CODE_PARSE_FAILED'
  if (/cannot find module|module not found|no such file|failed to fetch|not found|does not provide an export|404/i.test(error)) {
    return 'PLUGIN_NOT_FOUND'
  }
  return 'PLUGIN_LOAD_FAILED'
}

/** Build a structured plugin error for a load-stage failure, keyed off the
 *  classified code so the recovery hint matches the problem. */
function loadFailure(meta: PluginMeta, error: string): PluginError {
  const code = classifyLoadError(error)
  const message =
    code === 'PLUGIN_CODE_PARSE_FAILED'
      ? `Plugin "${meta.name}" could not be parsed/imported: ${error}`
      : code === 'PLUGIN_NOT_FOUND'
        ? `Plugin "${meta.name}" could not be found (its entry file may be missing): ${error}`
        : t('plugin.loadFailed', { id: meta.id, error })
  const recovery =
    code === 'PLUGIN_CODE_PARSE_FAILED'
      ? 'Update the plugin to a compatible version.'
      : code === 'PLUGIN_NOT_FOUND'
        ? 'Reinstall the plugin, or check that its entry file exists.'
        : 'Reinstall the plugin or check its entry file.'
  return createPluginError(code, { pluginId: meta.id, message, recovery })
}

/** A single plugin's async-preloaded stage (manifest + code read + import),
 *  result-shaped so each failure bucket is separately diagnosable. `skip` marks
 *  a directory that is not actually a plugin (no manifest), dropped silently. */
interface PreloadedPlugin {
  dirName: string
  meta?: PluginMeta
  loadResult?: LoadResult
  error?: PluginError
  skip?: boolean
}

/** Read a plugin's manifest and then load its code, tagging each distinct
 *  failure (missing file / invalid manifest / code parse / load) with a
 *  structured code + recovery hint instead of one generic "plugin failed". */
async function preloadVaultPlugin(
  vault: string,
  dirName: string,
  importer: DynamicImport,
): Promise<PreloadedPlugin> {
  // 1. Read the manifest. A directory with no package.json is not a plugin
  //    (e.g. an arbitrary subfolder of plugins/), so it is skipped silently —
  //    a *malformed* manifest, by contrast, is a real failure below.
  let raw: string
  try {
    raw = await fsService.read(vault, joinVault('plugins', dirName, 'package.json'))
  } catch {
    return { dirName, skip: true }
  }

  // 2. Parse the manifest, distinguishing "invalid JSON" from "missing fields".
  let pkg: VaultPluginPackage
  try {
    pkg = JSON.parse(raw) as VaultPluginPackage
  } catch {
    return {
      dirName,
      error: createPluginError('PLUGIN_MANIFEST_INVALID', {
        pluginId: dirName,
        message: `Plugin "${dirName}" has an invalid manifest (package.json is not valid JSON).`,
        recovery: 'Fix or reinstall the plugin manifest.',
      }),
    }
  }
  if (!pkg.name || !pkg.version || !pkg.main) {
    return {
      dirName,
      error: createPluginError('PLUGIN_MANIFEST_INVALID', {
        pluginId: dirName,
        message: `Plugin "${dirName}" manifest is missing required fields (name, version, main).`,
        recovery: 'Fix the package.json manifest.',
      }),
    }
  }

  const meta: PluginMeta = {
    id: pkg.name,
    name: pkg.name,
    version: pkg.version,
    main: joinVault('plugins', dirName, pkg.main),
    permissions: pkg.permissions,
  }

  // 3. Read the plugin's code + dynamic import (inside loadPlugin). Independent
  //    of other plugins, so it participates in the bounded-concurrency phase.
  let result: LoadResult
  try {
    result = await loadPlugin(meta, importer)
  } catch (e) {
    // loadPlugin normally swallows load errors into an ok:false result, but a
    // dynamic-import rejection can still escape (e.g. a sandboxed importer) —
    // classify it the same way instead of bubbling and aborting the whole scan.
    return { dirName, meta, error: loadFailure(meta, e instanceof Error ? e.message : String(e)) }
  }
  if (!result.ok) return { dirName, meta, error: loadFailure(meta, result.error) }
  return { dirName, meta, loadResult: result }
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
 *
 * Loading is staged to keep startup time from growing linearly with plugin
 * count:
 *  1. Per-plugin independent work (read manifest → read code → dynamic import)
 *     runs concurrently with bounded parallelism.
 *  2. Permission confirmation stays sequential (it drives a user dialog), and
 *     the point-of-use permission guard runs as each plugin passes consent.
 *  3. Activation of the consented plugins runs concurrently, but recorded in a
 *     deterministic order (sorted by plugin id) so the UI/registration order is
 *     stable across reloads.
 */
export async function loadVaultPlugins(vault: string): Promise<void> {
  deactivateVaultPlugins()
  ensureLifecycleErrorRouter()
  const importer = createVaultImporter(vault)
  let dirs
  try {
    dirs = await fsService.list(vault, 'plugins')
  } catch {
    return
  }
  const pluginDirs = dirs.filter((d) => d.is_dir)

  // Phase 1 — parallel, independent per-plugin work.
  const preloaded = await runBounded(
    pluginDirs.map((dir) => () => preloadVaultPlugin(vault, dir.name, importer)),
    MAX_PARALLEL_PLUGIN_LOADS,
  )
  // Deterministic registration order for the UI, independent of IO timing.
  preloaded.sort((a, b) => (a.meta?.id ?? a.dirName).localeCompare(b.meta?.id ?? b.dirName))

  // Phase 2 — sequential permission confirmation (user dialog) + point-of-use
  // permission guard. Collect the consented plugins for concurrent activation.
  const consented: PreloadedPlugin[] = []
  for (const p of preloaded) {
    // A directory without a manifest is not a plugin; drop it quietly.
    if (p.skip) continue
    if (p.error) {
      notifyError(describePluginError(p.error))
      continue
    }
    const loadResult = p.loadResult
    if (!loadResult || !loadResult.ok) {
      // Defensive: p.error was absent, so this should never happen, but avoid
      // activating an errored result.
      notifyError(describePluginError(p.error ?? createPluginError('PLUGIN_LOAD_FAILED', { pluginId: p.dirName })))
      continue
    }
    const meta = loadResult.meta
    const definition = loadResult.definition
    if (!(await askPluginPermission(meta, definition))) {
      const declared = collectPluginPermissions(meta, definition)
      notifyError(
        describePluginError(
          createPluginError('PLUGIN_PERMISSION_DENIED', {
            pluginId: meta.id,
            message:
              declared.length > 0
                ? `Plugin "${meta.name}" requires permission(s): ${declared.join(', ')} but consent was not granted.`
                : t('plugin.permissionSkipped', { name: meta.name }),
            recovery: 'Grant the requested permission in the plugin settings, then reload the vault.',
          }),
        ),
      )
      continue
    }
    // Point-of-use guard: re-verify every declared permission is present before
    // activation; a missing capability rejects loudly instead of silently
    // proceeding. Today consent is all-or-nothing, so the granted set equals the
    // declared set — this is where a future per-capability grant is enforced.
    const granted = collectPluginPermissions(meta, definition)
    for (const permission of granted) {
      assertPermission({ permissions: granted }, permission, {
        pluginId: meta.id,
        detail: 'activate its declared capabilities',
      })
    }
    consented.push(p)
  }

  // Phase 3 — parallel activation of the consented plugins, results recorded in
  // deterministic (consented) order. An activation rejection is captured into an
  // ok:false result so one failing plugin cannot abort the rest.
  const activated = await runBounded(
    consented.map((p) => async () => {
      const loadResult = p.loadResult as LoadResult
      const res = await activatePlugin(loadResult).catch((e) => ({
        ok: false as const,
        id: loadResult.id,
        error: e instanceof Error ? e.message : String(e),
      }))
      return { meta: p.meta as PluginMeta, res }
    }),
    MAX_PARALLEL_PLUGIN_LOADS,
  )
  for (const { meta, res } of activated) {
    if (!res.ok) {
      notifyError(
        describePluginError(
          createPluginError('PLUGIN_ACTIVATE_FAILED', {
            pluginId: res.id,
            message: `Plugin "${meta.name}" failed to activate: ${res.error ?? ''}`,
            recovery: 'Disable and re-enable the plugin, or reinstall it.',
          }),
        ),
      )
      continue
    }
    activeVaultPluginIds.push(res.id)
    console.info(`[NekoWite] vault plugin activated: ${res.id}`)
  }
}
