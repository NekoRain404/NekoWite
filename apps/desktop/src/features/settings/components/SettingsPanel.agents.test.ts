/**
 * The agents section, in the dialog it was added to: the navigation row, the switch, the two pages
 * whose host half this build really has, and the absences.
 *
 * T16's settings half is one page in the settings tree, and §12's acceptance is that the switch on
 * it can be rolled back. What this file is really here for, though, is the boundary — which pages
 * are mounted, and which are only described:
 *
 *  - **The two pages with a backend are mounted, over the window's own commands.** The registry
 *    (`agent_registry_read` / `_add` / `_set_enabled`) and the profile (`agent_profile_read` /
 *    `_write`) are registered in `R/src/lib.rs`, so the section mounts both and the test drives
 *    them through a mocked IPC layer — the same shape `SettingsPanel.pet.test.ts` uses. The
 *    commands asked for on open are asserted as an exact set, so a page that starts calling
 *    something nobody backs fails here rather than in a user's face.
 *  - **The pages with no backend are stated, not drawn.** Runtime, commands, MCP and permission
 *    have no client in this build, and Skills has a library with no command in front of it. The
 *    gaps are text: a list item, and no control of this page's own but the switch.
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
    sources: [{ kind: 'injected', variable: 'OPENCODE_CONFIG_DIR', path: '/tmp/profile' }],
    credentials: [{ name: 'ANTHROPIC_API_KEY', value: '<redacted>' }],
    credentialStorage: { kind: 'none' },
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

  it('mounts the two pages whose host half exists, over the window’s own commands', async () => {
    await openAgents()
    await untilDom(() => el('provider-identity') !== null, 'the profile page')

    // The registry page: the bundled engine, with the facts its own page draws.
    expect(el('registry-row-bundled-engine')?.textContent).toContain('/opt/nekowite/engine')
    // The profile page, and the pair it was given — the registry's own answer, not a constant here.
    expect(el('provider-identity')?.textContent).toContain('bundled-engine')
    expect(el('provider-identity')?.textContent).toContain('default')
    expect(el('provider-credential-ANTHROPIC_API_KEY')).not.toBeNull()

    // The exact set, so a page that starts asking for a command nobody registered fails here.
    expect([...new Set(asked)].sort()).toEqual(['agent_profile_read', 'agent_registry_read'])
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

  it('states the absences as text, one per section it does not mount, and draws nothing else', async () => {
    await openAgents()
    const gaps = [...section().querySelectorAll<HTMLElement>('.agent-gap')]
    // Five sections without a client, plus the two rows that are not sections: the capability
    // join and the engine switch. Derived from `AGENT_SETTINGS_SECTIONS` in the section, so this
    // count moves when a page is mounted — or when one is added to the tree.
    expect(gaps).toHaveLength(5 + 2)
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
