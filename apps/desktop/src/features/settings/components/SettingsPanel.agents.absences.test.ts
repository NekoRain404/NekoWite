/**
 * What the section states in words: the paths a mounted page does not close, the pages it does not
 * mount at all, and the controls it therefore has no right to draw.
 *
 * The section is split by behaviour domain across sibling `SettingsPanel.agents.*.test.ts` files;
 * this one is the negative half — the sentences. Two claims, both about honesty rather than
 * rendering: a merge this app cannot close is *named* with the surface it opens (the session's own
 * folder, the machine's managed root) instead of being drawn as though it were closed, and a section
 * with no client in this build is a list item with no control of this page's own — because a
 * disabled control would be a claim that the capability exists and is temporarily off.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  el,
  openAgents,
  section,
  startAgentPanelAgents,
  switchInput,
  untilDom,
} from './SettingsPanel.agents.mount'

// The mock `vi.mock` hoists above this file's imports; the harness installs it and answers through it.
const invokeMock = vi.hoisted(() => vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

startAgentPanelAgents(invokeMock)

describe('the agents section in the settings dialog', () => {
  it('states the merges it does not close, one named surface per row', async () => {
    await openAgents()
    await untilDom(() => el('provider-source-engine-discovery') !== null, 'the sources list')

    const rows = [...section().querySelectorAll<HTMLElement>('[data-test^="provider-source-"]')]
    const discovery = rows.filter((row) => row.dataset.test === 'provider-source-engine-discovery')
    // Two rows, and they are the two merges this app cannot close: the folder the session runs in
    // (with every folder above it) and the machine's managed root. Each carries its own sentence,
    // and neither is drawn as though it were closed — the page states them and claims nothing.
    expect(discovery).toHaveLength(2)
    const text = discovery.map((row) => row.textContent ?? '').join('\n')
    expect(text).toContain('opencode.json')
    expect(text).toContain('/etc/opencode')
    // And the half that *is* set: one row per injected root, with the variable that carries it.
    const injected = rows.filter((row) => row.dataset.test === 'provider-source-injected')
    expect(injected).toHaveLength(1)
    expect(injected[0].textContent).toContain('OPENCODE_CONFIG_DIR = /tmp/profile')
  })

  it('states the absences as text, one per section it does not mount, and draws nothing else', async () => {
    await openAgents()
    const gaps = [...section().querySelectorAll<HTMLElement>('.agent-gap')]
    // Two sections without a client — commands and MCP — plus the one row that is not a section:
    // the engine switch. Derived from `AGENT_SETTINGS_SECTIONS` in the section, so this count moves
    // when a page is mounted — or when one is added to the tree. It moved from four when the skills
    // page was mounted and from three-plus-two when the runtime page was, and each time the sentence
    // that was here went with it, because the claim it made had stopped being true: the runtime's
    // said the state of a running engine was answered nowhere, and `agent_runtime_read` answers it.
    expect(gaps).toHaveLength(2)
    for (const gap of gaps) expect(gap.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    // The Skills row is *not* here, and the assertion is that the page replaced it rather than
    // that the sentence was deleted: a stale gap sentence would be a claim about a mount point
    // that exists.
    expect(gaps.some((gap) => gap.textContent?.includes('skills.rs'))).toBe(false)
    await untilDom(() => el('skill-row-demo') !== null, 'the skills page')
    expect(el('skills-project-scope')?.textContent).toContain('.opencode/skills')

    // Everything a mounted page draws itself is inside `agents-pages`; outside it, this file draws
    // only the engine switch. Navigation rows are owned by SettingsNavigation and are filtered
    // above, so a disabled control below would be a claim that the capability exists and is off.
    const own = [
      ...section().querySelectorAll<HTMLElement>(
        'input, button, select, textarea, [role="switch"]',
      ),
    ].filter((control) => (
      control.closest('[data-test="agents-pages"]') === null
      && !control.classList.contains('nav-row')
      && !control.classList.contains('settings-subnav-row')
    ))
    expect(own).toEqual([switchInput()])
  })
})
