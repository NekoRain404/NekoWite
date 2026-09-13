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

import { createPluginError, verifyPluginSignature } from '@nekowite/plugin-host'
import type { PluginError, PluginMeta } from '@nekowite/plugin-host'
import {
  getPluginTrustedKey,
  isPluginTrustedSource,
  setPluginTrustedSource,
} from './governanceStore'

/** How unsigned plugins are treated when they are not on the allowlist. */
export type PluginTrustPolicy = 'permit-unsigned-with-notice' | 'require-trust'

let pluginTrustPolicy: PluginTrustPolicy = 'permit-unsigned-with-notice'

/** The configured trust policy. Default permits unsigned plugins with a logged
 *  "unsigned, untrusted-source" notice (so nothing is silently trusted as a
 *  security claim); `setPluginTrustPolicy('require-trust')` denies them unless
 *  explicitly trusted. */
export function getPluginTrustPolicy(): PluginTrustPolicy {
  return pluginTrustPolicy
}

/** Set the trust policy for unsigned plugins (session-only; not persisted). */
export function setPluginTrustPolicy(policy: PluginTrustPolicy): void {
  pluginTrustPolicy = policy
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
async function askPluginTrust(
  meta: PluginMeta,
  signature: string | undefined,
  reason: 'unsigned' | 'unverifiable-key',
): Promise<boolean> {
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

export async function decidePluginTrust(
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

/** Drop the session policy, the decider and the once-per-session notices
 *  (test-only). The trusted key and allowlist are governanceStore records. */
export function resetTrustPolicyStateForTests(): void {
  pluginTrustPolicy = 'permit-unsigned-with-notice'
  trustDecider = null
  unsignedNotified.clear()
}
