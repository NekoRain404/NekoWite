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
import { AGENT_PANEL_DEFAULT } from './settings-agent'

const KEY = 'nekowite.agent.panel'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('the agent panel switch', () => {
  it('is on when nothing has been stored', () => {
    // It was off until 2026-09-19, and this case asserted that. The maintainer's own report is what
    // moved it: 「AI 界面没有 / 命令提示」 — the `/` menu is built, mounted and covered end to end,
    // and the rail still drew the chat panel for everyone who never opened the switch, because the
    // chat panel has no `/` menu at all. A surface nobody finds is the same defect as a surface
    // that was never wired.
    //
    // What has not changed is the rollback: `AppShell.vue`'s `@use-chat` writes `false`, and the
    // case below is the one that holds that it survives the next launch.
    expect(useSettingsStore().agentPanel).toBe(true)
  })

  it('reads a stored choice back', () => {
    localStorage.setItem(KEY, 'true')
    setActivePinia(createPinia())
    expect(useSettingsStore().agentPanel).toBe(true)
  })

  it('persists a change, so the rollback survives the next launch', async () => {
    const store = useSettingsStore()
    // The direction is whatever the default is not: a write of the value already held is not a
    // change, so the watcher does not fire and this case would assert nothing. It read `true` first
    // while the default was off.
    const away = !AGENT_PANEL_DEFAULT
    store.agentPanel = away
    await nextTick()
    expect(localStorage.getItem(KEY)).toBe(String(away))

    store.agentPanel = AGENT_PANEL_DEFAULT
    await nextTick()
    expect(localStorage.getItem(KEY)).toBe(String(AGENT_PANEL_DEFAULT))
  })

  it('reads anything that is not the boolean it wrote as the default', () => {
    // `readBool`'s contract, shared with every other boolean setting: a truncated write, or a key
    // someone edited by hand, lands on the fallback. It read 「as off」 until 2026-09-19 because the
    // fallback was off — and the property that used to ride on that, 「a half-written key must not
    // be able to start an engine」, no longer holds, because the default now starts the panel the
    // way silence does. That is the trade the default flip makes and it is worth stating plainly
    // rather than leaving in a comment that no longer describes what runs.
    localStorage.setItem(KEY, 'yes')
    setActivePinia(createPinia())
    expect(useSettingsStore().agentPanel).toBe(AGENT_PANEL_DEFAULT)
  })
})
