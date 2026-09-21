/**
 * The pages whose host half exists: the registry, the profile, and the permission page mounted
 * behind them — what they draw, and what they refuse to offer.
 *
 * The section is split by behaviour domain across sibling `SettingsPanel.agents.*.test.ts` files;
 * this one is those three pages. They share one fact that is the point of the file: the dialog is
 * handed the registry's own answer, so the engine and profile pair on the pages is the backend's,
 * and a page that spelled it itself would fail here. The registry is also where the engine switch
 * is *not* offered — the dialog has no session to open — and the profile is where a save is at the
 * revision the form read.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  asked,
  el,
  openAgents,
  refusing,
  startAgentPanelAgents,
  untilDom,
} from './SettingsPanel.agents.mount'

// The mock `vi.mock` hoists above this file's imports; the harness installs it and answers through it.
const invokeMock = vi.hoisted(() => vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

startAgentPanelAgents(invokeMock)

describe('the agents section in the settings dialog', () => {
  it('says which engine and profile the mounted pages are about', async () => {
    await openAgents()
    await untilDom(
      () => (el('agents-profile')?.textContent ?? '').includes('bundled-engine'),
      'the pair',
    )
    expect(el('agents-profile')?.textContent).toContain('default')
  })

  it('offers no engine switch, because this dialog has no session to open', async () => {
    await openAgents()
    await untilDom(() => el('registry-row-bundled-engine') !== null, 'the registry page')
    // The page's own answer to `can-start-session="false"`: the fact, and no control.
    expect(el('registry-engine-elsewhere')).not.toBeNull()
    expect(el('registry-new-session')).toBeNull()
    expect(el('registry-engine-select')).toBeNull()
    expect(asked).not.toContain('agent_start')
  })

  it('sends a save at the revision the form read, and the next one at the revision it wrote', async () => {
    await openAgents()
    await untilDom(() => el('provider-save') !== null, 'the profile page')

    el('provider-save')?.click()
    await untilDom(
      () => asked.filter((command) => command === 'agent_profile_write').length === 1,
      'the first write',
    )
    expect(invokeMock).toHaveBeenCalledWith(
      'agent_profile_write',
      expect.objectContaining({ revision: 'r1', agentId: 'bundled-engine', profileId: 'default' }),
    )

    // The write answered `written` at r2 and the page re-read: the second save must be built on
    // the record as it is now. A form left holding r1 would send r1 again, the backend would call
    // it a conflict, and a save that landed would look refused.
    await untilDom(
      () => (el('provider-applied')?.textContent ?? '').trim().length > 0,
      'the applied note',
    )
    el('provider-save')?.click()
    await untilDom(
      () => asked.filter((command) => command === 'agent_profile_write').length === 2,
      'the second write',
    )
    expect(invokeMock).toHaveBeenLastCalledWith(
      'agent_profile_write',
      expect.objectContaining({ revision: 'r2' }),
    )
  })

  it('says why the profile page is missing when the registry cannot be read', async () => {
    refusing.add('agent_registry_read')
    await openAgents()
    await untilDom(() => el('registry-unreadable') !== null, 'the registry failure')

    // The registry page draws the backend's failure itself; the section does not repeat it — and
    // the profile page, whose pair comes from that read, is not mounted at all.
    expect(el('provider-identity')).toBeNull()
    expect(el('agents-profile')?.textContent).not.toContain('{profile}')
    expect(el('provider-loading')).toBeNull()
  })
})
