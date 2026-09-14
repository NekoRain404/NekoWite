/**
 * The memory adapter's AI port.
 *
 * The port answers immediately and emits no events of its own: the request id
 * and the `ai-chunk` / `ai-done` / `ai-error` lifecycle belong to the real
 * (streaming) gateways, and a test that wants that stream drives it through the
 * shared event bus instead. `fail` and `delayMs` are the shared fault policy
 * (`memoryFaults.ts`), so a chat test can make `complete` reject or hang exactly
 * as the fs tests can.
 */

import type { AiPort } from './contracts'
import { simulateCall, type MemoryFault } from './memory-faults'

export type MemoryAiOptions = MemoryFault

export function createMemoryAiGateway(opts: MemoryAiOptions = {}): AiPort {
  return {
    complete: () => simulateCall(opts, () => undefined),
    cancel: async () => undefined,
    listModels: async () => [],
  }
}

export const memoryAiGateway = createMemoryAiGateway()
