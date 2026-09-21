import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/** The event is a wakeup; only the main-only consume command owns request delivery. */
export async function onPetNavigation<T>(
  channel: string,
  command: string,
  receive: (request: T) => void,
): Promise<() => void> {
  let active = true
  let pending = Promise.resolve()
  const drain = () => {
    pending = pending.then(async () => {
      if (!active) return
      const requests = await invoke<T[]>(command)
      if (active) requests.forEach(receive)
    }).catch((error: unknown) => {
      console.error(`[NekoWite] could not consume ${channel}`, error)
    })
    return pending
  }
  try {
    const release = await listen(channel, () => { void drain() })
    // Listen first: a click during this initial consume either appears in its result or wakes
    // the next consume. Serial draining keeps replies from overtaking later clicks.
    await drain()
    return () => { active = false; release() }
  } catch {
    active = false
    return () => {}
  }
}
