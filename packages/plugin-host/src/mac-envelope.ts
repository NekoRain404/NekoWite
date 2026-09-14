import { createPluginError } from './types'
import { encodePluginKeyMaterial } from './loader'

/* ------------------------------------------------------------------------- *
 * Integrity envelope (MAC) for persisted governance state.
 *
 * This is the fourth concern the old `governance.ts` carried: it protects the
 * *bytes* of a serialized governance/trust payload, and knows nothing about
 * what that payload means (the audit log, the version policy and the revocation
 * list are its callers, not its dependencies). It uses the same injection
 * pattern the loader does for key material: `encodePluginKeyMaterial` is the
 * loader's, so a hex secret and a passphrase are framed identically everywhere.
 * ------------------------------------------------------------------------- */

/** A MAC-framed envelope for a JSON payload: `payload` is the exact serialized
 *  string the MAC covers, `mac` is a hex HMAC-SHA256 over it keyed by a
 *  per-install secret.
 *
 *  Honest scope (documented in docs/SECURITY.md + docs/PLUGIN_SDK.md): this is
 *  TAMPER-DETECTION, not a secure root. The same secret that protects the payload
 *  is stored alongside it (or derived per-install and persisted in a sibling file),
 *  so a party with full file access can recompute the MAC. It detects casual
 *  corruption / stale reads and a localStorage-only attacker who cannot read the
 *  key, but is NOT a hardware root of trust. On a MAC failure the caller MUST
 *  treat the contained trust as reset/trust-nothing (never silently trust). */
export interface MacEnvelope {
  /** The exact serialized payload string the MAC covers. */
  payload: string
  /** Hex HMAC-SHA256 of `payload`. */
  mac: string
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

async function importMacKey(secret: string): Promise<CryptoKey> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (!subtle) {
    throw createPluginError('PLUGIN_SIGNATURE_INVALID', {
      pluginId: '',
      message: 'Web Crypto is unavailable in this environment; cannot protect governance state.',
      recovery: 'Run the plugin host in an environment with Web Crypto.',
    })
  }
  const keyBytes = encodePluginKeyMaterial(secret)
  return subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

/** Produce a MAC-framed envelope: a hex HMAC-SHA256 over `payload`, keyed by
 *  `secret`. Environment-agnostic (Web Crypto), so it is testable in a browser
 *  webview and in Node. */
export async function createMacEnvelope(payload: string, secret: string): Promise<MacEnvelope> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (!subtle) throw new Error('Web Crypto is unavailable; cannot protect governance state.')
  const key = await importMacKey(secret)
  const data = new TextEncoder().encode(payload)
  const sig = new Uint8Array(await subtle.sign('HMAC', key, data as BufferSource))
  return { payload, mac: bytesToHex(sig) }
}

/** Verify a MAC-framed envelope. Returns false (never throws) on any structural
 *  or MAC mismatch, so a tampered or corrupt payload is detected and refused. */
export async function verifyMacEnvelope(envelope: unknown, secret: string): Promise<boolean> {
  if (!envelope || typeof envelope !== 'object') return false
  const e = envelope as Partial<MacEnvelope>
  if (typeof e.payload !== 'string' || typeof e.mac !== 'string' || e.mac.length !== 64) return false
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (!subtle) return false
  try {
    const key = await importMacKey(secret)
    const data = new TextEncoder().encode(e.payload)
    const sig = hexToBytes(e.mac)
    return await subtle.verify('HMAC', key, sig as BufferSource, data as BufferSource)
  } catch {
    return false
  }
}

/** Generate a fresh 32-byte per-install secret, hex-encoded. Used to key the
 *  governance MAC envelope when no OS keychain is available. */
export function generateMacSecret(): string {
  const bytes = new Uint8Array(32)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytesToHex(bytes)
}
