import {
  activatePlugin,
  assertPermission,
  collectPluginPermissions,
  computePluginDigest,
  createPluginError,
  deactivatePlugin,
  getNonIsolatedPermissions,
  hasDangerousPermissions,
  loadPlugin,
  onLifecycleError,
  verifyPluginIntegrity,
} from '@nekowite/plugin-host'
import type {
  DynamicImport,
  LoadResult,
  PluginDefinition,
  PluginDigestStore,
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

/* ------------------------------------------------------------------------- *
 * Plugin integrity (task #24). We fingerprint the exact bytes the host will
 * execute — the package.json manifest text plus the loaded code — and compare
 * it to the last value the user approved. A mismatch means the plugin was
 * modified since approval: we refuse to silently run it and instead surface a
 * structured PLUGIN_VERIFY_FAILED with a confirm/deny path.
 * ------------------------------------------------------------------------- */

const PLUGIN_DIGESTS_KEY = 'nekowite.pluginDigests'
interface DigestEntry {
  v: string
  d: string
}
type DigestMap = Record<string, DigestEntry>

// localStorage-backed persistence with an in-memory fallback so an environment
// without a working localStorage still records the baseline for the session.
const memoryDigestMap = new Map<string, DigestEntry>()

function readDigestMap(): DigestMap {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(PLUGIN_DIGESTS_KEY)
      if (raw) return JSON.parse(raw) as DigestMap
    }
  } catch {
    /* localStorage unavailable / corrupt → fall through to memory */
  }
  return Object.fromEntries(memoryDigestMap)
}

function writeDigestMap(map: DigestMap): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PLUGIN_DIGESTS_KEY, JSON.stringify(map))
    }
  } catch {
    /* ignore */
  }
  memoryDigestMap.clear()
  for (const [key, value] of Object.entries(map)) memoryDigestMap.set(key, value)
}

/** The last-approved digest for a plugin id, if any. */
function getRecordedDigest(id: string): string | undefined {
  return readDigestMap()[id]?.d
}

/** Record (or re-approve) a plugin's digest as the new expected baseline. */
function setRecordedDigest(id: string, version: string, digest: string): void {
  const map = readDigestMap()
  map[id] = { v: version, d: digest }
  writeDigestMap(map)
}

// Adapter so plugin-host's validate helper can read the persisted value.
const integrityStore: PluginDigestStore = {
  get: getRecordedDigest,
  set: () => {
    /* recording happens through setRecordedDigest (needs the version too) */
  },
}

type IntegrityDecider = (
  meta: PluginMeta,
  expectedDigest: string,
  actualDigest: string,
) => Promise<boolean>

let integrityDecider: IntegrityDecider | null = null

/** Install the callback that decides whether to re-approve a plugin whose code
 *  changed since it was last approved. `true` re-approves (records the new
 *  fingerprint); `false` refuses to run it. Default (no decider) = deny. */
export function setPluginIntegrityDecider(fn: IntegrityDecider | null): void {
  integrityDecider = fn
}

/** Ask the user whether to re-approve a modified plugin. */
async function askReapproveIntegrity(
  meta: PluginMeta,
  expectedDigest: string,
  actualDigest: string,
): Promise<boolean> {
  if (!integrityDecider) return false
  return integrityDecider(meta, expectedDigest, actualDigest)
}

/* ------------------------------------------------------------------------- *
 * Unsandboxed-capability signal (task #23/#28). Plugins run in the main window
 * (no webview/worker sandbox), so a declaration of fs/network/ai is consent-gated
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
function signalUnsandboxedCapabilities(meta: PluginMeta, permission: PluginPermission[]): void {
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

/** Deactivate every vault plugin loaded so far and forget their ids. */
export function deactivateVaultPlugins(): void {
  for (const id of activeVaultPluginIds) deactivatePlugin(id)
  activeVaultPluginIds.length = 0
  unsandboxedVaultPlugins.clear()
  unsandboxedNotified.clear()
}

/** Read a plugin's JS source from the vault and evaluate it as an ES module via
 *  a blob URL. In the Tauri app the webview has no Node fs access, so the source
 *  is read through the Rust commands; the "vite-ignore" annotation keeps Vite
 *  from statically analyzing the runtime blob specifier. Bare imports inside
 *  the plugin (e.g. `import { defineComponent } from 'vue'`) will NOT resolve
 *  from a blob URL — a vault plugin must be self-contained or use absolute URLs
 *  — which is one visible consequence of plugins running in the main window
 *  context without a real sandbox.
 *
 *  The loaded code string is handed back to `onCode` so the loader can fingerprint
 *  the exact bytes it is about to execute (used by the integrity gate). */
