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
import { setLocale } from '../i18n'
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
  // The catalogue is a singleton shared by every test in this file; the one that asserts English
  // copy puts the locale back, so a later test is not reading a language it did not ask for.
  setLocale('zh')
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

    // The two sentences that name the engine, built here by the real catalogue through the real
    // labels builder. The registry in this composition refuses to answer, so the name is the
    // session's agent id — the fallback that keeps the title drawable — and what matters is that
    // the `{engine}` slot is filled rather than shipped to the document.
    setLocale('en')
    await untilDom(() => document.querySelector('.agent-bar-title') !== null, 'the title')
    expect(document.querySelector('.agent-bar-title')?.textContent).toBe('New opencode session')
    expect(document.querySelector('[data-agent-empty]')?.textContent?.trim()).toBe(
      'Message opencode — / for commands',
    )
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

/**
 * The whole chain, from a click in the real window down to the gateway's own call.
 *
 * The unit tests either side of this one hold the halves — the panel's capability gate and rows
 * (`AgentSessionHistory.test.ts`), the rail's latch (`agent-rail.test.ts`) — and this is the
 * seam they share, which is the one that cannot be asserted from either: the bar's control, the
 * panel's list, the rail body's event, the shell's handler and the rail's reopen, in one gesture.
 *
 * The table is the one a history exists for. A first session was opened, used, and left behind by
 * a runtime that has since been replaced — so the engine still lists it while nothing serves its
 * handle — and the runtime now up holds a second one. That is what `stop`, `start` and a second
 * `openSession` produce, and it is the state that makes "reopen the earlier conversation" a real
 * thing to ask for.
 */
describe('the sessions the engine holds, from the panel’s own control', () => {
  async function shellWithHistory(options: { refuseLoadWith?: string } = {}) {
    const gateway = createMemoryAgentGateway({
      agentId: 'opencode',
      profileId: 'default',
      // What the engine reports about itself, which is what draws the control at all.
      capabilities: { 'session-list': { status: 'available' } },
    })
    await gateway.start()
    const earlier = await gateway.openSession({ vaultId: '/notes/vault', cwd: '/notes/vault' })
    gateway.script({ chunks: ['the earlier answer. '] })
    await gateway.prompt(earlier, 'earlier question')
    await gateway.stop()

    const loads: string[] = []
    const load = gateway.loadSession.bind(gateway)
    gateway.loadSession = async (sessionId, request) => {
      loads.push(sessionId)
      if (options.refuseLoadWith !== undefined) throw options.refuseLoadWith
      return load(sessionId, request)
    }

    composeMock.mockReturnValue(fakeComposition({ gateway }).composition)
    const store = useSettingsStore()
    store.agentPanel = true
    shell({})
    await untilDom(() => panel() !== null, 'the agent panel')
    await untilDom(() => document.querySelector('[data-agent-history]') !== null, 'the history control')
    return { gateway, earlier, loads }
  }

  /** Open the list and wait for the engine's answer to be drawn. */
  async function openHistory(): Promise<void> {
    document.querySelector<HTMLElement>('[data-agent-history]')!.click()
    await untilDom(() => document.querySelector('.agent-history-option') !== null, 'the history rows')
  }

  /** The row the list marks as the session on screen. */
  const openRow = (): (string | null)[] =>
    Array.from(document.querySelectorAll<HTMLElement>('.agent-history-option')).flatMap((row) =>
      row.getAttribute('aria-current') === 'true' ? [row.getAttribute('data-session')] : [],
    )

  it('reopens the session the reader picks, and the panel ends up on it', async () => {
    const { earlier, loads } = await shellWithHistory()
    const before = panel()

    await openHistory()
    // The engine's own list: the session this runtime is serving, and the one it only lists.
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.agent-history-option')).map(
      (row) => row.getAttribute('data-session'),
    )
    expect(rows).toContain(earlier.sessionId)
    expect(openRow()).not.toEqual([earlier.sessionId])

    document.querySelector<HTMLElement>(`[data-session="${earlier.sessionId}"]`)!.click()

    // The call is the rail's, made for the vault the runtime was started for.
    await untilDom(() => loads.length === 1, 'the load')
    expect(loads).toEqual([earlier.sessionId])
    // …and the panel is mounted fresh on it rather than re-pointed: a session change is a
    // remount, which is what the store's `focus`/`attach` path does for any other session.
    await untilDom(() => panel() !== null && panel() !== before, 'a new panel element')
    // The list the replaced panel had open goes with it, so what is read back below is the new
    // panel's own.
    await untilDom(() => document.querySelector('.agent-history-popup') === null, 'the old list to leave')

    // Read back from the surface the user reads it from: the reopened session is the one the
    // engine now reports as open.
    await untilDom(() => document.querySelector('[data-agent-history]') !== null, 'the control again')
    await openHistory()
    expect(openRow()).toEqual([earlier.sessionId])
  })

  it('says so in the engine’s words when a session cannot be reopened, and keeps the one open', async () => {
    const refusal = 'the engine refused to restore that session'
    const { earlier, loads } = await shellWithHistory({ refuseLoadWith: refusal })
    const before = panel()

    await openHistory()
    document.querySelector<HTMLElement>(`[data-session="${earlier.sessionId}"]`)!.click()

    await untilDom(() => loads.length === 1, 'the attempt')
    // The engine's sentence, where the user is looking. It is not a state of the rail: the
    // session that *is* open is not the one at fault, and taking it off the screen because a
    // different one would not open is the wrong trade.
    await untilDom(() => document.querySelector('.toast') !== null, 'the notice')
    expect(document.querySelector('.toast')?.textContent).toContain(refusal)
    expect(panel()).toBe(before)
    expect(railState('refused')).toBeNull()
  })

  /**
   * The name the reader just read, on the bar the reopen lands on.
   *
   * `session/list` is the only answer this app is ever given a session's name in — the load
   * response carries no title, and `SessionInfoUpdate` is not mapped on the host side. So a pick
   * out of the list is the one moment a name is in hand, and it has to survive the remount that
   * follows it: before this, the bar fell straight through to `labels.untitled` and told a reader
   * "New opencode session" about the very session whose row they had picked by name.
   */
  it('draws the name the engine gave the session it reopened, not the untitled fallback', async () => {
    const { earlier } = await shellWithHistory()
    const before = panel()

    await openHistory()
    // Read the row's own title first: the assertion below is that the *bar* carries what the row
    // carried, not that this file knows what the double names its sessions.
    const rowTitle = document
      .querySelector<HTMLElement>(
        `[data-session="${earlier.sessionId}"] .agent-history-option-title`,
      )
      ?.textContent?.trim()
    expect(rowTitle).toBeTruthy()

    document.querySelector<HTMLElement>(`[data-session="${earlier.sessionId}"]`)!.click()
    await untilDom(() => panel() !== null && panel() !== before, 'a new panel element')
    await untilDom(
      () => document.querySelector('.agent-bar-title')?.textContent?.trim() === rowTitle,
      'the reopened session’s name on the bar',
    )
    const bar = document.querySelector<HTMLElement>('.agent-bar-title')
    expect(bar?.textContent?.trim()).toBe(rowTitle)
    // The fallback is a sentence this app wrote, and it is what the bar said before the name was
    // carried. Asserting its absence is what makes this a test of the carried string rather than
    // of "something is drawn".
    expect(bar?.textContent).not.toContain('New opencode session')
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
