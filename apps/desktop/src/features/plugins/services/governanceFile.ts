/* ------------------------------------------------------------------------- *
 * The MAC-protected governance/trust file — P1.8.
 *
 * The SECURITY-relevant records (trusted key, trusted sources, plugin digests,
 * governance revocations/versions/ranges) are persisted in a single
 * vault-relative JSON file, wrapped in a keyed-HMAC envelope so tampering is
 * DETECTED. On a MAC failure the contained trust is refused (reset /
 * trust-nothing) and a notice is surfaced — we never silently load
 * attacker-controlled values.
 *
 * Honest scope (documented in docs/SECURITY.md + docs/PLUGIN_SDK.md):
 *   - The HMAC key is a per-install secret persisted in a sibling file (there is
 *     no OS keychain exposed to the frontend). An attacker who can read BOTH the
 *     file and its key can recompute the MAC, so this is TAMPER-DETECTION, not a
 *     secure hardware root. It stops a localStorage-only attacker from rewriting
 *     trust, and it detects casual corruption / stale reads.
 *   - localStorage is retained ONLY as a non-authoritative "saw this notice" flag,
 *     never for trust/revocation/digest data.
 *
 * This module owns the FILE: its path, its envelope, its key, and what a read
 * means. Which records it holds, and what they authorise, belongs to
 * ./governanceStore.
 * ------------------------------------------------------------------------- */

import { createMacEnvelope, generateMacSecret, verifyMacEnvelope } from '@nekowite/plugin-host'
import { fsService } from '../../../platform/gateways/fs'
import { persistence } from '../../../services/persistence'
import { notifyError } from '../../../services/errors'

/** Vault-relative path of the MAC-protected governance/trust state file. */
export const PLUGIN_GOVERNANCE_FILE = '.nekowite/plugin-governance.json'
/** Vault-relative path of the per-install HMAC secret that keys that file. */
export const PLUGIN_GOVERNANCE_MACKEY_FILE = '.nekowite/plugin-governance.mackey'
/** Non-authoritative localStorage flag: "surfaced the tamper notice this session." */
const PLUGIN_TAMPER_NOTICE_KEY = 'nekowite.pluginGovernanceTamperNotice'

/** A recorded plugin digest: the version it was approved at, and the digest. */
export interface DigestEntry {
  v: string
  d: string
}

export type DigestMap = Record<string, DigestEntry>

/** The serialized security-relevant records written into the MAC envelope. */
export interface GovernanceFilePayload {
  governance: string
  trustedKey: string
  trustedSources: string[]
  digests: DigestMap
  /** Plugin ids the user switched OFF in this vault. Persisted here rather than
   *  in localStorage because it is security-relevant policy (it decides whether
   *  a plugin's code runs at all) and this is the file the app already protects
   *  and treats as authoritative. A build from before the switch existed simply
   *  has no field, which reads as "nothing disabled". */
  disabled?: string[]
}

/** What a read of the governance file established. The four cases are kept
 *  distinct because they demand four different reactions from the caller:
 *  apply it, keep in-memory state, leave the file alone, or refuse its trust. */
export type GovernanceFileRead =
  /** Envelope verified: `payload` is the exact MAC-covered string. */
  | { kind: 'ok'; payload: string }
  /** No file yet (first run) or the read failed. */
  | { kind: 'absent' }
  /** Present, but not a MAC envelope we wrote — a stale/mismatched read (a note,
   *  a libwebfs path mismatch). Never clobber it. */
  | { kind: 'not-ours' }
  /** A MAC envelope whose MAC does not verify. TAMPERED. */
  | { kind: 'tampered' }

// Session cache of the per-install MAC secret per vault, so a save within the
// same session reuses the key that loaded the file (idempotent MAC).
const macSecretCache = new Map<string, string>()

/**
 * Load (or generate) the per-install HMAC secret for a vault, cached per session.
 * Best-effort: if no key file exists we generate a fresh 32-byte secret and try
 * to persist it; if that fails the secret still keys MACs for this session.
 */
