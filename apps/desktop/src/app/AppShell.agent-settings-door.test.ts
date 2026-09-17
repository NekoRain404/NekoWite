/**
 * The door from the agent panel to the agent settings, walked from the window rather than from
 * the component.
 *
 * Row 43 of the agent UI gap audit stood open for a long time and it was not a missing control:
 * [`SettingsOpenTarget`](../../features/settings/types.ts) had carried a section and a page since
 * the pet window's 设置 landed, `AppDialogs.vue` passed the target into `SettingsPanel.vue`, and
 * the dialog landed wherever it was told — so the whole path existed and had exactly one
 * producer, a right-click in a *different window*. From the agent panel, where an engine that is
 * configured wrongly is actually felt, there was nothing.
 *
 * That is this repository's signature failure with the two halves swapped: the machinery was
 * built and reachable, and the surface that needed it could not reach it. So the assertion here
 * is not that a row exists or that an event is emitted — `AgentPanel.menu.test.ts` owns those —
 * it is that a press inside the rail ends with **the real settings dialog on screen, showing the
 * agents tree**, with every hop in between being the application's own.
 *
 * The two lines a caller has to supply are `App.vue`'s, and they are written here because this
 * file mounts the shell rather than the root: `App.vue` owns `showSettings` as a plain ref and
 * answers `open-settings` by setting it. Everything below them — the rail, the panel, the menu,
 * the dialog, the section — is mounted as the application mounts it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import AppShell from './AppShell.vue'
import { useSettingsStore } from '../stores/settings'
import { createMemoryAgentGateway } from '../platform/gateways/memory-agent'
import { setLocale } from '../i18n'
import type { AgentComposition } from './agent-composition'

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const composeMock = vi.hoisted(() => vi.fn())
vi.mock('./agent-composition', () => ({ createAgentComposition: composeMock }))

function fakeComposition(): AgentComposition {
  const gateway = createMemoryAgentGateway({ agentId: 'opencode', profileId: 'default' })
  return {
    gateway,
    start: async () => {
      await gateway.start()
    },
    openSession: async (request) => {
      await gateway.start()
      return gateway.openSession(request)
    },
    stop: async () => {
      await gateway.stop()
    },
    connectSvgInsertion: () => {
      throw new Error('connectSvgInsertion is not part of this test')
    },
    registry: {
      read: () => {
        throw new Error('the registry is not part of this test')
      },
      add: () => {
        throw new Error('the registry is not part of this test')
      },
      setEnabled: () => {
        throw new Error('the registry is not part of this test')
      },
    },
  }
}

let pinia: Pinia
let mounted: VueApp[] = []

async function untilDom(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (predicate()) return
    await Promise.resolve()
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`the window never reached: ${label}`)
}

/**
 * The window, with `App.vue`'s own two lines: the shell is handed `showSettings` and answers the
 * event that flips it. Without the second, this file would be testing a prop rather than a path.
 */
function shell(): void {
  const state = reactive({
    sidebarVisible: true,
    vaultPath: '/notes/vault',
    railOpen: true,
    showSettings: false,
    activeTitle: 'Note',
    activeSubtitle: '/notes',
    conflict: null,
    pluginPermission: null,
    pluginIntegrity: null,
    aiWrite: null,
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () =>
      h(AppShell, {
        ...state,
        onOpenSettings: () => {
          state.showSettings = true
        },
        onCloseSettings: () => {
          state.showSettings = false
        },
      }),
  })
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
}

const panel = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-agent-panel]')
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('.settings-dialog')
const agentsPages = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-test="agents-pages"]')
const agentSwitch = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-agent-panel-switch]')

async function press(selector: string): Promise<void> {
  const target = document.querySelector<HTMLElement>(selector)
  if (target === null) throw new Error(`nothing matches ${selector}`)
  target.click()
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  composeMock.mockReset()
  composeMock.mockReturnValue(fakeComposition())
  localStorage.clear()
  setLocale('en')
  pinia = createPinia()
  setActivePinia(pinia)
  useSettingsStore().agentPanel = true
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

describe('the agent panel’s door to the agent settings', () => {
  it('lands the real dialog on the agents tree, from a press inside the rail', async () => {
    shell()
    await untilDom(() => panel() !== null, 'the agent panel')
    expect(dialog()).toBeNull()

    // Hop one: the options control in the session bar, which the panel draws because the rail
    // behind it can carry the rows.
    await press('[data-agent-menu]')
    await untilDom(
      () => document.querySelector('[data-agent-menu-row="settings"]') !== null,
      'the options menu',
    )

    // Hop two: the row. Everything after this is the application's own path — the panel emits,
    // the rail forwards, the shell names the section, `App.vue` opens the dialog, and the dialog
    // reads its landing place on mount.
    await press('[data-agent-menu-row="settings"]')

    await untilDom(() => dialog() !== null, 'the settings dialog')
    await untilDom(() => agentsPages() !== null, 'the agents tree')

    // Not merely "a dialog opened": it opened on the agents section, which is the whole of what
    // the row promises. The rail's own switch is on this page, and General settings is not.
    expect(agentSwitch()).not.toBeNull()
    expect(document.querySelector('[data-test="agents-profile"]')).not.toBeNull()
    // The menu is not left standing over the dialog that replaced it. It leaves a frame after the
    // dialog arrives — the popup's own `<Transition>` — so this is waited on rather than read in
    // the frame the dialog appeared in.
    await untilDom(
      () => document.querySelector('[data-agent-menu-row="settings"]') === null,
      'the menu to go with the dialog',
    )
  })

  it('hands the same dialog back to the rail switch when the panel asks for the chat panel', async () => {
    // The other row, and the reason it is on this surface: the rail offers this way out from its
    // refused state and the live panel had no equivalent. It is a store write, so the assertion
    // is about the rail's body rather than about the control that asked.
    shell()
    await untilDom(() => panel() !== null, 'the agent panel')
    expect(document.querySelector('.chat-panel')).toBeNull()

    await press('[data-agent-menu]')
    await press('[data-agent-menu-row="chat"]')

    await untilDom(
      () => document.querySelector('.chat-panel') !== null,
      'the chat panel back in the rail',
    )
    // The two bodies cross over inside `InfoRail`'s `<Transition>`: the chat panel is *entering*
    // while the agent panel is still leaving, so "the panel is gone" is waited on rather than
    // read in the frame the chat appeared in.
    await untilDom(() => panel() === null, 'the agent panel to leave the rail')
    expect(dialog()).toBeNull()
  })
})
