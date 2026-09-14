/**
 * In-memory event adapter.
 *
 * A zero-backend {@link EventPort} used by the browser/demo build and by unit
 * tests that need to simulate the platform event stream (fs changes, AI
 * lifecycle events) without a Tauri bridge. `emit` fans a payload out to every
 * current subscriber; the returned unsubscribe cancels a subscription.
 *
 * A subscription is a REGISTRATION, not a callback: `on` with the same function
 * twice is two live subscriptions, and an unsubscribe removes exactly its own.
 * That is what the Tauri adapter does — every `listen()` installs its own
 * wrapper and its own backend id — and the difference is not cosmetic. Keying
 * by callback identity made a duplicate `on` fold into the first and one `off`
 * remove it, so the whole "subscribed twice, unlistened once" class of leak
 * could not be observed in any test using this adapter (see the file-tree
 * subscription: two live listeners per vault in the app, one in the suite).
 */

import type { EventPort } from '../gateways/contracts'

export interface MemoryEventPort extends EventPort {
  /** Number of live subscribers for `event` — test introspection. One per
   *  `on` call, exactly as `listen` counts them on the Tauri side. */
  listenerCount(event: string): number
}

interface Registration {
  cb: (payload: unknown) => void
}

export function createMemoryEventAdapter(): MemoryEventPort {
  const listeners = new Map<string, Set<Registration>>()

  function setFor(event: string): Set<Registration> {
    let set = listeners.get(event)
    if (!set) {
      set = new Set()
      listeners.set(event, set)
    }
    return set
  }

  return {
    on<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
      const registration: Registration = { cb: cb as (payload: unknown) => void }
      const set = setFor(event)
      set.add(registration)
      return Promise.resolve(() => {
        set.delete(registration)
        if (set.size === 0) listeners.delete(event)
      })
    },

    emit<T>(event: string, payload: T): Promise<void> {
      const set = listeners.get(event)
      if (set) {
        // Copy so a subscriber that unsubscribes mid-emit cannot skip others.
        for (const registration of [...set]) registration.cb(payload)
      }
      return Promise.resolve()
    },

    listenerCount(event: string): number {
      return listeners.get(event)?.size ?? 0
    },
  }
}
