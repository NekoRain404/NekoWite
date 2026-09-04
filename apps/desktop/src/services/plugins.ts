import {
  activatePlugin,
  assertPermission,
  buildPluginSignaturePayload,
  collectPluginPermissions,
  computePluginDigest,
  createPluginError,
  DEFAULT_PLUGIN_ACTIVATION_TIMEOUT_MS,
  deactivatePlugin,
  getNonIsolatedPermissions,
  hasDangerousPermissions,
  loadPlugin,
  onLifecycleError,
  publisherIdOf,
  verifyPluginIntegrity,
  verifyPluginSignature,
} from '@nekowite/plugin-host'
import type {
  DynamicImport,
  LoadResult,
  PluginDefinition,
  PluginDigestStore,
  PluginError,
  PluginErrorCode,
  PluginFsAdapter,
  PluginFsEntry,
  PluginMeta,
  PluginPermission,
} from '@nekowite/plugin-host'
import { joinPath } from '@nekowite/plugin-host'
import { fsService } from './fs'
import { describePluginError, notifyError } from './errors'
import { t } from '../i18n'

interface VaultPluginPackage {
  name?: string
  version?: string
  main?: string
  permissions?: PluginPermission[]
  /** Optional HMAC-SHA256 signature (hex) from a trusted publisher. */
  signature?: string
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

/**
 * Whether the current environment permits executing a vault plugin loaded from a
 * blob URL (`import('blob:...')`) under the active CSP.
 *
 * The production Tauri webview enforces a strict CSP (`script-src 'self'
 * 'wasm-unsafe-eval'` — no `blob:`, no `'unsafe-eval'`/`'unsafe-inline'`), so a
 * dynamic `import('blob:...')` of a plugin is silently blocked there. Until the
 * plugin system is moved behind real isolation (a dedicated process/WebView with
 * its own CSP), we DETECT that environment and skip the in-window import rather
 * than failing every plugin load with a CSP error.
 *
 * The signal is the presence of the Tauri runtime: the strict, `blob:`-denying
 * CSP is only injected into the real Tauri webview. In a plain browser (the
 * Demo, or the unit-test DOM) there is no Tauri runtime, so blob module imports
 * are not known to be blocked and this returns true — keeping the
 * permission/integrity code paths reachable and exercised outside the packaged
 * app. Plugin LOADING therefore remains gated until isolation exists; revisit
 * this helper (not the CSP) when the plugin host moves into a sandbox.
 */
export function isPluginImportAllowedByCsp(): boolean {
  return !isTauriRuntime()
}

// Once per session, surface a single user-visible notice that vault plugins are
// disabled by the security policy — never a silent no-op, and never a repeated
// CSP error per plugin.
let cspBlockedNotified = false

function signalPluginLoadingDisabledByCsp(): void {
  if (cspBlockedNotified) return
  cspBlockedNotified = true
  notifyError(
    'Vault plugins are disabled under the current security policy (CSP blocks in-window module loading). Expected until process/WebView isolation is implemented.',
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
 * Task #24 — plugin change detection. We fingerprint the exact bytes the host
 * will execute — the package.json manifest text plus the loaded code — and
 * compare it to the last value the user approved. This is change detection, NOT
 * cryptographic authentication: the 32-bit FNV-1a digest is not signed and must
 * never be presented as proof of provenance. A mismatch simply means the plugin
 * was modified since approval and we refuse to silently run it, surfacing a
 * structured PLUGIN_VERIFY_FAILED with a re-approve/deny path instead.
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

/** Composite storage key for a plugin baseline: vault + plugin id, NUL-separated
 *  so a vault path and an id that both contain "/" can never collide. Two
 *  different vaults therefore never share an approval record for the same id. */
function digestStorageKey(vault: string, id: string): string {
  // NUL separator: a vault path and a plugin id can both contain "/", so a
  // plain concatenation (or "/" join) could collide across vaults.
  return `${vault}\u0000${id}`
}

/** The last-approved digest for a (vault, plugin id) pair, if any. */
function getRecordedDigest(vault: string, id: string): string | undefined {
  return readDigestMap()[digestStorageKey(vault, id)]?.d
}

/** Record (or re-approve) a plugin's digest as the new expected baseline. */
function setRecordedDigest(vault: string, id: string, version: string, digest: string): void {
  const map = readDigestMap()
  map[digestStorageKey(vault, id)] = { v: version, d: digest }
  writeDigestMap(map)
}

// Adapter so plugin-host's validate helper can read the persisted value, scoped
// to the vault currently being loaded (closing over `vault`).
function makeVaultIntegrityStore(vault: string): PluginDigestStore {
  return {
    get: (id) => getRecordedDigest(vault, id),
    set: () => {
      /* recording happens through setRecordedDigest (needs the version too) */
    },
  }
}

type IntegrityDecider = (
  meta: PluginMeta,
  expectedDigest: string,
  actualDigest: string,
) => Promise<boolean>

let integrityDecider: IntegrityDecider | null = null

/** A pending re-approval question for the host to render. `resolve(true)`
 *  re-approves the plugin (recording its new fingerprint as the baseline);
 *  `resolve(false)` refuses to run the modified plugin. */
export interface PluginIntegrityRequest {
  meta: PluginMeta
  expectedDigest: string
  actualDigest: string
  resolve: (reapprove: boolean) => void
}

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
 * Trust / trusted-source policy (definite plugin-security requirement).
 *
 * A plugin may carry an HMAC-SHA256 `signature` (hex) over its normalized
 * code+manifest payload, produced by a publisher who holds the same trusted
 * secret the user configures. That is a shared-secret MAC (integrity-of-source),
 * NOT public-key authentication — the same secret signs and verifies.
 *
 * Policy (applied as a gate BEFORE any import):
 *   - signature present + verifies against the trusted key  → trusted.
 *   - signature present + FAILS verification (or no key configured) → REFUSE
 *     with PLUGIN_SIGNATURE_INVALID, never import.
 *   - no signature → unsigned:
 *       * the plugin id / publisher id is on the trusted-source allowlist →
 *         trusted;
 *       * otherwise, under `permit-unsigned-with-notice` the plugin is ALLOWED
 *         but explicitly flagged as unsigned/untrusted-source (a console notice,
 *         not a silent grant — and never a security claim);
 *       * under `require-trust` the plugin MUST be explicitly trusted (via the
 *         allowlist or a trust decider); the safe default (no decider) is DENY
 *         with PLUGIN_UNSIGNED_UNTRUSTED.
 * The 32-bit FNV-1a digest remains change-detection only; the signature is the
 * trust anchor. Neither is process isolation.
 * ------------------------------------------------------------------------- */

const PLUGIN_TRUST_KEY = 'nekowite.pluginTrustKey'
const PLUGIN_TRUSTED_SOURCES_KEY = 'nekowite.pluginTrustedSources'

/** How unsigned plugins are treated when they are not on the allowlist. */
export type PluginTrustPolicy = 'permit-unsigned-with-notice' | 'require-trust'

let pluginTrustPolicy: PluginTrustPolicy = 'permit-unsigned-with-notice'
// In-memory fallbacks so an environment without a working localStorage still
// records the trust configuration for the session (mirrors the digest map).
let memoryTrustedKey = ''
const memoryTrustedSources = new Set<string>()

/** The configured trust policy. Default permits unsigned plugins with a logged
 *  "unsigned, untrusted-source" notice (so nothing is silently trusted as a
 *  security claim); `setPluginTrustPolicy('require-trust')` denies them unless
 *  explicitly trusted. */
export function getPluginTrustPolicy(): PluginTrustPolicy {
  return pluginTrustPolicy
}

/** Set the trust policy for unsigned plugins. */
export function setPluginTrustPolicy(policy: PluginTrustPolicy): void {
  pluginTrustPolicy = policy
}

/** The trusted publisher key material (a hex or UTF-8 secret), or '' if none. */
export function getPluginTrustedKey(): string {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(PLUGIN_TRUST_KEY)
      if (raw !== null) return raw
    }
  } catch {
    /* localStorage unavailable → fall through to memory */
  }
  return memoryTrustedKey
}

/** Configure the trusted publisher key used to verify plugin signatures. Only
 *  plugins signed by a holder of this secret are treated as cryptographically
 *  trusted; a present-but-unverifiable signature is refused. */
export function setPluginTrustedKey(keyMaterial: string): void {
  memoryTrustedKey = keyMaterial
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(PLUGIN_TRUST_KEY, keyMaterial)
  } catch {
    /* ignore */
  }
}

