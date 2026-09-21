/**
 * The agents section's door: the navigation row that reaches it, the rail switch it opens on, and
 * the setting that switch writes — or leaves alone.
 *
 * The section is split by behaviour domain across sibling `SettingsPanel.agents.*.test.ts` files;
 * this one is the entry itself, before any page behind it is asserted. What the switch *is* by
 * default is `settings-agent.test.ts`'s question; this file's is that the page draws it, writes it
 * in both directions, and does not write it when the page is merely opened.
 */
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useSettingsStore } from '../../../stores/settings'
import { AGENT_PANEL_DEFAULT } from '../../../stores/settings-agent'
import {
  flip,
  openAgents,
  startAgentPanelAgents,
  switchInput,
} from './SettingsPanel.agents.mount'

// The mock `vi.mock` hoists above this file's imports; the harness installs it and answers through it.
const invokeMock = vi.hoisted(() => vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

startAgentPanelAgents(invokeMock)

describe('the agents section in the settings dialog', () => {
  it('is offered by the navigation, and opens on its own switch', async () => {
    await openAgents()
    expect(switchInput()).toBeTruthy()
    // Drawn from the store, not from a local copy: the switch is whatever the setting reads, and
    // that is the default until something stores one (it was off and is on as of 2026-09-19, which
    // is why this reads the constant rather than a literal).
    expect(switchInput().checked).toBe(AGENT_PANEL_DEFAULT)
  })

  it('writes the switch through to the store, in both directions', async () => {
    await openAgents()
    const store = useSettingsStore()

    flip(switchInput(), true)
    await nextTick()
    expect(store.agentPanel).toBe(true)

    flip(switchInput(), false)
    await nextTick()
    expect(store.agentPanel).toBe(false)
  })

  it('leaves the switch untouched when the dialog is only opened', async () => {
    // The case's subject is the second assertion, not the first: opening this page must not *write*
    // the setting. What the default happens to be is `settings-agent.test.ts`'s question, and it
    // moved to on in 2026-09-19 — but a page that wrote on mount would persist whatever it read,
    // and from then on the reader's silence would look like a choice they never made.
    await openAgents()
    const store = useSettingsStore()
    expect(store.agentPanel).toBe(AGENT_PANEL_DEFAULT)
    expect(localStorage.getItem('nekowite.agent.panel')).toBeNull()
  })
})
