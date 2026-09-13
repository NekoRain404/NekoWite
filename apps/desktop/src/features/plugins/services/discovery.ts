/* ------------------------------------------------------------------------- *
 * Vault plugin discovery — finding plugin directories, reading their manifest
 * and their code SOURCE (never executing it), and fingerprinting the exact bytes
 * the host would run. This is the module that owns the vault filesystem boundary
 * for plugins: the `PluginFsAdapter` plugin-host defines, built from the app's
 * vault file service, and the CSP gate that decides whether an in-window import
 * is possible at all.
 * ------------------------------------------------------------------------- */

import {
  buildPluginSignaturePayload,
  computePluginDigest,
  createPluginError,
  joinPath,
  recordPluginEvent,
} from '@nekowite/plugin-host'
import type {
  LoadResult,
  PluginDefinition,
  PluginError,
  PluginErrorCode,
  PluginFsAdapter,
  PluginFsEntry,
  PluginMeta,
  PluginPermission,
} from '@nekowite/plugin-host'
import { fsService } from '../../../platform/gateways/fs'
import { notifyError } from '../../../services/errors'
import { t } from '../../../i18n'

interface VaultPluginPackage {
  name?: string
  version?: string
  main?: string
  permissions?: PluginPermission[]
  /** Optional HMAC-SHA256 signature (hex) from a trusted publisher. */
  signature?: string
}

/** Join path segments, collapsing duplicate slashes. Shared with ./auditLog,
 *  which builds the vault-relative audit-log path the same way. */
export function joinVault(...parts: string[]): string {
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

export function signalPluginLoadingDisabledByCsp(): void {
  if (cspBlockedNotified) return
  cspBlockedNotified = true
  recordPluginEvent('*', 'import-refused', 'CSP blocks in-window plugin loading (no process/WebView isolation)')
  notifyError(t('plugin.loadingDisabled'))
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
export function makeVaultPluginFsAdapter(vault: string): PluginFsAdapter {
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
export async function importSource(source: string): Promise<{ default?: PluginDefinition }> {
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
export const MAX_PARALLEL_PLUGIN_LOADS = 4

/** Run `tasks` (index-aligned) with at most `limit` concurrent promises, while
 *  preserving the original task order in the returned array. */
export async function runBounded<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
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

/** Turn a raw dynamic-import failure string into a structured plugin error code
 *  so the loader can distinguish a code/parse problem from a generic load
 *  failure (missing entry file, unresolved module, etc.). */
export function classifyLoadError(error: string): PluginErrorCode {
  if (/syntax|parse|unexpected|SyntaxError|Unexpected/i.test(error)) return 'PLUGIN_CODE_PARSE_FAILED'
  if (/cannot find module|module not found|no such file|failed to fetch|not found|does not provide an export|404/i.test(error)) {
    return 'PLUGIN_NOT_FOUND'
  }
  return 'PLUGIN_LOAD_FAILED'
}

/** Build a structured plugin error for a load-stage failure, keyed off the
 *  classified code so the recovery hint matches the problem. */
export function loadFailure(meta: PluginMeta, error: string): PluginError {
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
export interface PreloadedPlugin {
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
export async function preloadVaultPlugin(
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

/** Drop the once-per-session CSP notice flag (test-only). */
export function resetDiscoveryStateForTests(): void {
  cspBlockedNotified = false
}
