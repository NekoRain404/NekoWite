/**
 * The shell switch, as an assertion about the window rather than about the setting.
 *
 * §12's acceptance clause is 「新旧功能开关可回退」 and it is two claims: with the switch off the
 * window has to be the window it was before any of this existed, and with it on — or with the
 * engine refusing to start — there has to be a way back that does not look like a fault. Both
 * are claims about the mounted tree, so this file mounts the real `AppShell` and drives the real
 * switch through the store.
 *
 * The one thing stubbed is the composition: `agent-composition` is replaced so that "no engine
 * was asked for" is an assertion about a call that did not happen (`composeMock`) rather than
 * something inferred from an absence on screen. What the compositions return is a real memory
 * gateway, so the session the panel is handed is a real `AgentSession`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import AppShell from './AppShell.vue'
import { useSettingsStore } from '../stores/settings'
import { createMemoryAgentGateway } from '../platform/gateways/memory-agent'
import type { AgentComposition } from './agent-composition'
import type { AgentOpenRequest, AgentSession } from '../platform/gateways/agent-contracts'

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const composeMock = vi.hoisted(() => vi.fn())
vi.mock('./agent-composition', () => ({ createAgentComposition: composeMock }))

/** The sentence the backend answers with when the bundled engine was not carried by the build
 *  (T4b's `program_to_launch`), used verbatim because that is what the rail has to show. */
const NO_ENGINE = 'the bundled engine was not found beside /usr/bin/nekowite'

function fakeComposition(
  options: { refuseWith?: string; gateway?: ReturnType<typeof createMemoryAgentGateway> } = {},
) {
  const gateway = options.gateway ?? createMemoryAgentGateway({ agentId: 'opencode', profileId: 'default' })
  const stop = vi.fn(async () => {
    await gateway.stop()
  })
  const opened: AgentOpenRequest[] = []
  const composition: AgentComposition = {
    gateway,
    start: async () => {
      await gateway.start()
    },
    openSession: async (request: AgentOpenRequest): Promise<AgentSession> => {
      opened.push(request)
      await gateway.start()
      if (options.refuseWith !== undefined) throw options.refuseWith
      return gateway.openSession(request)
    },
    stop,
    // T11's insertion binding is on the interface; the rail never calls it, and a stand-in would
    // be a claim about a path this file does not exercise.
    connectSvgInsertion: () => {
      throw new Error('connectSvgInsertion is not part of this test')
    },
    // And so is T13a's registry client, for the same reason: the settings section that calls it is
    // mounted by the settings dialog, not by the rail.
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
  return { composition, stop, opened }
}

let pinia: Pinia
let mounted: VueApp[] = []

/**
 * Keep the microtask queue, the renderer and the timer queue moving until the predicate holds.
 *
 * The rail's start is a queue of promises plus a render, so a fixed number of ticks would be a
 * guess. The timer turn is the other half: a `<Transition>` ends on a frame, not on a microtask,
 * and the rail's two surfaces (the panel and the rail itself) both leave through one — an
 * assertion taken on `nextTick` alone observes them mid-leave and reads as "it never left".
 */
async function untilDom(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (predicate()) return
    await Promise.resolve()
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`the window never reached: ${label}`)
}

