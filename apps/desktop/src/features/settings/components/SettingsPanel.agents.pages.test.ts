/**
 * Which pages the section has, over which commands — the set of mounted pages, the rail that reaches
 * them, and the one-page-at-a-time swap.
 *
 * The section is split by behaviour domain across sibling `SettingsPanel.agents.*.test.ts` files;
 * this one is the membership and the order: a rail row per mounted page in the tree's order, a page
 * per row drawn off the same list, and exactly one of them drawn at a time — with the rest kept in
 * the tree so a half-written form survives the glance. It is also the file that closes the section's
 * command surface: the pages that open ask for an exact set of commands, so a page that starts
 * calling something nobody registered fails here rather than in a user's face.
 */
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import {
  asked,
  el,
  openAgents,
  railRows,
  section,
  startAgentPanelAgents,
  untilDom,
} from './SettingsPanel.agents.mount'

// The mock `vi.mock` hoists above this file's imports; the harness installs it and answers through it.
const invokeMock = vi.hoisted(() => vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

startAgentPanelAgents(invokeMock)

describe('the agents section in the settings dialog', () => {
  it('mounts the pages whose host half exists, over the window’s own commands', async () => {
    await openAgents()
    await untilDom(() => el('provider-identity') !== null, 'the profile page')

    // The registry page: the bundled engine, with the facts its own page draws.
    expect(el('registry-row-bundled-engine')?.textContent).toContain('/opt/nekowite/engine')
    // The profile page, and the pair it was given — the registry's own answer, not a constant here.
    expect(el('provider-identity')?.textContent).toContain('bundled-engine')
    expect(el('provider-identity')?.textContent).toContain('default')
    expect(el('provider-credential-ANTHROPIC_API_KEY')).not.toBeNull()
    // And the permission page, mounted on the same pair: its rules readout is drawn, and its
    // grants half drew the backend's own "no engine is running" rather than an empty list.
    expect(el('permission-state')?.textContent).toContain('asks before it changes your files')
    expect(el('grants-not-running')).not.toBeNull()
    expect(el('grants-empty')).toBeNull()
    // The engine's own configuration: the document's text, drawn as the engine wrote it, with a
    // form over one member. Both facts are the backend's — the path came off the profile readout
    // and the text off the document read — so a page that spelled either itself fails here.
    await untilDom(() => el('config-text') !== null, 'the configuration document')
    expect(el('config-text')?.textContent).toContain('"permission"')
    expect(el('config-location')?.textContent).toContain('opencode.json')
    expect(el('config-edit')).not.toBeNull()
    // And the catalogue, which had no mount point at all before this: it reads, and it draws the
    // registry's own version rather than an empty section.
    await untilDom(() => el('catalogue-freshness') !== null, 'the catalogue')
    expect(section().contains(el('catalogue-freshness'))).toBe(true)
    // And the skills page (§8.2), which had no command behind it until this landed: it reads the
    // profile's own directories and draws the row the backend answered with — inside the section,
    // not beside it.
    await untilDom(() => el('skill-row-demo') !== null, 'the skills page')
    expect(section().contains(el('skill-row-demo'))).toBe(true)
    // The directory this launch stopped the engine reading says so, in the engine's own variable,
    // rather than reporting that it found nothing.
    expect(el('skill-scope-unread-claude-code')?.textContent).toContain(
      'OPENCODE_DISABLE_EXTERNAL_SKILLS',
    )

    // And the runtime page, §3.1.4's, which is the one mounted page that reads a live fact: the
    // protocol version and the capability rows come off the running incarnation's handshake, so
    // what is asserted below is that the backend's numbers reached the screen rather than that a
    // section rendered. Every one of them is the fixture's.
    await untilDom(() => el('runtime-protocol') !== null, 'the runtime page')
    expect(el('runtime-protocol')?.textContent).toContain('1')
    expect(el('runtime-engine-report')?.textContent).toContain('OpenCode')
    expect(el('runtime-engine-report')?.textContent).toContain('1.18.29')
    // The engine's advertised authentication, drawn as a report with the sentence saying this app
    // does not act on it — and no control anywhere in it, which is what keeps a list of ways to log
    // in from reading as a login this app can perform.
    expect(el('runtime-auth-methods')?.textContent).toContain('Sign in to OpenCode')
    expect(el('runtime-auth-not-acted-on')).not.toBeNull()
    expect(el('runtime-auth-methods')?.querySelector('button')).toBeNull()
    // Two capability rows from this fixture, one answered and one not measured — with the runtime's
    // own reason on the second, because "not measured" without a reason reads as "no".
    const listed = el('runtime-capability-session-list')
    expect(listed?.querySelector('[data-standing="advertised"]')).not.toBeNull()
    const unmeasured = el('runtime-capability-model-selection')
    expect(unmeasured?.querySelector('[data-standing="unverified"]')).not.toBeNull()
    expect(unmeasured?.textContent).toContain('no session response has been read')
    // Both halves of the report reach this screen, and the comparison between them is what is
    // asserted here rather than either field: the file and the runtime agree about `session-list`
    // and disagree about `model-selection` (on file as advertised, nothing measured here), so a
    // page that drew the file under every row or under none of them fails one of these two.
    expect(listed?.querySelector('[data-declaration]')).toBeNull()
    expect(unmeasured?.querySelector('[data-declaration]')?.textContent).toContain(
      'on file as advertising this feature',
    )
    // The handshake was read, so the page draws the negotiation and *not* the sentence standing in
    // for its absence: the two are different states and a page showing both would be lying twice.
    expect(el('runtime-not-negotiated')).toBeNull()

    // The exact set, so a page that starts asking for a command nobody registered fails here.
    expect([...new Set(asked)].sort()).toEqual([
      'agent_catalogue_read',
      'agent_config_document',
      'agent_permission_grants',
      'agent_profile_read',
      'agent_registry_read',
      'agent_runtime_read',
      'agent_skills_read',
    ])
  })

  it('draws a row per mounted page and a page per row, in the tree’s order', async () => {
    await openAgents()
    await untilDom(() => el('skill-row-demo') !== null, 'the pages behind the registry read')
    // Order and membership both come from `AGENT_SETTINGS_SECTIONS`, so a page added to the tree and
    // mounted appears below unedited. The two lists are compared *in order*, off two loops that
    // render independently, because either direction alone can hold while the other is broken: a row
    // with no page is §5.2's forbidden control, a page with no row is one nobody can reach.
    const rows = railRows().map((row) => row.dataset.page)
    expect(rows).toEqual(['runtime', 'provider', 'configuration', 'skills', 'permission', 'registry', 'catalogue'])
    expect(
      [...section().querySelectorAll<HTMLElement>('[data-test="agents-pages"] > [data-page]')].map(
        (page) => page.dataset.page,
      ),
    ).toEqual(rows)
    for (const absent of ['commands', 'mcp']) expect(rows).not.toContain(absent)
    for (const row of railRows()) expect(row.getAttribute('role')).toBe('tab')
  })

  it('shows one page at a time, and keeps the other six mounted', async () => {
    await openAgents()
    await untilDom(() => el('skill-row-demo') !== null, 'the pages behind the registry read')
    const pages = [...section().querySelectorAll<HTMLElement>('[data-test="agents-pages"] > [data-page]')]
    expect(pages).toHaveLength(7)
    // Exactly one drawn. `display` is what `v-show` writes and the whole of what switching does:
    // the pages stay in the tree so a half-written form survives a glance at another tab, and so
    // the catalogue's hand-off to the registry's add form still lands.
    expect(pages.filter((page) => page.style.display !== 'none')).toHaveLength(1)
    const selected = railRows().find((row) => row.getAttribute('aria-selected') === 'true')
    expect(selected?.dataset.page).toBe('runtime')

    railRows().find((row) => row.dataset.page === 'catalogue')?.click()
    await nextTick()
    // Both halves moved together, read off two elements rather than off one variable.
    const drawnNow = pages.filter((page) => page.style.display !== 'none')
    expect(drawnNow).toHaveLength(1)
    expect(railRows().find((row) => row.getAttribute('aria-selected') === 'true')?.dataset.page).toBe('catalogue')
    expect(drawnNow[0].contains(el('catalogue-freshness'))).toBe(true)
  })
})
