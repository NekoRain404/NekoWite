/**
 * The agents section, in the dialog it was added to: the navigation row, the switch, the pages
 * whose host half this build really has, and the absences.
 *
 * T16's settings half is one page in the settings tree, and §12's acceptance is that the switch on
 * it can be rolled back. What this file is really here for, though, is the boundary — which pages
 * are mounted, and which are only described:
 *
 *  - **Every page with a backend is mounted, over the window's own commands.** The registry
 *    (`agent_registry_read` / `_add` / `_set_enabled`), the profile (`agent_profile_read` /
 *    `_write`) and the permission page (`agent_profile_read` for the rules, plus
 *    `agent_permission_grants` / `_grant_revoke` for the grants the engine has written down) are
 *    registered in `R/src/lib.rs`, so the section mounts all three and the test drives them
 *    through a mocked IPC layer — the same shape `SettingsPanel.pet.test.ts` uses. The commands
 *    asked for on open are asserted as an exact set, so a page that starts calling something
 *    nobody backs fails here rather than in a user's face.
 *  - **The pages with no backend are stated, not drawn.** Runtime, commands and MCP have no client
 *    in this build, and Skills has a library with no command in front of it. The gaps are text: a
 *    list item, and no control of this page's own but the switch.
 *  - **The engine switch is not offered where nothing can carry it out.** The dialog has no gateway
 *    and `agent_start` takes a folder and nothing else, so the registry page is told
 *    `can-start-session="false"` and draws no select and no button.
 *  - **A save is at the revision the form read, and the next one is not.** The write advances the
 *    record's revision, so the page re-reads after it: without that, the second save would go out
 *    at a revision the backend has already moved past and come back as a conflict nobody caused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import SettingsPanel from './SettingsPanel.vue'
import { useSettingsStore } from '../../../stores/settings'
import { setLocale } from '../../../i18n'

/** The registry's answer, as `agent_registry_read` serializes it (`commands/agent_registry.rs`). */
function registryReadout(): unknown {
  return {
    defaultAgentId: 'bundled-engine',
    entries: [
      {
        agentId: 'bundled-engine',
        displayName: 'Bundled Engine',
        source: 'bundled',
        program: '/opt/nekowite/engine',
        args: ['acp'],
        env: 'profile-isolated',
        envExtra: [],
        enabled: true,
        adapterId: 'opencode',
        reportedVersion: null,
        programState: 'launchable',
      },
    ],
    adapterIds: ['opencode'],
    runningAgentIds: [],
    profileOwners: { default: 'bundled-engine' },
  }
}

/** The profile's answer, as `agent_profile_read` serializes it (`commands/agent_settings.rs`). */
function profileReadout(revision: string): unknown {
  return {
    profileId: 'default',
    agentId: 'bundled-engine',
    mode: 'app-managed',
    root: '/home/someone/.local/share/nekowite/agent-profiles/default',
    revision,
    provider: 'iapp',
    modelId: 'iapp/deepseek-v4-flash',
    editable: true,
    // The injected roots, then one row per merge this app does not close — the shape
    // `profile.rs`'s `sources()` answers an app-managed profile with, written out by hand.
    sources: [
      { kind: 'injected', variable: 'OPENCODE_CONFIG_DIR', path: '/tmp/profile' },
      { kind: 'engine-discovery', what: 'project' },
      { kind: 'engine-discovery', what: 'managed' },
    ],
    credentials: [{ name: 'ANTHROPIC_API_KEY', value: '<redacted>' }],
    credentialStorage: { kind: 'none' },
    // The consent default, as `profile_view` answers it: `written` for an app-managed profile,
    // because that is the mode this host writes the engine's configuration in.
    permissions: {
      state: 'written',
      document: '/tmp/profile/XDG_CONFIG_HOME/opencode/opencode.json',
      rules: [
        { tool: 'edit', action: 'ask' },
        { tool: 'bash', action: 'ask' },
      ],
    },
    // The relative path of the same file, which is what `agent_config_document` takes. An
    // app-managed profile is the mode where this host owns the document, so it is present here;
    // `null` is the arm the document editor draws as a sentence instead of a form.
    configDocument: 'XDG_CONFIG_HOME/opencode/opencode.json',
  }
}

