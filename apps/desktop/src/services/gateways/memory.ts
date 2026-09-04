/**
 * Legacy memory-adapter barrel.
 *
 * The real adapters live in `platform/gateways/memory.ts` (+ the memory event
 * adapter). This module re-exports them (with the historical instance names) so
 * existing `services/gateways/memory` imports keep resolving during transition.
 *
 * TODO(#R4): delete this forwarder once nothing in `services/**` imports it.
 */

export {
  createMemoryFsGateway,
  memoryFsGateway,
  createMemoryAiGateway,
  memoryAiGateway,
  createMemoryDialogPort,
  memoryKeyPort as memoryKeyGateway,
  createMemoryEventAdapter,
  type MemoryFsOptions,
  type MemoryAiOptions,
} from '../../platform/gateways/memory'
