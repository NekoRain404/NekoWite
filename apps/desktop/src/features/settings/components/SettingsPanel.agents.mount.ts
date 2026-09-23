/**
 * The agents section's suite, stood up: the window, the section, and the backend answers the page
 * is asserted against.
 *
 * The section's behaviour is split across sibling `SettingsPanel.agents.*.test.ts` files — the
 * switch, the pages the host half really has, the live runtime read, the paths a mounted page does
 * not close, the absences, and the wire — and every one of them needs the same five things: a
 * mocked `invoke`, the dialog mounted and clicked through to the agents section, a way to wait for a
 * cross-fade, the section's own box, and the readouts the backend would answer with. This module is
 * that, and nothing else: it asserts nothing, so no test's claim lives here.
 *
 * What is *not* shared is the answers. `startAgentPanelAgents` installs the full set of readouts,
 * and a suite that needs a different arm — no handshake, a refusing registry — reaches for
 * `refusing` or replaces `invoke` after the call, the way the single file did.
 */
import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import SettingsPanel from './SettingsPanel.vue'
import { setLocale } from '../../../i18n'

/**
 * The mocked `invoke` a suite passes in, and the shape `vi.hoisted(() => vi.fn())` gives it.
 *
 * `vi.mock` is hoisted above the harness's own imports, so the mock has to be built by the calling
 * file and handed over here for installation. The procedure type is what keeps that file's typed
 * `vi.fn()` assignable to this, and `Mock` is what lets the harness answer through it.
 */
export type AgentPanelInvoke = Mock<(command: string, args?: Record<string, unknown>) => Promise<unknown>>

/** Every command the window asked for, in the order it asked. */
export const asked: string[] = []
/** The record's revision, as the backend would advance it: a write is what moves it. */
let revision = 'r1'
/** Commands this build answers by refusing, for the failure case. */
export let refusing = new Set<string>()

/** The registry's answer, as `agent_registry_read` serializes it (`commands/agent_registry.rs`). */
export function registryReadout(): unknown {
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

/**
 * The skills page's answer, as `agent_skills_read` serializes it (`commands/agent_skills.rs`).
 *
 * An app-managed profile: the scope list has the profile's own directory and the two another tool
 * owns — which this launch's `OPENCODE_DISABLE_EXTERNAL_SKILLS` stops the engine reading, so the
 * page has to say *that* rather than "no skills". A project's `.opencode/skills` is not in the list
 * at all, which is the fact the page states in words instead of drawing.
 */
function skillsReadout(): unknown {
  return {
    scopes: [
      {
        id: 'engine-global',
        label: "This app's profile, read by the engine",
        root: '/home/someone/.local/share/nekowite/agent-profiles/default/XDG_CONFIG_HOME/skills',
        suppressedBy: null,
      },
      {
        id: 'claude-code',
        label: "Another tool's directory (.claude)",
        root: '/home/someone/.local/share/nekowite/agent-profiles/default/HOME/.claude/skills',
        suppressedBy: 'OPENCODE_DISABLE_EXTERNAL_SKILLS',
      },
    ],
    skills: [
      {
        name: 'demo',
        description: 'A demo skill.',
        directory:
          '/home/someone/.local/share/nekowite/agent-profiles/default/XDG_CONFIG_HOME/skills/demo',
        scope: 'engine-global',
        scopeLabel: "This app's profile, read by the engine",
        owner: 'managed',
        conflicts: [],
        surface: { kind: 'offered' },
        suppressedBy: null,
        disable: { kind: 'per-skill' },
      },
    ],
    disabled: [],
    importScope: 'engine-global',
  }
}

/**
 * The runtime's answer, as `agent_runtime_read` serializes it (`commands/agent_runtime.rs`).
 *
 * The **read** arm, with a handshake: an engine this app has running and has negotiated with. Two of
 * the eleven capability rows are the three that need a *session response* — they are `unverified`
 * with the runtime's own reason, which is the honest arm for a page that has no session and the one
 * this fixture has to carry so the page is not being tested against a shape it will never see.
 */
export function runtimeReadout(): unknown {
  return {
    agentId: 'bundled-engine',
    displayName: 'Bundled Engine',
    source: 'bundled',
    program: '/opt/nekowite/engine',
    reportedVersion: null,
    adapterId: 'opencode',
    process: 'ready',
    updatePolicy: 'host-managed',
    handshake: {
      status: 'read',
      protocolVersion: 1,
      agentName: 'OpenCode',
      agentVersion: '1.18.29',
      authMethods: [{ id: 'opencode-login', name: 'Sign in to OpenCode' }],
    },
    capabilities: [
      {
        feature: 'session-list',
        declared: 'advertised',
        finding: { status: 'available' },
        host: { status: 'command', command: 'agent_list_sessions' },
      },
      {
        feature: 'model-selection',
        declared: 'advertised',
        finding: {
          status: 'unverified',
          detail: 'no session response has been read: the engine has not yet been asked what it offers here',
        },
        host: { status: 'command', command: 'agent_set_config_option' },
      },
    ],
  }
}

const getVersionMock = vi.hoisted(() => vi.fn(async () => '9.9.9'))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: getVersionMock }))

