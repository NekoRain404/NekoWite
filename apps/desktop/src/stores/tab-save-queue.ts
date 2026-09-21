import type { Ref } from 'vue'
import type { OpenTab } from './tabs'
import type { TabSaveOptions } from './tab-save'

export function createTabSaveQueue(deps: {
  tabs: Ref<OpenTab[]>
  vault: Ref<string | null>
  run(id: string, options: TabSaveOptions): Promise<boolean>
}) {
  const inFlight = new Map<string, Promise<boolean>>()
  let generation = 0

  async function saveTab(id: string, options: TabSaveOptions = {}): Promise<boolean> {
    const tab = deps.tabs.value.find((open) => open.id === id)
    const vault = deps.vault.value
    const ticket = generation
    if (!tab || !vault) return false
    const isCurrent = () => generation === ticket && deps.vault.value === vault
      && deps.tabs.value.includes(tab)
    // Every waiter rechecks the current owner after waking. Multiple waiters
    // can share one predecessor, but only one may claim the next transaction.
    let running = inFlight.get(id)
    while (running) {
      const ok = await running.catch(() => false)
      if (!ok || !isCurrent()) return false
      if (!tab.dirty) return true
      running = inFlight.get(id)
    }
    if (!isCurrent()) return false
    const run = deps.run(id, options).finally(() => {
      if (inFlight.get(id) === run) inFlight.delete(id)
    })
    inFlight.set(id, run)
    return run
  }

  function reset(): void {
    generation++
    inFlight.clear()
  }

  return { saveTab, reset }
}
