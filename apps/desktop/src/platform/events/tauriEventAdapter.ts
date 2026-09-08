/**
 * Tauri event adapter.
 *
 * Implements {@link EventPort} on top of `@tauri-apps/api/event`. This is the
 * only place a business-service event subscription reaches Tauri's `listen`;
 * the business service calls `events.on('ai-chunk', ...)` and never imports
 * `@tauri-apps/api` itself. `listen` carries a `{ payload }` envelope, which
 * this adapter unwraps so callers receive the payload directly.
 */

import { listen, emit as tauriEmit } from '@tauri-apps/api/event'
import type { EventPort } from '../gateways/contracts'

export function createTauriEventAdapter(): EventPort {
  return {
    on<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
      return listen<T>(event, (e) => cb(e.payload))
    },
    emit<T>(event: string, payload: T): Promise<void> {
      return tauriEmit(event, payload)
    },
  }
}