function shell(props: {
  vaultPath?: string | null
  railOpen?: boolean
}): { state: { railOpen: boolean; vaultPath: string | null } } {
  const state = reactive({
    sidebarVisible: true,
    // `undefined` means "the default folder"; `null` means "none is open", which is a state of
    // its own here — the agent works inside one folder.
    vaultPath: props.vaultPath === undefined ? '/notes/vault' : props.vaultPath,
    railOpen: props.railOpen === undefined ? true : props.railOpen,
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
  const app = createApp({ render: () => h(AppShell, { ...state }) })
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  return { state }
}

const panel = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-agent-panel]')
const chat = (): HTMLElement | null => document.querySelector<HTMLElement>('.chat-panel')
const railState = (kind: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-agent-rail="${kind}"]`)

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  composeMock.mockReset()
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
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

describe('the rail with the agent panel switched off', () => {
  it('is the chat panel, byte for byte, and no engine is asked for', () => {
    // The default, so this is also the assertion that an install which never touches the switch
    // gets the surface it has always had.
    shell({})
    expect(chat()).not.toBeNull()
    expect(panel()).toBeNull()
    expect(railState('refused')).toBeNull()
    // The load-bearing half: nothing was composed, so no process was started for a rail the
    // user did not ask to change.
    expect(composeMock).not.toHaveBeenCalled()
  })

  it('stays the chat panel when the switch is on but no folder is open', () => {
    const store = useSettingsStore()
    store.agentPanel = true
    shell({ vaultPath: null })
    // No vault, no runtime: the agent works inside one folder, and the rail says so rather than
    // starting an engine for a folder the user has not chosen.
    expect(panel()).toBeNull()
    expect(composeMock).not.toHaveBeenCalled()
    expect(railState('waiting')).not.toBeNull()
  })
})

describe('the rail with the agent panel switched on', () => {
  it('mounts the panel for the open folder, in place of the chat', async () => {
    const fake = fakeComposition()
    composeMock.mockReturnValue(fake.composition)
    const store = useSettingsStore()
    store.agentPanel = true

    shell({})
    await untilDom(() => panel() !== null, 'the agent panel')

    expect(composeMock).toHaveBeenCalledTimes(1)
    expect(composeMock.mock.calls[0][0]).toEqual({ vaultId: '/notes/vault' })
    // The session was opened for the folder the app has open, and the panel is the only thing in
    // the rail: two AI surfaces at once would be two subscriptions to one store record.
    expect(fake.opened).toEqual([{ vaultId: '/notes/vault', cwd: '/notes/vault' }])
    expect(chat()).toBeNull()
    expect(document.querySelector('.agent-panel')).not.toBeNull()
  })

  it('is not stopped by the rail closing, and is not re-opened by it opening', async () => {
    const fake = fakeComposition()
    composeMock.mockReturnValue(fake.composition)
    const store = useSettingsStore()
    store.agentPanel = true
    const { state } = shell({})
    await untilDom(() => panel() !== null, 'the agent panel')

    state.railOpen = false
    // The rail's exit is a transition (`appShell.css`), so the element is still in the tree for
    // the length of its leave — the assertion is that it goes, not that it vanishes in one frame.
    await untilDom(() => document.querySelector('.rail-body') === null, 'the rail to leave')
    // §5.1: 任务可以在面板收起后继续. The panel is unmounted (that is what releases its
    // subscription) and the runtime is untouched.
    expect(fake.stop).not.toHaveBeenCalled()

    state.railOpen = true
    await untilDom(() => panel() !== null, 'the panel after reopening')
    expect(composeMock).toHaveBeenCalledTimes(1)
    expect(fake.opened).toHaveLength(1)
    expect(fake.stop).not.toHaveBeenCalled()
  })

  it('replaces the runtime when the folder changes, under a new panel key', async () => {
    const gateway = createMemoryAgentGateway({ agentId: 'opencode', profileId: 'default' })
    const first = fakeComposition({ gateway })
    const second = fakeComposition({ gateway })
    composeMock.mockReturnValueOnce(first.composition).mockReturnValueOnce(second.composition)
    const store = useSettingsStore()
    store.agentPanel = true
    const { state } = shell({})

    await untilDom(() => panel() !== null, 'the agent panel')
    const before = panel()
    expect(composeMock.mock.calls[0][0]).toEqual({ vaultId: '/notes/vault' })

    state.vaultPath = '/notes/other'
    await untilDom(
      () => composeMock.mock.calls.length === 2 && first.stop.mock.calls.length === 1,
      'the second runtime',
    )
    await untilDom(() => panel() !== null && panel() !== before, 'a new panel element')

    // The old runtime is torn down rather than left behind (§6.2: an instance is per vault) and
    // the new session is mounted fresh — the panel reads its session once and cannot be
    // re-pointed (T6's report §8.2).
    expect(first.stop).toHaveBeenCalledTimes(1)
    expect(second.opened).toEqual([{ vaultId: '/notes/other', cwd: '/notes/other' }])
  })

  it('stops the runtime when the folder changes behind a closed rail', async () => {
    const fake = fakeComposition()
    composeMock.mockReturnValue(fake.composition)
    const store = useSettingsStore()
    store.agentPanel = true
    const { state } = shell({})
    await untilDom(() => panel() !== null, 'the agent panel')

    state.railOpen = false
    await untilDom(() => document.querySelector('.rail-body') === null, 'the rail to leave')
    state.vaultPath = '/notes/other'
    await untilDom(() => fake.stop.mock.calls.length === 1, 'the runtime for the old folder to go')

    // The engine was started for /notes/vault and the app is now on /notes/other: with the rail
    // closed there is nothing on screen to say a process is still running for a folder the user
    // has left, so it is stopped. Reopening starts one for the folder that is open now.
    expect(composeMock).toHaveBeenCalledTimes(1)
    state.railOpen = true
    await untilDom(() => composeMock.mock.calls.length === 2, 'the runtime for the new folder')
  })

  it('stops the runtime when the switch goes off, and the chat comes back', async () => {
    const fake = fakeComposition()
    composeMock.mockReturnValue(fake.composition)
    const store = useSettingsStore()
    store.agentPanel = true
    shell({})
    await untilDom(() => panel() !== null, 'the agent panel')

    store.agentPanel = false
    await untilDom(() => chat() !== null && panel() === null, 'the chat panel back in the rail')

    // Stopped, not hidden: a rollback that kept an engine running behind an unmounted panel
    // would be a rollback in name only — the session could still write to the open note.
    expect(fake.stop).toHaveBeenCalledTimes(1)
    expect(panel()).toBeNull()
    expect(document.querySelector('.agent-panel')).toBeNull()
  })
})

describe('a refusal, and the way back from it', () => {
  it('shows the backend\'s own sentence and rolls back to the chat in one click', async () => {
    const fake = fakeComposition({ refuseWith: NO_ENGINE })
    composeMock.mockReturnValue(fake.composition)
    const store = useSettingsStore()
    store.agentPanel = true
    shell({})

    await untilDom(() => railState('refused') !== null, 'the refusal')

    // The sentence, verbatim: it names the path the program was expected at, and it is the
    // backend's answer rather than this app's paraphrase of one.
    expect(railState('refused')?.textContent).toContain(NO_ENGINE)
    // The failure is a state of the rail, not an exception that took the window with it: the
    // editor, the note list and the chat are all still there beside it.
    expect(document.querySelector('.shell')).not.toBeNull()
    expect(document.querySelector('.note-list-col')).not.toBeNull()

    const back = railState('refused')!.querySelector<HTMLElement>('[data-agent-rail-action="chat"]')
    expect(back).not.toBeNull()
    back!.click()
    await untilDom(() => chat() !== null, 'the chat panel after rolling back')
    await untilDom(() => railState('refused') === null, 'the refusal to leave the rail')

    // The rollback is the switch itself, so it survives the restart that would otherwise decide
    // the question again, and nothing is left half-mounted.
    expect(store.agentPanel).toBe(false)
    expect(panel()).toBeNull()
    expect(document.querySelector('.agent-panel')).toBeNull()
  })

  it('asks the backend again when the rail\'s retry is pressed', async () => {
    const fake = fakeComposition({ refuseWith: NO_ENGINE })
    composeMock.mockReturnValue(fake.composition)
    const store = useSettingsStore()
    store.agentPanel = true
    shell({})
    await untilDom(() => railState('refused') !== null, 'the refusal')

    const retry = railState('refused')!.querySelector<HTMLElement>('[data-agent-rail-action="retry"]')
    expect(retry).not.toBeNull()
    retry!.click()

    // A fresh composition, so a fresh `runtimeEpoch` — the retry does not trust the handle of
    // the attempt that was refused, and the failed one is stopped before it is replaced. What
    // it is asked for is unchanged: the same folder.
    await untilDom(() => fake.opened.length === 2, 'the second attempt')
    expect(composeMock).toHaveBeenCalledTimes(2)
    expect(fake.stop).toHaveBeenCalledTimes(1)
    expect(fake.opened[1]).toEqual({ vaultId: '/notes/vault', cwd: '/notes/vault' })
  })
})
