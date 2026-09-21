/**
 * The runtime page: §3.1.4's, and the one mounted page that reads a *live* fact rather than a stored
 * one — the protocol version and the capability rows come off the running incarnation's handshake.
 *
 * The section is split by behaviour domain across sibling `SettingsPanel.agents.*.test.ts` files;
 * this one is that wire, in both of its arms. The arm with a handshake is asserted in
 * `SettingsPanel.agents.pages.test.ts`, where the page is mounted with every other one; this file
 * owns the other arm, where no engine has been negotiated with and the page says so in the
 * backend's words instead of drawing an empty negotiation. The two are different states, and a page
 * drawing the absent one's sentences beside a read one's numbers would be lying twice.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  asked,
  el,
  openAgents,
  registryReadout,
  runtimeReadout,
  startAgentPanelAgents,
  untilDom,
} from './SettingsPanel.agents.mount'

// The mock `vi.mock` hoists above this file's imports; the harness installs it and answers through it.
const invokeMock = vi.hoisted(() => vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

startAgentPanelAgents(invokeMock)

describe('the agents section in the settings dialog', () => {
  it('draws no protocol and no capability list when no engine has been negotiated with', async () => {
    // The other arm of the same wire, and the whole reason the readout's handshake is a union: with
    // no handshake there is no protocol version and no capability row to draw — and the page says
    // so in the backend's words rather than drawing either of them empty. The old page drew
    // `{version: null, negotiated: false}` here, which is a claim about an engine nothing had asked.
    invokeMock.mockImplementation(async (command: string) => {
      asked.push(command)
      if (command === 'agent_registry_read') return registryReadout()
      if (command === 'agent_runtime_read') {
        return {
          ...(runtimeReadout() as Record<string, unknown>),
          process: 'stopped',
          handshake: { status: 'not-read', reason: 'no-engine' },
          capabilities: [],
        }
      }
      return undefined
    })
    await openAgents()
    await untilDom(() => el('runtime-not-negotiated') !== null, 'the runtime absence')

    expect(el('runtime-not-negotiated')?.textContent).toContain('No engine is running')
    // Nothing asserted about a negotiation, because none happened: not a version, not the engine's
    // name, not one capability row — and not the empty list either, which would read as "this
    // engine can do nothing".
    expect(el('runtime-protocol')).toBeNull()
    expect(el('runtime-engine-report')).toBeNull()
    expect(el('runtime-capability-session-list')).toBeNull()
    expect(el('runtime-auth-methods')).toBeNull()
    // What is a fact about this app rather than about an engine is still drawn: the process is
    // stopped, and the update policy is the provenance's.
    expect(el('runtime-process')?.textContent).toContain('Not running')
    expect(el('runtime-update')).not.toBeNull()
  })
})
