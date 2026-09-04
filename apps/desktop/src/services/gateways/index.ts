/**
 * Gateway composition facade.
 *
 * `createGateways(deps)` (the recommended entry point) is a pure factory that
 * returns the named ports; it lives in `platform/gateways` and holds no cache.
 * The app bootstrap and `platform/runtime` own the single shared instance.
 *
 * `getGateways()` is the 3-step-compat forwarder kept so the still-un-migrated
 * callers (`services/fs.ts`, `stores/settings.ts`, the `ui/*` components) keep
 * resolving a gateway without threading deps through every import. It resolves
 * the same instance the bootstrap uses (via `platform/runtime`), so new and old
 * code never diverge.
 *
 * TODO(#R4): once every caller uses `createGateways(deps)` / explicit ports,
 * delete this file and move `getGateways()` into the runtime layer.
 */

import { createGateways, type GatewayDeps } from '../../platform/gateways'
import { getSharedGateways, initSharedGateways, resetSharedGateways } from '../../platform/runtime/gatewayRuntime'
import type { AppGateways } from '../../platform/gateways/contracts'

export { createGateways }
export type { GatewayDeps, AppGateways }

/** Legacy forwarder backed by the runtime-owned shared instance. */
export function getGateways(): AppGateways {
  return getSharedGateways()
}

export { initSharedGateways, resetSharedGateways }
