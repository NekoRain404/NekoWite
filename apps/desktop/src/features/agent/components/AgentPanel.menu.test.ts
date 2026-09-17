/**
 * The panel's options menu: the one place in the panel from which the agent-related actions that
 * live outside it are reached.
 *
 * It exists because the panel had none. `AgentPanel.vue` declared a single emit (`resume`) and
 * then two, and neither was a door out of the panel: a reader whose engine was configured wrongly
 * had to already know that a settings dialog existed and that the agents tree was inside it. Zed
 * reaches the same ground from the panel's own options menu
 * (`zed-main/crates/agent_ui/src/agent_panel.rs:5580` `render_panel_options_menu`, whose rows are
 * `ManageProfiles` at `:5790` and `OpenSettings` at `:5796`), and this is the port of that shape.
 *
 * Three rules, and each is a specific mistake:
 *
 *  - **A row that cannot act is not drawn.** The panel is mounted with whatever its caller can
 *    carry (`settingsOpenable`, `chatOpenable` — the same rule `openable` already states for the
 *    history entry), and a panel whose caller can carry neither has no options control at all
 *    rather than one that opens an empty box.
 *  - **The menu is the panel's, the trigger is the bar's.** `AgentSessionBar` draws the control
 *    and emits; the popup is here because the panel is what owns the events it produces — the
 *    same split the session history already uses.
 *  - **Choosing a row closes the menu and leaves as an event.** Nothing in this tree opens the
 *    settings dialog or switches the rail; both belong to the layers that own them, exactly as
 *    `resume` and `new-session` do.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import AgentPanel, { type AgentPanelLabels } from './AgentPanel.vue'
import {
  createMemoryAgentGateway,
  type MemoryAgentGateway,
} from '../../../platform/gateways/memory-agent'
import type { AgentSession } from '../../../platform/gateways/agent-contracts'
import { setLocale } from '../../../i18n'

/**
 * The copy the caller supplies. Written out rather than imported from `AgentPanel.test.ts`,
 * which is a test file: importing one would run its suite a second time inside this one.
 */
const LABELS: AgentPanelLabels = {
  empty: { line: 'Message Memory — / for commands' },
  bar: {
    untitled: 'New Memory session',
    state: {
      idle: 'Idle',
      starting: 'Starting',
      ready: 'Ready',
      running: 'Running',
      'waiting-permission': 'Waiting for approval',
      completed: 'Completed',
      cancelled: 'Stopped',
      failed: 'Failed',
    },
    result: {
      'end-turn': 'Finished',
      'max-tokens': 'Token limit',
      'max-turn-requests': 'Request limit',
      refusal: 'Refused',
      cancelled: 'Stopped',
      unrecognised: 'Unrecognised ending',
    },
  },
  timeline: {
    aria: 'Agent transcript',
    you: 'You',
    attached: 'Files attached to this message',
    thoughtOpen: 'Hide reasoning',
    thoughtClosed: 'Reasoning',
    controls: {
      jump: 'New content',
      follow: 'Follow the newest output',
      followStop: 'Stop following the newest output',
      copy: 'Copy the newest answer',
      copied: 'Copied',
      copyFailed: 'The clipboard refused it',
      toUser: 'Go to your last message',
      toTop: 'Go to the beginning',
    },
    tool: {
      status: {
        pending: 'Queued',
        in_progress: 'Running',
        completed: 'Done',
        failed: 'Failed',
        cancelled: 'Stopped',
      },
      expand: 'Show arguments and output',
      collapse: 'Hide arguments and output',
      args: 'Arguments',
      output: 'Output',
      argsAbsent: 'The engine sent no arguments',
      argsUnreadable: 'The engine sent arguments this app could not read',
      outputAbsent: 'No output reported',
      outputUnreadable: 'The engine sent output this app could not read',
    },
  },
  composer: {
    placeholder: 'Ask the agent',
    send: 'Send',
    stop: 'Stop',
    hint: 'Enter sends, Shift+Enter starts a new line',
    hintBusy: 'A run is in flight — the text waits here',
  },
  notice: {
    gap: 'Part of this session’s record was never received',
    resync: 'Resync',
  },
  menu: {
    label: 'Agent options',
    settings: 'Agent settings',
    chat: 'Use the chat panel',
  },
}

interface Harness {
  el: (selector: string) => HTMLElement | null
  click: (selector: string) => Promise<void>
  /** Every event the panel emitted, in order. */
  emitted: string[]
}

