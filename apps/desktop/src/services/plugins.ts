/**
 * Compatibility entry point for the vault plugin service.
 *
 * The implementation moved to `features/plugins/**` (roadmap §4): discovery,
 * the consent / integrity / trust gates, the vault-scoped governance store and
 * the audit-log sink each own their file, and `features/plugins/index.ts` is the
 * public API.
 *
 * This module remains as a one-stage compatibility layer (§10.1 rule 5) so
 * existing callers (`app/appBootstrap.ts`, `app/appDialogs.ts`,
 * `features/settings/composables/usePluginSettings.ts`) keep working while they
 * migrate to the feature entry point, at which point this file and the
 * `vi.mock('../services/plugins')` seams in their tests are removed together.
 * New code must import `features/plugins` directly.
 *
 * The 13 symbols that were exported here and imported nowhere were dropped in
 * the move rather than carried across; the feature entry point lists what the
 * app actually uses.
 */

export * from '../features/plugins'
