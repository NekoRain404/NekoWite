/**
 * The agent slice of the settings store: one persisted boolean, and the default that decides
 * what a user who never opens the section gets.
 *
 * Driven through `useSettingsStore()` rather than through the slice's own factory — the store
 * is the only caller of `createAgentSettings` (`settings-boundary.test.ts` holds that, and it
 * counts a factory reached from a test as a second holder).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from './settings'

const KEY = 'nekowite.agent.panel'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('the agent panel switch', () => {
  it('is off when nothing has been stored', () => {
    // §12's staged replacement: an install that never touches the switch keeps the chat panel,
    // which is also what makes the rollback story true for everyone who never asked for this.
    expect(useSettingsStore().agentPanel).toBe(false)
  })

  it('reads a stored choice back', () => {
    localStorage.setItem(KEY, 'true')
    setActivePinia(createPinia())
    expect(useSettingsStore().agentPanel).toBe(true)
  })

  it('persists a change, so the rollback survives the next launch', async () => {
    const store = useSettingsStore()
    store.agentPanel = true
    await nextTick()
    expect(localStorage.getItem(KEY)).toBe('true')

    store.agentPanel = false
    await nextTick()
    expect(localStorage.getItem(KEY)).toBe('false')
  })

  it('reads anything that is not the boolean it wrote as off', () => {
    // `readBool`'s contract, shared with every other boolean setting: a hand-edited or
    // half-written key must not be able to start an engine, and it must not throw either.
    localStorage.setItem(KEY, 'yes')
    setActivePinia(createPinia())
    expect(useSettingsStore().agentPanel).toBe(false)
  })
})
