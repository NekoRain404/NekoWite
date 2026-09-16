/**
 * The agents section, in the dialog it was added to: the navigation row, the one control that
 * reaches the shell, and the absences.
 *
 * T16's settings half is one page in the settings tree, and §12's acceptance is that the switch
 * on it can be rolled back. The two things this file is really here for, though, are the claims
 * that are about *not* doing something:
 *
 *  - **Nothing on the page reaches for a backend.** Nothing in a window can add, disable or
 *    remove an engine, the six other sections' clients have no implementation, and the
 *    negotiated half of the capability report is not joined to the declared half. So the page
 *    that would draw those controls must not call for them either — asserted by driving the page
 *    and finding that no `invoke` was made, which is the failure that would otherwise look
 *    exactly like a working page until it was clicked.
 *  - **The switch is the only control.** One `input`, and it is the switch: the gaps are text.
 *    A disabled switch or a greyed pill would be a claim that the capability exists and is
 *    temporarily off, which is the claim the registry and pet-integration pages refuse to make.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import SettingsPanel from './SettingsPanel.vue'
import { useSettingsStore } from '../../../stores/settings'
import { setLocale } from '../../../i18n'

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const getVersionMock = vi.hoisted(() => vi.fn(async () => '9.9.9'))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: getVersionMock }))

let mounted: VueApp[] = []

beforeEach(() => {
  invokeMock.mockClear()
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

async function openAgents(): Promise<void> {
  mountPanel()
  await nextTick()
  const row = [...document.querySelectorAll<HTMLElement>('.nav-row')].find((candidate) =>
    candidate.textContent?.includes('Agents'),
  )
  if (!row) throw new Error('the agents row is not in the settings navigation')
  row.click()
  await untilDom(() => document.querySelector('[data-agent-panel-switch]') !== null, 'the section')
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

  it('draws one control, and it is the rail switch', async () => {
    await openAgents()
    const controls = section().querySelectorAll('input, button, select, textarea, [role="switch"]')
    expect(controls).toHaveLength(1)
    expect(controls[0]).toBe(switchInput())
  })

  it('states the four gaps as text, and asks no backend for any of them', async () => {
    await openAgents()
    const gaps = [...section().querySelectorAll<HTMLElement>('.agent-gap')]
    expect(gaps).toHaveLength(4)
    for (const gap of gaps) expect(gap.textContent?.trim().length ?? 0).toBeGreaterThan(0)

    // The load-bearing half: opening the page made no IPC call, so there is no client here
    // pretending a command the backend does not have. (`agent_start` and friends are reached
    // from the rail, never from a settings page.)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('is off by default, so a dialog opened once changes nothing', async () => {
    await openAgents()
    const store = useSettingsStore()
    expect(store.agentPanel).toBe(false)
    expect(localStorage.getItem('nekowite.agent.panel')).toBeNull()
  })
})