export async function loadGovernanceMacSecret(vault: string): Promise<string> {
  const cached = macSecretCache.get(vault)
  if (cached) return cached
  try {
    const raw = await fsService.read(vault, PLUGIN_GOVERNANCE_MACKEY_FILE)
    if (typeof raw === 'string' && /^[0-9a-f]{64}$/i.test(raw)) {
      macSecretCache.set(vault, raw)
      return raw
    }
  } catch {
    /* no key file yet — generate a fresh one below */
  }
  const secret = generateMacSecret()
  macSecretCache.set(vault, secret)
  const write = (fsService as { write?: unknown }).write
  if (typeof write === 'function') {
    try {
      await (write as (v: string, p: string, c: string) => Promise<void>)(
        vault,
        PLUGIN_GOVERNANCE_MACKEY_FILE,
        secret,
      )
    } catch {
      /* best-effort: without a writable key store, MAC protection is session-only */
    }
  }
  return secret
}

/** Forget the cached MAC secrets (test-only; a fresh session re-derives them). */
export function clearMacSecretCache(): void {
  macSecretCache.clear()
}

/** Surface a single user-visible + console notice that the governance state failed
 *  its integrity check and was reset. Uses a localStorage flag purely as a
 *  NON-authoritative "seen this session" guard. */
export function signalGovernanceTamperNotice(): void {
  // The "saw this notice" guard is a NON-authoritative UI flag routed through
  // the persistence port (localStorage in the webview/tauri, memory in tests);
  // it is never a security decision.
  if (persistence.get(PLUGIN_TAMPER_NOTICE_KEY)) return
  persistence.set(PLUGIN_TAMPER_NOTICE_KEY, '1')
  console.warn(
    '[NekoWite] plugin governance state failed integrity (HMAC) verification; refusing the trust it contains and resetting it.',
  )
  notifyError(
    'Plugin trust/governance state failed its integrity check and was reset. No trust from that file was accepted.',
  )
}

/**
 * Read and verify a vault's governance file.
 *
 * The payload is returned as the exact MAC-covered STRING, not as parsed data:
 * a valid MAC over unparseable content and an invalid MAC are different events
 * (one is corruption, the other is tampering) and the callers react differently.
 */
export async function readGovernanceFile(vault: string): Promise<GovernanceFileRead> {
  let raw: string
  try {
    raw = await fsService.read(vault, PLUGIN_GOVERNANCE_FILE)
  } catch {
    return { kind: 'absent' } // first run: no governance file yet
  }
  let framed: unknown
  try {
    framed = JSON.parse(raw)
  } catch {
    return { kind: 'not-ours' } // not JSON — treat as uninitialized / stale read
  }
  if (
    !framed ||
    typeof (framed as { payload?: unknown }).payload !== 'string' ||
    typeof (framed as { mac?: unknown }).mac !== 'string'
  ) {
    return { kind: 'not-ours' } // not a MAC envelope; not a file we wrote
  }
  const secret = await loadGovernanceMacSecret(vault)
  if (!(await verifyMacEnvelope(framed, secret))) return { kind: 'tampered' }
  return { kind: 'ok', payload: (framed as { payload: string }).payload }
}

/** Write `payload` to a vault's MAC-protected governance file. Best-effort: a
 *  failed write must never break the mutation that requested it. */
export async function writeGovernanceFile(vault: string, payload: GovernanceFilePayload): Promise<void> {
  try {
    const secret = await loadGovernanceMacSecret(vault)
    const payloadStr = JSON.stringify(payload)
    const envelope = await createMacEnvelope(payloadStr, secret)
    await fsService.write(vault, PLUGIN_GOVERNANCE_FILE, JSON.stringify(envelope))
  } catch {
    /* best-effort persistence; never break a mutation because the file write failed */
  }
}