/** The ids the user has explicitly trusted (publisher ids and/or full plugin ids). */
export function getPluginTrustedSourceIds(): string[] {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(PLUGIN_TRUSTED_SOURCES_KEY)
      if (raw) return JSON.parse(raw) as string[]
    }
  } catch {
    /* localStorage unavailable → fall through to memory */
  }
  return [...memoryTrustedSources]
}

/** True when a plugin's id OR its publisher id is in the trusted-source allowlist. */
export function isPluginTrustedSource(pluginId: string): boolean {
  const ids = getPluginTrustedSourceIds()
  return ids.includes(pluginId) || ids.includes(publisherIdOf(pluginId))
}

/** Add or remove an id on the trusted-source allowlist. */
export function setPluginTrustedSource(pluginId: string, trusted: boolean): void {
  const ids = new Set(getPluginTrustedSourceIds())
  if (trusted) ids.add(pluginId)
  else ids.delete(pluginId)
  const list = [...ids]
  memoryTrustedSources.clear()
  for (const id of list) memoryTrustedSources.add(id)
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PLUGIN_TRUSTED_SOURCES_KEY, JSON.stringify(list))
    }
  } catch {
    /* ignore */
  }
}

type TrustDecider = (req: PluginTrustRequest) => Promise<boolean>

