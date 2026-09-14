import { createPluginError, type PluginErrorCode } from './types'

/* ------------------------------------------------------------------------- *
 * The refusal vocabulary shared by the governance gates: revocation, the
 * version policy and the session quota all answer a load with the same error
 * shape, so an embedder can route any of them to a user-facing message without
 * knowing which gate refused. Keeping the codes and their default wording in
 * one place is also what stops a refusal from going silent — every caller of a
 * gate has this to hand.
 * ------------------------------------------------------------------------- */

/** A structured refusal for a governance gate (revoked / version-based). The
 *  embedder routes this to a user-facing message with a clear reason. */
export function governanceRefusal(
  pluginId: string,
  kind: 'revoked' | 'version-refused' | 'quota-exceeded',
  detail?: string,
  recovery?: string,
): Error {
  const code: PluginErrorCode =
    kind === 'revoked'
      ? 'PLUGIN_REVOKED'
      : kind === 'version-refused'
        ? 'PLUGIN_VERSION_REFUSED'
        : 'PLUGIN_QUOTA_EXCEEDED'
  const message =
    detail ??
    (kind === 'revoked'
      ? 'This plugin has been revoked and is no longer permitted to run.'
      : kind === 'version-refused'
        ? 'This plugin version is outside the supported version range.'
        : 'This plugin exceeded its session resource quota and must be re-approved.')
  return createPluginError(code, {
    pluginId,
    message,
    recovery: recovery ?? 'Contact the publisher, or reinstall a supported version.',
  })
}
