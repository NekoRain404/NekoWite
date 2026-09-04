import type { PluginDefinition, PluginMeta } from './types'
import { createPluginError } from './types'

export type { PluginDefinition, PluginMeta } from './types'

export type LoadResult =
  | { ok: true; id: string; meta: PluginMeta; definition: PluginDefinition }
  | { ok: false; id: string; error: string }

export interface LoadedPlugin {
  meta: PluginMeta
  definition: PluginDefinition
}

export type DynamicImport = (specifier: string) => Promise<{ default?: PluginDefinition }>

/**
 * The file-access boundary the loader reads a vault plugin directory through.
 * Injecting this (rather than importing `node:fs/promises` directly) keeps the
 * loader environment-agnostic: the Tauri desktop host passes a real adapter
 * (its Rust-backed fs), while a browser/Demo host passes a no-op/graceful one.
 * A browser-targeted build therefore never references Node built-ins.
 */
export interface PluginFsEntry {
  name: string
  isDirectory(): boolean
}

export interface PluginFsAdapter {
  /** Read a file as UTF-8 text. */
  readFile(path: string): Promise<string>
  /** List a directory's direct entries. */
  readdir(dir: string): Promise<PluginFsEntry[]>
  /** Report whether a path is a directory (used to identify plugin dirs). */
  stat(path: string): Promise<{ isDirectory(): boolean }>
}

/** A minimal, environment-agnostic POSIX-style join (uses "/" separators so the
 *  loader produces stable specifiers on every platform and never imports the
 *  `node:path` built-in). */
export function joinPath(...parts: string[]): string {
  let out = ''
  for (const part of parts) {
    if (!part) continue
    if (out === '') out = part
    else out = `${out.replace(/\/+$/, '')}/${part.replace(/^\/+/, '')}`
  }
  return out
}

export async function loadPlugin(meta: PluginMeta, dynamicImport: DynamicImport): Promise<LoadResult> {
  try {
    const mod = await dynamicImport(meta.main)
    if (!mod.default) return { ok: false, id: meta.id, error: 'plugin has no default export' }
    return { ok: true, id: meta.id, meta, definition: mod.default }
  } catch (err) {
    return { ok: false, id: meta.id, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Scan a vault plugins directory (each subdir holding a package.json) and load
 * each valid plugin. The host injects the fs adapter; without one the loader
 * fails gracefully with a structured, actionable error instead of hitting a
 * missing Node built-in in a browser build.
 */
export async function loadPluginsFromDir(
  vaultPath: string,
  fs: PluginFsAdapter,
): Promise<LoadedPlugin[]> {
  if (!fs) {
    throw createPluginError('PLUGIN_LOAD_FAILED', {
      pluginId: '',
      message:
        'Cannot scan the plugin directory: no file-system adapter is available in this environment.',
      recovery: 'Run the app in the desktop environment, or inject a file-system adapter.',
    })
  }
  const entries = await fs.readdir(vaultPath)
  const plugins: LoadedPlugin[] = []
  for (const entry of entries) {
    let isDir = false
    try {
      isDir = entry.isDirectory?.() ?? (await fs.stat(joinPath(vaultPath, entry.name))).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue
    const dir = joinPath(vaultPath, entry.name)
    const pkgPath = joinPath(dir, 'package.json')
    let pkg: { name?: string; version?: string; main?: string }
    try {
      pkg = JSON.parse(await fs.readFile(pkgPath)) as typeof pkg
    } catch {
      continue
    }
    if (!pkg.name || !pkg.version || !pkg.main) continue
    const meta: PluginMeta = {
      id: pkg.name,
      name: pkg.name,
      version: pkg.version,
      main: joinPath(dir, pkg.main),
    }
    const result = await loadPlugin(meta, (specifier) => import(specifier))
    if (result.ok) plugins.push({ meta, definition: result.definition })
  }
  return plugins
}

/* ------------------------------------------------------------------------- *
 * Pragmatic plugin integrity (signature-level verification is out of scope).
 *
 * We fingerprint a plugin from the bytes the host actually executes (the
 * manifest text + the loaded code) and compare it to the last value the user
 * approved. This is NOT authentication — it detects that a plugin's code or
 * manifest changed between approvals so the host can refuse to silently run
 * modified code. Hashes are deterministic FNV-1a 32-bit (constant-width hex),
 * computed synchronously so the loader phases stay simple.
 * ------------------------------------------------------------------------- */

/** Deterministic FNV-1a 32-bit hash of the joined parts. Each part is
 *  delimited so `["ab","c"]` hashes differently from `["a","bc"]`. */
export function computePluginDigest(...parts: Array<string | undefined | null>): string {
  let hash = 0x811c9dc5
  for (const part of parts) {
    if (part === undefined || part === null) continue
    for (let i = 0; i < part.length; i++) {
      hash ^= part.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    hash ^= 0xff
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Where the host persists the last-approved digest per plugin id. */
export interface PluginDigestStore {
  get(id: string): string | undefined
  set(id: string, digest: string): void
}

export type PluginIntegrityVerdict = 'ok' | 'missing' | 'mismatch'

/** Compare a freshly-computed digest to the persisted (last-approved) value.
 *  - `ok`      — matches the approved fingerprint.
 *  - `missing` — no fingerprint recorded yet (first approval).
 *  - `mismatch`— the plugin's code/manifest changed since it was approved. */
export function verifyPluginIntegrity(
  id: string,
  actualDigest: string,
  store: PluginDigestStore,
): PluginIntegrityVerdict {
  const expected = store.get(id)
  if (expected === undefined) return 'missing'
  return expected === actualDigest ? 'ok' : 'mismatch'
}