/**
 * The document's answer, as `agent_config_document` serializes it (`commands/agent_settings.rs`).
 *
 * The text is the engine's own file, comments and all — that is the point of showing it, and the
 * reason this fixture is not a parsed object.
 */
function documentReadout(revision: string): unknown {
  return {
    path: '/tmp/profile/XDG_CONFIG_HOME/opencode/opencode.json',
    exists: true,
    revision,
    text: '{\n  // the engine’s own file\n  "permission": { "edit": "ask" }\n}\n',
    editable: true,
  }
}

/**
 * The catalogue's answer, as `agent_catalogue_read` serializes it (`commands/agent_catalogue.rs`).
 *
 * One row, and it is the arm `catalogueAction` draws a control for: `via-package-manager` with
 * `offerable: true`. Rows that are `archive-only`, `unsupported` or `unrecognised` draw no control
 * at all, so they would prove nothing about the one wire this test is for — the click that hands an
 * entry to the registry's add form.
 */
function catalogueReadout(): unknown {
  return {
    registryVersion: '1.0.0',
    freshness: 'current',
    note: null,
    rows: [
      {
        id: 'acme-agent',
        name: 'Acme Agent',
        version: '2.1.0',
        description: 'An agent that publishes itself to the registry.',
        repository: null,
        website: null,
        authors: [],
        license: null,
        licenseUrl: null,
        iconUrl: null,
        standing: {
          kind: 'via-package-manager',
          manager: 'npx',
          package: 'acme-agent@2.1.0',
          program: 'npx',
          args: ['-y', 'acme-agent@2.1.0'],
          pinnedVersion: '2.1.0',
        },
        defects: [],
        offerable: true,
      },
    ],
    offerable: 1,
    installGates: [
      { check: 'digest', transfers: false },
      { check: 'architecture', transfers: true },
    ],
  }
}

/** Every command the window asked for, in the order it asked. */
const asked: string[] = []
/** The record's revision, as the backend would advance it: a write is what moves it. */
let revision = 'r1'
/** Commands this build answers by refusing, for the failure case. */
let refusing = new Set<string>()

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const getVersionMock = vi.hoisted(() => vi.fn(async () => '9.9.9'))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: getVersionMock }))

let mounted: VueApp[] = []

beforeEach(() => {
  asked.length = 0
  revision = 'r1'
  refusing = new Set()
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    asked.push(command)
    if (refusing.has(command)) throw new Error(`${command} is not answering in this test`)
    switch (command) {
      case 'agent_registry_read':
        return registryReadout()
      case 'agent_profile_read':
        return profileReadout(revision)
      case 'agent_permission_grants':
        // No engine in this test, which is the state the grants page draws as its own sentence.
        return { kind: 'not-running' }
      case 'agent_config_document':
        return documentReadout(revision)
      case 'agent_catalogue_read':
        return catalogueReadout()
      case 'agent_profile_write': {
        // The backend's own behaviour, in three lines: the write is applied at the revision the
        // form read, and applying it moves the revision — which is what makes a stale form's next
        // write arrive as a conflict.
        const write = args as { revision: string }
        if (write.revision !== revision) {
          return { status: 'conflict', current: profileReadout(revision) }
        }
        revision = revision === 'r1' ? 'r2' : 'r3'
        return { status: 'written', revision }
      }
      default:
        return undefined
    }
  })
  getVersionMock.mockClear()
  localStorage.clear()
  setLocale('en')
  setActivePinia(createPinia())
  globalThis.matchMedia = vi.fn(() => ({
    matches: false,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as never
  document.body.innerHTML = ''
  mounted = []
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

function mountPanel(): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  // No `app.use(pinia)`: the panel's own sections reach the store through `setActivePinia`,
  // which is this file's too, so the store the test reads is the store the page wrote.
  const app = createApp(SettingsPanel, { onClose: vi.fn(), onSaved: vi.fn() } as never)
  app.mount(host)
  mounted.push(app)
}

/** Wait for a moment in the dialog's life that is a frame rather than a tick: the section swap
 *  is a cross-fade, and the page that is leaving is still in the document for its whole leave. */
async function untilDom(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (predicate()) return
    await Promise.resolve()
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`the dialog never reached: ${label}`)
}

/**
 * The agents section's own box: the one that owns the switch.
 *
 * Found through the switch rather than as "the first `.settings-section`", because during the
 * swap there are two — the page leaving is out of flow and `inert` but still matched — and a
 * count of the controls on the wrong one is a test that passes about a page nobody opened.
 */
function section(): HTMLElement {
  const input = switchInput()
  const found = input.closest<HTMLElement>('.settings-section')
  if (!found) throw new Error('the rail switch is not inside a section')
  return found
}

function switchInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('[data-agent-panel-switch]')
  if (!input) throw new Error('the rail switch is not on the page')
  return input
}