/** A pending trust question for the host to render. `resolve(true)` trusts the
 *  plugin (recording it on the allowlist); `resolve(false)` refuses it. Only
 *  reachable for unsigned plugins under the `require-trust` policy (or an
 *  explicit unsigned-opt-in); a plugin with a FAILING signature is always refused
 *  and never offered for trust. */
export interface PluginTrustRequest {
  meta: PluginMeta
  signature?: string
  reason: 'unsigned' | 'unverifiable-key'
  resolve: (trust: boolean) => void
}

let trustDecider: TrustDecider | null = null

/** Install the callback that decides whether to trust an unsigned plugin. */
export function setPluginTrustDecider(fn: TrustDecider | null): void {
  trustDecider = fn
}

/** Ask the user whether to trust an unsigned plugin. */
async function askPluginTrust(meta: PluginMeta, signature: string | undefined, reason: 'unsigned' | 'unverifiable-key'): Promise<boolean> {
  if (!trustDecider) return false
  return trustDecider({ meta, signature, reason, resolve: () => {} })
}

// Track unsigned plugins we already flagged so the console notice is not
// repeated per reload.
const unsignedNotified = new Set<string>()

/** A decision from the trust gate: allow (optionally with a notice) or a
 *  structured refusal. */
type TrustDecision =
  | { action: 'allow'; notice?: string }
  | { action: 'deny'; error: PluginError }