let pinia: Pinia
let gateway: MemoryAgentGateway
let session: AgentSession
let mounted: VueApp[] = []

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(async () => {
  setLocale('en')
  pinia = createPinia()
  setActivePinia(pinia)
  gateway = createMemoryAgentGateway({ agentId: 'memory', profileId: 'test' })
  await gateway.start()
  session = await gateway.openSession({ vaultId: 'vault', cwd: '/vault' })
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

async function mountPanel(carries: { settings?: boolean; chat?: boolean }): Promise<Harness> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const emitted: string[] = []
  const app = createApp(AgentPanel, {
    gateway,
    session,
    cwd: '/vault',
    labels: LABELS,
    settingsOpenable: carries.settings === true,
    chatOpenable: carries.chat === true,
    onOpenSettings: () => emitted.push('open-settings'),
    onUseChat: () => emitted.push('use-chat'),
  })
  app.use(pinia)
  app.mount(host)
  mounted.push(app)

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i += 1) {
      await nextTick()
      await flush()
    }
  }
  await settle()

  // Read off the document rather than off `host`: the popup is teleported to the body, so the
  // rows are not inside the panel's own subtree once the menu is up.
  return {
    emitted,
    el: (selector) => document.querySelector<HTMLElement>(selector),
    click: async (selector) => {
      const target = document.querySelector<HTMLElement>(selector)
      if (target === null) throw new Error(`nothing matches ${selector}`)
      target.click()
      await settle()
    },
  }
}

/** The popup is teleported to the body: the panel's own subtree does not contain it. */
const popup = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-agent-menu-popup]')
const row = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-agent-menu-row="${id}"]`)

describe('AgentPanel — the options menu', () => {
  it('offers the settings row and leaves opening the dialog to its caller', async () => {
    const harness = await mountPanel({ settings: true })

    // The control is in the bar, and the popup is not up until it is pressed.
    expect(harness.el('[data-agent-menu]')).not.toBeNull()
    expect(popup()).toBeNull()

    await harness.click('[data-agent-menu]')

    expect(popup()).not.toBeNull()
    const settings = row('settings')
    expect(settings).not.toBeNull()
    expect(settings?.getAttribute('role')).toBe('menuitem')

    settings?.click()
    await flush()
    await nextTick()
    await flush()

    // The event is the whole of what the panel does about settings: the dialog is the shell's.
    expect(harness.emitted).toEqual(['open-settings'])
    // And the menu is gone — a row that acted but left its list standing reads as a press that
    // did nothing.
    expect(popup()).toBeNull()
  })

  it('leaves the rail switch to its caller as its own event', async () => {
    const harness = await mountPanel({ chat: true })

    await harness.click('[data-agent-menu]')

    const chat = row('chat')
    expect(chat).not.toBeNull()
    chat?.click()
    await flush()
    await nextTick()
    await flush()

    expect(harness.emitted).toEqual(['use-chat'])
  })

  it('draws no options control at all when the caller can carry neither row', async () => {
    // `AgentPanel.test.ts` mounts a panel over a gateway with no rail behind it. An options
    // control there would open a box of rows that emit to nobody — which is the defect every
    // `*Openable` prop on this component exists to prevent.
    const harness = await mountPanel({})

    expect(harness.el('[data-agent-menu]')).toBeNull()
    expect(popup()).toBeNull()
  })

  it('draws only the rows its caller can carry', async () => {
    const harness = await mountPanel({ settings: true })

    await harness.click('[data-agent-menu]')

    expect(row('settings')).not.toBeNull()
    expect(row('chat')).toBeNull()
  })

  it('draws no row that closes the menu without asking for something', async () => {
    // The panel's `chooseMenuRow` switches on the id, and a row added to the menu without a case
    // there would be the one control this project forbids by name: it closes the box and does
    // nothing. Written as a walk over whatever the menu draws rather than over the two ids known
    // today, so the next row is covered by this test the moment it is drawn — the assertion does
    // not need to know what it is called.
    const harness = await mountPanel({ settings: true, chat: true })
    await harness.click('[data-agent-menu]')
    const ids = [...document.querySelectorAll<HTMLElement>('[data-agent-menu-row]')].map(
      (element) => element.dataset.agentMenuRow ?? '',
    )
    expect(ids.sort()).toEqual(['chat', 'settings'])

    for (const id of ids) {
      const before = harness.emitted.length
      // Re-open for each row: picking one closes the menu, which is the behaviour asserted above.
      if (harness.el(`[data-agent-menu-row="${id}"]`) === null) {
        await harness.click('[data-agent-menu]')
      }
      await harness.click(`[data-agent-menu-row="${id}"]`)
      expect(harness.emitted.length, `the "${id}" row emitted nothing`).toBe(before + 1)
    }
    expect(harness.emitted.sort()).toEqual(['open-settings', 'use-chat'])
  })
})
