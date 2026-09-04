/**
 * Shared gateway runtime.
 *
 * Owns the single cached {@link AppGateways} instance for the process. The app
 * bootstrap is the composition root and uses this to inject the same gateways
 * into the application services; the legacy `getGateways()` forwarder (in
 * `services/gateways`) also resolves through here so un-migrated callers and
 * new code share one instance instead of creating their own.
 *
 * Holding the cache here (rather than in a module service code imports
 * directly) keeps the lifecycle in the runtime/infrastructure layer: tests can
 * `resetSharedGateways()` to get a fresh instance per test.
 */

import { createGateways, type GatewayDeps } from '../gateways'
import type { AppGateways } from '../gateways/contracts'

let cached: AppGateways | null = null

/** Resolve (and lazily build) the shared gateway instance. */
export function getSharedGateways(): AppGateways {
  if (!cached) cached = createGateways()
  return cached
}

/** Build a fresh shared gateway from explicit deps (used by the bootstrap to
 * override the detected environment or memory tuning). */
export function initSharedGateways(deps: GatewayDeps): AppGateways {
  cached = createGateways(deps)
  return cached
}

/** Drop the cached instance (test isolation). */
export function resetSharedGateways(): void {
  cached = null
}