function el(dataTest: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-test="${dataTest}"]`)
}

async function openAgents(): Promise<void> {
  mountPanel()
  await nextTick()
  const row = [...document.querySelectorAll<HTMLElement>('.nav-row')].find((candidate) =>
    candidate.textContent?.includes('Agents'),
  )
  if (!row) throw new Error('the agents row is not in the settings navigation')
  row.click()
  await untilDom(() => el('agents-profile') !== null, 'the section')
  // And then the page it replaced: the leaving one is still in the document, and every count
  // below would otherwise include its controls.
  await untilDom(
    () => document.querySelectorAll('.dialog-content > .page-leave-active').length === 0,
    'the previous page to leave',
  )
}

function flip(input: HTMLInputElement, checked: boolean): void {
  input.checked = checked
  input.dispatchEvent(new Event('change'))
}

describe('the agents section in the settings dialog', () => {
  it('is offered by the navigation, and opens on its own switch', async () => {
    await openAgents()
    expect(switchInput()).toBeTruthy()
    expect(switchInput().checked).toBe(false)
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

    // The exact set, so a page that starts asking for a command nobody registered fails here.
    expect([...new Set(asked)].sort()).toEqual([
      'agent_catalogue_read',
      'agent_config_document',
      'agent_permission_grants',
      'agent_profile_read',
      'agent_registry_read',
    ])
  })

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

  it('hands a catalogue entry to the registry’s add form, rather than emitting to nobody', async () => {
    await openAgents()
    await untilDom(() => el('catalogue-use-acme-agent') !== null, 'the catalogue’s control')

    // The catalogue's only control means "register this one", and it holds no `add` of its own. The
    // two assertions below are the difference between a wired control and a button that emits into
    // an empty room: the entry's program and its arguments are in the *form the registry submits*,
    // as an array joined one argument per line (§3.4.3 — never a command line).
    el('catalogue-use-acme-agent')?.dispatchEvent(new MouseEvent('click'))
    await nextTick()
    await nextTick()

    const program = document.querySelector<HTMLInputElement>('[data-test="registry-field-program"]')
    const args = document.querySelector<HTMLTextAreaElement>('[data-test="registry-field-args"]')
    expect(program?.value).toBe('npx')
    expect(args?.value).toBe('-y\nacme-agent@2.1.0')
    expect(document.querySelector<HTMLInputElement>('[data-test="registry-field-agentId"]')?.value).toBe(
      'acme-agent',
    )
  })

  it('states the absences as text, one per section it does not mount, and draws nothing else', async () => {
    await openAgents()
    const gaps = [...section().querySelectorAll<HTMLElement>('.agent-gap')]
    // Four sections without a client, plus the two rows that are not sections: the capability
    // join and the engine switch. Derived from `AGENT_SETTINGS_SECTIONS` in the section, so this
    // count moves when a page is mounted — or when one is added to the tree.
    expect(gaps).toHaveLength(4 + 2)
    for (const gap of gaps) expect(gap.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    // The Skills row names the missing half, and it names it from the catalogue: a key that moved
    // would print the key itself here.
    expect(gaps.some((gap) => gap.textContent?.includes('skills.rs'))).toBe(true)

    // Everything a mounted page draws itself is inside `agents-pages`; outside it, this file
    // draws one control and it is the switch. A disabled control or a greyed pill below would be
    // a claim that the capability exists and is temporarily off.
    const own = [
      ...section().querySelectorAll<HTMLElement>(
        'input, button, select, textarea, [role="switch"]',
      ),
    ].filter((control) => control.closest('[data-test="agents-pages"]') === null)
    expect(own).toEqual([switchInput()])
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

  it('is off by default, so a dialog opened once changes nothing', async () => {
    await openAgents()
    const store = useSettingsStore()
    expect(store.agentPanel).toBe(false)
    expect(localStorage.getItem('nekowite.agent.panel')).toBeNull()
  })
})