async function decidePluginTrust(
  meta: PluginMeta,
  signature: string | undefined,
  signaturePayload: string | undefined,
): Promise<TrustDecision> {
  if (signature && signaturePayload) {
    const trustedKey = getPluginTrustedKey()
    if (!trustedKey) {
      // A present signature we cannot verify against any key: an unverifiable
      // publisher claim. Refuse (never silently trust an unverified signature).
      return {
        action: 'deny',
        error: createPluginError('PLUGIN_SIGNATURE_INVALID', {
          pluginId: meta.id,
          message: `Plugin "${meta.name}" declares a signature but no trusted publisher key is configured; refusing to run it.`,
          recovery: 'Configure a trusted publisher key, or reinstall the plugin.',
        }),
      }
    }
    let ok = false
    try {
      ok = await verifyPluginSignature(signature, signaturePayload, trustedKey)
    } catch (e) {
      console.error(`[NekoWite] signature verification threw plugin="${meta.id}"`, e)
      ok = false
    }
    if (ok) return { action: 'allow' }
    return {
      action: 'deny',
      error: createPluginError('PLUGIN_SIGNATURE_INVALID', {
        pluginId: meta.id,
        message: `Plugin "${meta.name}"'s signature failed verification against the trusted publisher key; refusing to run it.`,
        recovery: 'Only run plugins from a source you trust, or reinstall the plugin.',
      }),
    }
  }

  // Unsigned: explicit trust or allow-with-notice.
  if (isPluginTrustedSource(meta.id)) return { action: 'allow' }
  if (pluginTrustPolicy === 'require-trust') {
    if (await askPluginTrust(meta, undefined, 'unsigned')) {
      setPluginTrustedSource(meta.id, true)
      return { action: 'allow' }
    }
    return {
      action: 'deny',
      error: createPluginError('PLUGIN_UNSIGNED_UNTRUSTED', {
        pluginId: meta.id,
        message: `Plugin "${meta.name}" is unsigned and not from a trusted source; refusing to run it.`,
        recovery: 'Trust it explicitly only if you trust its source, or add its publisher to the trusted sources.',
      }),
    }
  }
  // Default: allow but never silently trusted — flagged as unsigned/untrusted.
  if (!unsignedNotified.has(meta.id)) {
    unsignedNotified.add(meta.id)
    console.warn(
      `[NekoWite] plugin "${meta.id}" is unsigned and from an unverified source (allowed under the current policy; NOT cryptographically trusted).`,
    )
  }
  return { action: 'allow' }
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

/**
 * The file-access boundary between the vault plugin loader and the app's fs
 * service. Constructed from the app's existing vault file service (Tauri Rust
 * commands in the desktop, the in-memory demo gateway in a browser), and injected
 * into the loader so the adapter boundary that plugin-host defines is exercised
 * in production as well as in tests. `readFile`/`readdir` take loader-style
 * POSIX paths rooted at the vault root; they are translated to vault-relative
 * paths for the underlying `fsService`.
 */
function makeVaultPluginFsAdapter(vault: string): PluginFsAdapter {
  const vaultRoot = vault.replace(/\/+$/, '')
  function toRelative(absPath: string): string {
    if (absPath === vaultRoot) return ''
    if (vaultRoot !== '' && absPath.startsWith(vaultRoot + '/')) {
      return absPath.slice(vaultRoot.length + 1)
    }
    return absPath.replace(/^\/+/, '')
  }
  return {
    readFile: (path) => fsService.read(vault, toRelative(path)),
    readdir: async (dir) => {
      const entries = await fsService.list(vault, toRelative(dir))
      return entries.map((e): PluginFsEntry => ({ name: e.name, isDirectory: () => e.is_dir }))
    },
    stat: async (path) => {
      // The Rust stat command returns size/mtime (no is_directory flag); the
      // loader only needs stat as a fallback when a readdir entry omits
      // isDirectory(), which our readdir always provides, so this is best-effort.
      await fsService.stat(vault, toRelative(path))
      return { isDirectory: () => false }
    },
  }
}

/**
 * Evaluate a plugin's source string as an ES module via a blob URL. This is the
 * ONLY place plugin code is (potentially) executed, and the loader calls it only
 * AFTER the integrity and consent gates pass — so a tampered/unapproved plugin's
 * top-level side effects can never run. In the Tauri app the webview has no Node
 * fs access; bare imports inside the plugin (e.g. `import { defineComponent }
 * from 'vue'`) will NOT resolve from a blob URL — which is one visible
 * consequence of plugins running in the main window context without a real
 * sandbox. The "vite-ignore" annotation keeps Vite from statically analyzing the
 * runtime blob specifier.
 */
async function importSource(source: string): Promise<{ default?: PluginDefinition }> {
  if (!isTauriRuntime()) return Promise.reject(new Error('browser-demo: plugin execution disabled'))
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    return (await import(/* @vite-ignore */ url)) as { default?: PluginDefinition }
  } finally {
    URL.revokeObjectURL(url)
  }
}

// The per-plugin work (read manifest → read code) is independent across plugins
// and the bulk of the scan, so it runs concurrently with a bounded parallelism
// that keeps the allocator/IO sane. Integrity/consent gating and the import stay
// sequential and deterministic.
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

/** A single plugin's async-preloaded stage (manifest + code read + digest),
 *  result-shaped so each failure bucket is separately diagnosable. `skip` marks
 *  a directory that is not actually a plugin (no manifest), dropped silently.
 *  `source` carries the exact bytes that will be executed; `loadResult` is
 *  populated only after the gated import. */
