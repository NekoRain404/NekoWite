/* ------------------------------------------------------------------------- *
 * Plugin change detection — task #24.
 *
 * We fingerprint the exact bytes the host will execute (the package.json
 * manifest text plus the loaded code) and compare it to the last value the user
 * approved. This is change detection, NOT cryptographic authentication: the
 * 32-bit FNV-1a digest is not signed and must never be presented as proof of
 * provenance. A mismatch simply means the plugin was modified since approval and
 * we refuse to silently run it, surfacing a structured PLUGIN_VERIFY_FAILED with
 * a re-approve/deny path instead.
 *
 * The baseline RECORD lives in ./governanceStore (it is a persisted,
 * vault-scoped record); what this module owns is the question we ask when the
 * recorded baseline and the observed bytes disagree.
 * ------------------------------------------------------------------------- */

import type { PluginMeta } from '@nekowite/plugin-host'

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
export async function askReapproveIntegrity(
  meta: PluginMeta,
  expectedDigest: string,
  actualDigest: string,
): Promise<boolean> {
  if (!integrityDecider) return false
  return integrityDecider(meta, expectedDigest, actualDigest)
}

/** Drop the installed decider (test-only). */
export function resetIntegrityStateForTests(): void {
  integrityDecider = null
}