let mounted: VueApp[] = []

/**
 * Wire one suite's mocked `invoke` into the harness, and register the reset, the mount bookkeeping
 * and the answers below.
 *
 * Call it at the **module scope** of the suite, not from its `beforeEach`: a hook registered while
 * another hook is running is not part of the list vitest collected for that test, so a `beforeEach`
 * here would never run and every mount would fail on an inactive Pinia.
 */
export function startAgentPanelAgents(invoke: AgentPanelInvoke): void {
  beforeEach(() => {
    asked.length = 0
    revision = 'r1'
    refusing = new Set()
    invoke.mockReset()
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
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
        case 'agent_skills_read':
          return skillsReadout()
        case 'agent_catalogue_read':
          return catalogueReadout()
        case 'agent_runtime_read':
          return runtimeReadout()
        // The two calls the provider form makes, and the one it writes through. `ai_list_models` is
        // the same command the AI settings page's refresh button calls — it is here as that command,
        // with the shape the form builds for it, because "the same fetch serves both" is a claim
        // about the wire rather than about a function two pages happen to share.
        case 'ai_list_models':
          return ['deepseek-v4-flash', 'deepseek-v4.1-flash', 'glm-5.2']
        case 'agent_credentials_write':
          return profileReadout(revision)
        case 'agent_config_edit':
          return { status: 'written', revision: 'c'.repeat(64) }
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
}

function mountPanel(): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  // No `app.use(pinia)`: the panel's own sections reach the store through `setActivePinia`,
  // which is this harness's too, so the store the test reads is the store the page wrote.
  const app = createApp(SettingsPanel, { onClose: vi.fn(), onSaved: vi.fn() } as never)
  app.mount(host)
  mounted.push(app)
}

/** Wait for a moment in the dialog's life that is a frame rather than a tick: the section swap
 *  is a cross-fade, and the page that is leaving is still in the document for its whole leave. */
export async function untilDom(predicate: () => boolean, label: string): Promise<void> {
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
export function section(): HTMLElement {
  const input = switchInput()
  const found = input.closest<HTMLElement>('.settings-section')
  if (!found) throw new Error('the rail switch is not inside a section')
  return found
}

/** The sub-navigation's rows, in the order they are drawn. */
export function railRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.dialog-nav .agents-rail [role="tab"]')]
}

export function switchInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('[data-agent-panel-switch]')
  if (!input) throw new Error('the rail switch is not on the page')
  return input
}

export function el(dataTest: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-test="${dataTest}"]`)
}

/** Type into a field the way a user does: the value, then the event Vue's `v-model` listens for. */
export async function type(dataTest: string, value: string): Promise<void> {
  const field = document.querySelector<HTMLInputElement>(`[data-test="${dataTest}"]`)
  if (!field) throw new Error(`no field ${dataTest}`)
  field.value = value
  field.dispatchEvent(new Event('input'))
  await nextTick()
}

export async function openAgents(): Promise<void> {
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

export function flip(input: HTMLInputElement, checked: boolean): void {
  input.checked = checked
  input.dispatchEvent(new Event('change'))
}
