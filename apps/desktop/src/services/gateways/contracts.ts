/**
 * Gateway contract compatibility barrel.
 *
 * The named ports now live in `platform/gateways/contracts`. This module only
 * re-exports them so existing `services/gateways/contracts` imports keep
 * resolving during the 3-step migration (docs/dev.md §5.6.4). The `FsGateway`
 * type-alias remains as a type-only backward-compat name for the legacy
 * combined gateway shape.
 *
 * TODO(#R4): delete this forwarder once `rg "gateways/contracts"` on
 * business/feature code returns 0; migrate callers to `platform/gateways`.
 */

export * from '../../platform/gateways/contracts'
