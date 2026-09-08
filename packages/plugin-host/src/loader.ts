import type { PluginDefinition, PluginMeta, PluginPermission } from './types'
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
    // The plugin entry specifier is resolved at RUNTIME (a vault path joined
    // with the plugin's declared `main`), so it is never a statically-analyzable
    // import. `/* @vite-ignore */` tells Vite to leave it alone rather than warn
    // that it cannot analyze a dynamic specifier. This is intentional and must be
    // re-reviewed when plugin process/Worker isolation is implemented: the
    // specifier will STILL be runtime-determined there, but the host should route
    // it through that isolated loader (not a bare in-window dynamic import), and
    // its execution stays CSP-gated regardless.
    const result = await loadPlugin(meta, (specifier) => import(/* @vite-ignore */ specifier))
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

/* ------------------------------------------------------------------------- *
 * Plugin trust: HMAC-SHA256 signature verification + trusted-source policy.
 *
 * The 32-bit FNV-1a digest above is CHANGE-DETECTION, NOT authentication: it is
 * unkeyed, so anyone (including a tamperer) can recompute it. The trust anchor
 * is a HMAC-SHA256 signature (a shared-secret MAC) over a canonical
 * code+manifest payload, verified through the standard Web Crypto API
 * (globalThis.crypto.subtle — zero new dependencies, present in both the
 * browser webview and Node). A signature that verifies against a user-supplied
 * trusted publisher key proves the plugin was produced by an author who holds
 * that same secret: integrity-of-source.
 *
 * Honest limits (documented in docs/PLUGIN_SDK.md):
 *  - This is a shared-secret MAC, NOT public-key (asymmetric) authentication:
 *    the SAME secret signs and verifies, so it authenticates to a shared secret,
 *    not to a published public key. (A real Ed25519 scheme would avoid the
 *    shared-secret property, but adds a crypto dependency this repo avoids.)
 *  - It is not process isolation: a signed plugin still runs in the main
 *    window and a granted permission can reach Tauri IPC / the file system.
 *  - Without a configured trusted key, a present signature cannot be verified
 *    and is treated as a refusal, not silently accepted.
 * ------------------------------------------------------------------------- */

/** User-supplied trusted publisher key material: a hex string (decoded to raw
 *  bytes) or any other UTF-8 string used verbatim as the HMAC key. */
export type PluginTrustKey = string

/** The trust verdict for a plugin, before the trusted-source policy applies.
 *  - 'trusted'  — a present signature verified against the trusted key.
 *  - 'invalid'  — a signature was present but FAILED verification (REFUSE).
 *  - 'unsigned' — no signature; falls under the trusted-source policy
 *                 (explicit user trust / allowlist, or an unstamped notice). */
export type PluginTrustVerdict = 'trusted' | 'unsigned' | 'invalid'

/** The "publisher id" for a plugin id. Scoped packages (`@scope/name`) are
 *  attributed to their scope (`@scope`); unscoped ids (`name`) to themselves.
 *  Used by the trusted-source allowlist so trusting a publisher trusts all its
 *  plugins rather than one id at a time. */
export function publisherIdOf(pluginId: string): string {
  if (pluginId.startsWith('@')) {
    const slash = pluginId.indexOf('/')
    if (slash > 0) return pluginId.slice(0, slash)
  }
  return pluginId
}

function utf8Encode(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`invalid hex: ${hex.slice(0, 16)}…`)
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** Encode the trusted key material: a valid even-length hex string is treated as
 *  raw key bytes; any other string is used as its UTF-8 bytes. */
export function encodePluginKeyMaterial(keyMaterial: PluginTrustKey): Uint8Array {
  const trimmed = keyMaterial.trim()
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return fromHex(trimmed)
  }
  return utf8Encode(keyMaterial)
}

/** Canonical, deterministic payload the publisher signs and the host verifies.
 *  Key order is fixed, permissions are sorted — so the same plugin always yields
 *  the same payload. Signed over the declared manifest fields + the exact code
 *  bytes the host will execute. */
export function buildPluginSignaturePayload(
  id: string,
  version: string,
  main: string,
  code: string,
  permissions?: PluginPermission[],
): string {
  const perms = [...(permissions ?? [])].slice().sort()
  return JSON.stringify({ id, version, main, permissions: perms, code })
}

async function importPluginHmacKey(keyMaterial: PluginTrustKey): Promise<CryptoKey> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (!subtle) {
    throw createPluginError('PLUGIN_SIGNATURE_INVALID', {
      pluginId: '',
      message: 'Web Crypto is unavailable in this environment; cannot verify a plugin signature.',
      recovery: 'Run the plugin host in an environment with Web Crypto.',
    })
  }
  const keyBytes = encodePluginKeyMaterial(keyMaterial)
  return subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

/** Verify a plugin's hex signature (HMAC-SHA256, shared-secret key) over the
 *  given payload. Returns false on any verification failure, and never imports. */
export async function verifyPluginSignature(
  signature: string,
  payload: string,
  keyMaterial: PluginTrustKey,
): Promise<boolean> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (!subtle) {
    throw createPluginError('PLUGIN_SIGNATURE_INVALID', {
      pluginId: '',
      message: 'Web Crypto is unavailable in this environment; cannot verify a plugin signature.',
      recovery: 'Run the plugin host in an environment with Web Crypto.',
    })
  }
  const key = await importPluginHmacKey(keyMaterial)
  const sig = fromHex(signature)
  const data = utf8Encode(payload)
  return subtle.verify('HMAC', key, sig as BufferSource, data as BufferSource)
}

/** Produce a hex HMAC-SHA256 signature over a payload with a trusted key. This
 *  is the publisher-side companion to verifyPluginSignature (also useful for a
 *  future signing CLI and for the test suite to craft genuine signatures). */
export async function createPluginSignature(
  payload: string,
  keyMaterial: PluginTrustKey,
): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (!subtle) {
    throw createPluginError('PLUGIN_SIGNATURE_INVALID', {
      pluginId: '',
      message: 'Web Crypto is unavailable in this environment; cannot sign a plugin.',
      recovery: 'Run the plugin host in an environment with Web Crypto.',
    })
  }
  const key = await importPluginHmacKey(keyMaterial)
  const data = utf8Encode(payload)
  const sig = new Uint8Array(await subtle.sign('HMAC', key, data as BufferSource))
  return toHex(sig)
}