interface PreloadedPlugin {
  dirName: string
  meta?: PluginMeta
  loadResult?: LoadResult
  error?: PluginError
  digest?: string
  source?: string
  /** The plugin's manifest-declared HMAC signature, if any. */
  signature?: string
  /** The canonical payload the signature is verified over (code+manifest). */
  signaturePayload?: string
  skip?: boolean
}

/** Read a plugin's manifest and its code SOURCE (without executing it — no
 *  import), fingerprinting the exact bytes the host would run so the integrity
 *  gate can refuse a modified plugin BEFORE any module code executes. */
async function preloadVaultPlugin(
  adapter: PluginFsAdapter,
  vault: string,
  dirName: string,
): Promise<PreloadedPlugin> {
  // 1. Read the manifest. A directory with no package.json is not a plugin
  //    (e.g. an arbitrary subfolder of plugins/), so it is skipped silently —
  //    a *malformed* manifest, by contrast, is a real failure below.
  let raw: string
  try {
    raw = await adapter.readFile(joinPath(vault, 'plugins', dirName, 'package.json'))
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
    signature: pkg.signature,
  }

  // 3. Read the plugin's code source string. Reading the file is safe; only
  //    importing/executing is gated, and that happens later (after the
  //    trust + integrity + consent gates). The digest is computed from these
  //    exact bytes; the signature payload is the canonical code+manifest form
  //    a publisher signs and the host verifies against the trusted key.
  let source: string
  try {
    source = await adapter.readFile(joinPath(vault, meta.main))
  } catch (e) {
    return { dirName, meta, error: loadFailure(meta, e instanceof Error ? e.message : String(e)) }
  }

  const digest = computePluginDigest(raw, source)
  const signaturePayload = buildPluginSignaturePayload(meta.id, meta.version, pkg.main, source, meta.permissions)
  return { dirName, meta, digest, source, signature: pkg.signature, signaturePayload }
}

/** Reset in-memory state (active ids, permission verdicts, deciders, unsandboxed
 *  registry, trust config, integrity baselines). Test-only. */
export function resetVaultPluginStateForTests(): void {
  deactivateVaultPlugins()
  permissionDecisions.clear()
  permissionDecider = null
  integrityDecider = null
  trustDecider = null
  pluginTrustPolicy = 'permit-unsigned-with-notice'
  memoryTrustedKey = ''
  memoryTrustedSources.clear()
  unsignedNotified.clear()
  memoryDigestMap.clear()
  cspBlockedNotified = false
}

/**
 * Scan `vault/plugins/<id>/` for user plugins and activate each one.
 *
 * Reading goes through the injected `PluginFsAdapter` (built from the app's vault
 * file service, so the boundary plugin-host defines is real in production), while
 * `loadPlugin`/`activatePlugin` keep the plugin-host contract. Every
 * previously-activated vault plugin is deactivated first so switching vaults
 * never leaks a plugin's components/commands/lifecycle hooks into the next
 * vault. Best-effort: a missing plugins dir is not an error; per-plugin failures
 * are surfaced through the app's error toast.
 *
 * Loading is staged to keep startup time from growing linearly with plugin count,
 * AND so no plugin code is executed before it is verified:
 *  1. Per-plugin independent work (read manifest → read code → fingerprint) runs
 *     concurrently with bounded parallelism. NO module is imported here; each
 *     plugin's source string is only read and digested.
 *  2. Permission confirmation (manifest-declared capabilities) stays sequential
 *     (it drives a user dialog), followed by the integrity gate. A plugin that
 *     fails either gate is NEVER imported.
 *  3. Only after consent + integrity pass does the loader import (execute) the
 *     plugin source — the last action before activation. This is the security
 *     boundary: a tampered or unapproved plugin's top-level side effects never
 *     run, even if it would later be "not activated."
 *  4. Post-import, a plugin that declares additional capabilities in its code is
 *     consent-checked again (best-effort, since top-level already ran), a
 *     point-of-use permission guard runs, and non-isolated declarations surface
 *     a "trusted-but-unsandboxed" notice.
 *  5. Activation of the consented plugins runs concurrently, but recorded in a
 *     deterministic order (sorted by plugin id) so the UI/registration order is
 *     stable across reloads.
 */
