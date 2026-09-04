/**
 * In-memory event adapter.
 *
 * A zero-backend {@link EventPort} used by the browser/demo build and by unit
 * tests that need to simulate the platform event stream (fs changes, AI
 * lifecycle events) without a Tauri bridge. `emit` fans a payload out to every
 * current subscriber; the returned unsubscribe cancels a subscription.
 */

import type { EventPort } from '../gateways/contracts'

export interface MemoryEventPort extends EventPort {
  /** Number of live subscribers for `event` — test introspection. */
  listenerCount(event: string): number
}

export function createMemoryEventAdapter(): MemoryEventPort {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()

  return {
    on<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      const wrapped = cb as (payload: unknown) => void
      set.add(wrapped)
      return Promise.resolve(() => {
        set.delete(wrapped)
        if (set.size === 0) listeners.delete(event)
      })
    },

    emit<T>(event: string, payload: T): Promise<void> {
      const set = listeners.get(event)
      if (set) {
        // Copy so a subscriber that unsubscribes mid-emit cannot skip others.
        for (const cb of [...set]) cb(payload)
      }
      return Promise.resolve()
    },

    listenerCount(event: string): number {
      return listeners.get(event)?.size ?? 0
    },
  }
}