async function importVaultSource(
  vault: string,
  relPath: string,
  onCode?: (code: string) => void,
): Promise<{ default?: PluginDefinition }> {
  if (!isTauriRuntime()) return Promise.reject(new Error('browser-demo: no real vault plugin files'))
  const code = await fsService.read(vault, relPath)
  onCode?.(code)
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  try {
    return (await import(/* @vite-ignore */ url)) as { default?: PluginDefinition }
  } finally {
    URL.revokeObjectURL(url)
  }
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
  digest?: string
  skip?: boolean
}

/** Read a plugin's manifest and then load its code, tagging each distinct
 *  failure (missing file / invalid manifest / code parse / load) with a
 *  structured code + recovery hint instead of one generic "plugin failed".
 *
 *  The code is read once through `importVaultSource` (which captures the loaded
 *  bytes) and fingerprinted together with the manifest by `computePluginDigest`
 *  so the host can later detect a modified plugin. */
async function preloadVaultPlugin(
  vault: string,
  dirName: string,
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

  // 3. Read the plugin's code + dynamic import (inside loadPlugin). The importer
  //    is built here (per-plugin) so we can capture the exact loaded code for
  //    the integrity fingerprint. Independent of other plugins, so it
  //    participates in the bounded-concurrency phase.
  let loadedCode = ''
  const importer: DynamicImport = (main) => importVaultSource(vault, main, (code) => {
    loadedCode = code
  })
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
  const digest = computePluginDigest(raw, loadedCode)
  return { dirName, meta, loadResult: result, digest }
}

/** Reset in-memory state (active ids, permission verdicts, deciders, unsandboxed
 *  registry, integrity baselines). Test-only. */
export function resetVaultPluginStateForTests(): void {
  deactivateVaultPlugins()
  permissionDecisions.clear()
  permissionDecider = null
  integrityDecider = null
  memoryDigestMap.clear()
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
 *     runs concurrently with bounded parallelism, fingerprinting each plugin's
 *     bytes as it goes.
 *  2. Permission confirmation stays sequential (it drives a user dialog), the
 *     point-of-use permission guard runs as each plugin passes consent, and a
 *     plugin that declares non-isolated capabilities surfaces a "trusted-but-
 *     unsandboxed" notice instead of being silently confirmed.
 *  3. Integrity verification: the recorded fingerprint is compared to the
 *     last-approved one. A mismatch is refused (confirm/deny) rather than run.
 *  4. Activation of the consented plugins runs concurrently, but recorded in a
 *     deterministic order (sorted by plugin id) so the UI/registration order is
 *     stable across reloads.
 */
export async function loadVaultPlugins(vault: string): Promise<void> {
  deactivateVaultPlugins()
  ensureLifecycleErrorRouter()
  let dirs
  try {
    dirs = await fsService.list(vault, 'plugins')
  } catch {
    return
  }
  const pluginDirs = dirs.filter((d) => d.is_dir)

  // Phase 1 — parallel, independent per-plugin work (manifest + code + import).
  const preloaded = await runBounded(
    pluginDirs.map((dir) => () => preloadVaultPlugin(vault, dir.name)),
    MAX_PARALLEL_PLUGIN_LOADS,
  )
  // Deterministic registration order for the UI, independent of IO timing.
  preloaded.sort((a, b) => (a.meta?.id ?? a.dirName).localeCompare(b.meta?.id ?? b.dirName))

  // Phase 2 — sequential permission confirmation (user dialog) + point-of-use
  // permission guard + integrity verification. Collect the consented plugins
  // for concurrent activation.
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
    // Integrity gate: refuse to silently run a plugin whose code/manifest changed
    // since it was approved. First approval records the baseline; a mismatch is
    // surfaced (confirm/deny) instead of auto-run.
    const digest = p.digest
    if (digest) {
      const verdict = verifyPluginIntegrity(meta.id, digest, integrityStore)
      if (verdict === 'mismatch') {
        const expected = getRecordedDigest(meta.id)
        const reapprove = await askReapproveIntegrity(meta, expected ?? '', digest)
        if (!reapprove) {
          notifyError(
            describePluginError(
              createPluginError('PLUGIN_VERIFY_FAILED', {
                pluginId: meta.id,
                message: `Plugin "${meta.name}" was modified since it was last approved; refusing to run it.`,
                recovery: 'Re-approve the plugin or reinstall it.',
              }),
            ),
          )
          continue
        }
        // Re-approved: adopt the new fingerprint as the baseline.
        setRecordedDigest(meta.id, meta.version, digest)
      } else if (verdict === 'missing') {
        // First approval in this store: record the baseline fingerprint.
        setRecordedDigest(meta.id, meta.version, digest)
      }
    }
    // A declared capability is not capability-isolated while the plugin runs in
    // the main window; once we have decided to run it, make that explicit rather
    // than pretending to sandbox it.
    const nonIsolated = getNonIsolatedPermissions(meta, definition)
    signalUnsandboxedCapabilities(meta, nonIsolated)
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