export async function loadVaultPlugins(vault: string): Promise<void> {
  deactivateVaultPlugins()
  ensureLifecycleErrorRouter()

  // CSP gate: the production Tauri webview's strict CSP blocks the in-window
  // `import('blob:...')` that plugin loading relies on. Rather than attempting
  // (and failing) the import for every plugin, skip the scan entirely and surface
  // one notice. The permission/integrity/manifest code below stays intact so it
  // becomes live the moment plugin loading moves behind real isolation. The gate
  // only triggers in the real Tauri webview — not in the unit-test DOM or the
  // browser Demo, where the existing integrity/permission scenarios still run.
  if (!isPluginImportAllowedByCsp()) {
    signalPluginLoadingDisabledByCsp()
    return
  }

  const adapter = makeVaultPluginFsAdapter(vault)
  let entries: PluginFsEntry[]
  try {
    entries = await adapter.readdir(joinPath(vault, 'plugins'))
  } catch {
    return
  }
  const pluginDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)

  // Phase 1 — parallel, independent per-plugin work (manifest + code + digest).
  // No import happens here; execution is deferred until after the gates below.
  const preloaded = await runBounded(
    pluginDirs.map((name) => () => preloadVaultPlugin(adapter, vault, name)),
    MAX_PARALLEL_PLUGIN_LOADS,
  )
  // Deterministic registration order for the UI, independent of IO timing.
  preloaded.sort((a, b) => (a.meta?.id ?? a.dirName).localeCompare(b.meta?.id ?? b.dirName))

  // Phase 2 — sequential permission confirmation (user dialog) + integrity
  // verification, THEN the gated import. Collect the consented plugins for
  // concurrent activation.
  const integrityStore = makeVaultIntegrityStore(vault)
  const consented: PreloadedPlugin[] = []
  for (const p of preloaded) {
    // A directory without a manifest is not a plugin; drop it quietly.
    if (p.skip) continue
    if (p.error) {
      notifyError(describePluginError(p.error))
      continue
    }
    const meta = p.meta
    const source = p.source
    if (!meta || !source) continue

    // GATE 1 — permission consent BEFORE any execution. Only capabilities
    // declared in the manifest are known pre-import; those are the trust
    // contract. A denial here means the module is never imported.
    const preManifest = { permissions: meta.permissions } as PluginDefinition
    if (!(await askPluginPermission(meta, preManifest))) {
      const declared = collectPluginPermissions(meta, preManifest)
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

    // GATE 1.5 — trust / source authenticity BEFORE any execution. An invalid
    // signature is refused outright (never imported); an unsigned plugin is
    // never silently trusted — it is flagged as unsigned/untrusted-source, or,
    // under the strict policy, must be explicitly trusted (allowlist/decider).
    const trust = await decidePluginTrust(meta, p.signature, p.signaturePayload)
    if (trust.action === 'deny') {
      notifyError(describePluginError(trust.error))
      continue
    }

    // GATE 2 — integrity BEFORE any execution. Refuse to silently run a plugin
    // whose code/manifest changed since it was approved. First approval records
    // the baseline; a mismatch is surfaced (re-approve/deny) instead of auto-run.
    let baseline: { id: string; version: string; digest: string } | null = null
    const digest = p.digest
    if (digest) {
      const verdict = verifyPluginIntegrity(meta.id, digest, integrityStore)
      if (verdict === 'mismatch') {
        const expected = getRecordedDigest(vault, meta.id)
        const reapprove = await askReapproveIntegrity(meta, expected ?? '', digest)
        if (!reapprove) {
          notifyError(
            describePluginError(
              createPluginError('PLUGIN_VERIFY_FAILED', {
                pluginId: meta.id,
                message: `Plugin "${meta.name}"'s code or manifest changed since you approved it; refusing to run it.`,
                recovery: 'Re-approve it only if you trust the new version, or reinstall the plugin.',
              }),
            ),
          )
          continue
        }
        // Re-approved: adopt the new fingerprint as the baseline after import succeeds.
        baseline = { id: meta.id, version: meta.version, digest }
      } else if (verdict === 'missing') {
        // First approval in this store: record the baseline fingerprint after import succeeds.
        baseline = { id: meta.id, version: meta.version, digest }
      }
    }

    // GATE 3 — the import (LAST action before activation). Only reached after
    // consent + integrity pass, so a tampered/unapproved plugin's top-level
    // module code never executes.
    const importer: DynamicImport = () => importSource(source)
    let loadResult: LoadResult
    try {
      loadResult = await loadPlugin(meta, importer)
    } catch (e) {
      // loadPlugin normally swallows load errors into an ok:false result, but a
      // dynamic-import rejection can still escape — classify it the same way
      // instead of bubbling and aborting the whole scan.
      notifyError(describePluginError(loadFailure(meta, e instanceof Error ? e.message : String(e))))
      continue
    }
    if (!loadResult.ok) {
      notifyError(describePluginError(loadFailure(meta, loadResult.error)))
      continue
    }
    const definition = loadResult.definition

    // Post-import defensive consent: a plugin may declare capabilities in its
    // code that were not in the manifest. Re-verify the merged set so a
    // code-level declaration is still consent-gated. (Top-level has run by now,
    // but we refuse to register/activate the plugin and surface the denial.)
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

    // Adopt the (re-)approved fingerprint as the new baseline now that we have
    // committed to running this plugin.
    if (baseline) setRecordedDigest(vault, baseline.id, baseline.version, baseline.digest)

    // A declared capability is not capability-isolated while the plugin runs in
    // the main window; once we have decided to run it, make that explicit rather
    // than pretending to sandbox it.
    const nonIsolated = getNonIsolatedPermissions(meta, definition)
    signalUnsandboxedCapabilities(meta, nonIsolated)
    p.loadResult = loadResult
    consented.push(p)
  }

  // Phase 3 — parallel activation of the consented plugins, results recorded in
  // deterministic (consented) order. An activation rejection is captured into an
  // ok:false result so one failing plugin cannot abort the rest. Each activation
  // is time-boxed (async init that exceeds the budget is cancelled and the plugin
  // marked unstable), and a single AbortController lets the host cancel a running
  // activation (e.g. when the user switches vaults). A timeout/cancel leaves the
  // plugin deactivated and the host continues.
  const activationController = new AbortController()
  const activated = await runBounded(
    consented.map((p) => async () => {
      const loadResult = p.loadResult as LoadResult
      const res = await activatePlugin(loadResult, {
        signal: activationController.signal,
        timeoutMs: DEFAULT_PLUGIN_ACTIVATION_TIMEOUT_MS,
      }).catch((e) => ({
        ok: false as const,
        id: loadResult.id,
        error: e instanceof Error ? e.message : String(e),
        code: undefined as PluginErrorCode | undefined,
      }))
      return { meta: p.meta as PluginMeta, res }
    }),
    MAX_PARALLEL_PLUGIN_LOADS,
  )
  for (const { meta, res } of activated) {
    if (!res.ok) {
      // A structured timeout/cancel is routed to a distinct message; anything
      // else is a generic activation failure. In all cases the plugin was
      // already rolled back/marked unstable by the host, so the host continues.
      const code = res.code
      const error =
        code === 'PLUGIN_HOOK_TIMEOUT'
          ? createPluginError('PLUGIN_HOOK_TIMEOUT', {
              pluginId: res.id,
              message: `Plugin "${meta.name}" exceeded its activation time budget and was cancelled.`,
              recovery: 'Disable the plugin or check its logs.',
            })
          : code === 'PLUGIN_ABORTED'
            ? createPluginError('PLUGIN_ABORTED', {
                pluginId: res.id,
                message: `Plugin "${meta.name}" activation was cancelled.`,
                recovery: 'Retry activation, or disable the plugin.',
              })
            : createPluginError('PLUGIN_ACTIVATE_FAILED', {
                pluginId: res.id,
                message: `Plugin "${meta.name}" failed to activate: ${res.error ?? ''}`,
                recovery: 'Disable and re-enable the plugin, or reinstall it.',
              })
      notifyError(describePluginError(error))
      console.warn(`[NekoWite] vault plugin failed to activate: ${res.id}`, error)
      continue
    }
    activeVaultPluginIds.push(res.id)
    console.info(`[NekoWite] vault plugin activated: ${res.id}`)
  }
}
