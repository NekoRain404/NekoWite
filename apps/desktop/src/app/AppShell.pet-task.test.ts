/**
 * The pet's click on a task, as the window answers it when it cannot put that session on screen.
 *
 * §6.2's 点击返回任务 is two halves and this is the second one at the layer that shows its result:
 * the pet's row calls `desktop_pet_open_task`, the host raises this window and emits D1's key, and
 * `pet-task-link.ts` decides what the click may do. What *this* file is about is the outcome the
 * link cannot draw: a key this window cannot serve is refused with a sentence, and the sentence is
 * the shell's because the reason is a fact about the shell's own rail state.
 *
 * **The defect this file exists for, as a user would put it**: with no runtime up, a click on a
 * task used to ask for the rail — which starts an engine for the folder that happens to be open and
 * shows a *new* session on it. The reader asked for one task and was shown an unrelated
 * conversation, with nothing said about why. So the two claims here are one claim in two halves:
 * the reader is told, and no engine is asked for.
 *
 * The real `AppShell` is mounted and the real store drives the switch, the way
 * `AppShell.agent-rail.test.ts` does it — the same instrument, for the same reason: the wiring
 * between the link and the sentence is what a unit test of either half cannot see. `composeMock` is
 * the one stub, so "no process was started" is an assertion about a call that did not happen rather
 * than something inferred from a screen that stayed still, and the toast is read through the real
 * `onNotify` the toast component subscribes to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import AppShell from './AppShell.vue'
import { useSettingsStore } from '../stores/settings'
import { createMemoryAgentGateway } from '../platform/gateways/memory-agent'
import { onNotify } from '../services/errors'
import { setLocale, t } from '../i18n'
import type { AgentComposition } from './agent-composition'
import type { AgentOpenRequest, AgentSession } from '../platform/gateways/agent-contracts'
import type { PetTaskKey } from '../platform/gateways/pet-contracts'

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const composeMock = vi.hoisted(() => vi.fn())
vi.mock('./agent-composition', () => ({ createAgentComposition: composeMock }))

/**
 * The pet's half, as a test drives it: `onPetTaskRequest` is the platform adapter
 * `pet-task-link.ts` attaches to, and what a case does is deliver one of D1's keys through it.
 *
 * The adapter is mocked rather than the Tauri event API for the reason `pet-task-link.test.ts`
 * gives: `onPetTaskRequest` has its own suite and this one is about what the window does with a
 * key.
 */
const petRequests = vi.hoisted(() => ({ deliver: null as null | ((key: PetTaskKey) => void) }))
vi.mock('../platform/pet-task-request', () => ({
  onPetTaskRequest: (cb: (key: PetTaskKey) => void) => {
    petRequests.deliver = cb
    return () => {
      petRequests.deliver = null
    }
  },
}))

function fakeComposition(agentId = 'opencode') {
  const gateway = createMemoryAgentGateway({ agentId, profileId: 'default' })
  const opened: AgentOpenRequest[] = []
  const composition: AgentComposition = {
    gateway,
    start: async () => {
      await gateway.start()
    },
    openSession: async (request: AgentOpenRequest): Promise<AgentSession> => {
      opened.push(request)
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
  return { composition, opened }
}

let pinia: Pinia
let mounted: VueApp[] = []
let toasts: string[] = []
let offNotify: (() => void) | null = null

/** Keep the renderer and the promise queue moving until the predicate holds. */
async function untilDom(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (predicate()) return
    await Promise.resolve()
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`the window never reached: ${label}`)
}

function shell(props: { vaultPath?: string | null; railOpen?: boolean }): {
  state: { railOpen: boolean; vaultPath: string | null }
} {
  const state = reactive({
    sidebarVisible: true,
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
  const app = createApp({
    // `onToggleRail` is `App.vue`'s job in the product, and it is written here for the same reason
    // it exists there: the shell asks for the rail and the layer above it decides. A click that
    // asks for the rail therefore has to *open* it for the honoured case to be assertable at all.
    render: () =>
      h(AppShell, {
        ...state,
        onToggleRail: () => {
          state.railOpen = !state.railOpen
        },
      }),
  })
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  return { state }
}

/** One key, as `desktop_pet_open_task` mints it: the session's identity and the run. */
function keyOf(overrides: Partial<PetTaskKey> = {}): PetTaskKey {
  return {
    agentId: 'opencode',
    profileId: 'default',
    runtimeEpoch: 'epoch-pet',
    vaultId: '/notes/vault',
    sessionId: 'session-1',
    runId: 'run-pet',
    ...overrides,
  }
}

function deliver(key: PetTaskKey): void {
  if (petRequests.deliver === null) throw new Error('the link never registered a listener')
  petRequests.deliver(key)
}

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  composeMock.mockReset()
  petRequests.deliver = null
  toasts = []
  offNotify = onNotify((message) => toasts.push(message))
  localStorage.clear()
  setLocale('en')
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
  offNotify?.()
  offNotify = null
})

describe('a click on a pet task this window cannot show', () => {
  it('is refused out loud, and no engine is started for it', async () => {
    const store = useSettingsStore()
    store.agentPanel = true
    // The reported state: a window with a folder open and no runtime up (a fresh window, or one
    // whose engine was never started because the rail is closed). Nothing is running, so the click
    // has nothing this window can move to.
    shell({ railOpen: false })
    await nextTick()

    deliver(keyOf({ vaultId: '/notes/archive' }))
    await nextTick()

    // What the reader is told, and the fact that makes it true: no engine is running here for the
    // folder the task came from — named, because the pet's row never shows it.
    expect(toasts).toEqual([
      t('agent.rail.taskUnavailable.noRuntime', { vault: '/notes/archive' }),
    ])
    // And the half that is not a sentence: no composition was built, no process was asked for, and
    // no rail was opened — because opening the rail is what starts one, and the click did not ask
    // for an engine, it asked for a session.
    expect(composeMock).not.toHaveBeenCalled()
    expect(document.querySelector('.rail-body')).toBeNull()
  })

  it('says which folder the window is working in when the task belongs to another one', async () => {
    const fake = fakeComposition()
    composeMock.mockReturnValue(fake.composition)
    const store = useSettingsStore()
    store.agentPanel = true
    shell({})
    await untilDom(() => document.querySelector('[data-agent-panel]') !== null, 'the panel')
    const before = document.querySelector('[data-agent-panel]')

    // The same window, a task from a folder it left behind: showing the session it *does* hold
    // would be a conversation the reader did not ask for, so the click is refused and the sentence
    // names the folder that is running instead.
    deliver(keyOf({ vaultId: '/notes/archive' }))
    await nextTick()

    expect(toasts).toEqual([
      t('agent.rail.taskUnavailable.elsewhere', { showing: '/notes/vault' }),
    ])
    // Nothing moved: the runtime is the one it was, and the panel was not remounted for a session
    // nobody clicked.
    expect(composeMock).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-agent-panel]')).toBe(before)
  })

  it('says the engine is still starting when one is on its way', async () => {
    const gateway = createMemoryAgentGateway({ agentId: 'opencode', profileId: 'default' })
    // A composition whose `session/new` never answers: the rail sits in its `starting` arm for as
    // long as the case needs it to, which is the only way that arm is reachable in a test — the
    // memory gateway opens a session on the first tick.
    composeMock.mockReturnValue({
      gateway,
      start: async () => {
        await gateway.start()
      },
      openSession: () => new Promise<AgentSession>(() => {}),
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
    } satisfies AgentComposition)
    const store = useSettingsStore()
    store.agentPanel = true
    shell({})
    // Waited for through the composition rather than through the rail: `AgentRailBody` draws the
    // same sentence for `idle` and for `starting` whenever a folder is open (its `v-else` arm),
    // so the DOM cannot tell the two apart — and the state is the thing under test. The stub's
    // `openSession` never answers, so the rail stays in `starting` for as long as the case needs.
    await untilDom(() => composeMock.mock.calls.length === 1, 'the composition to be built')

    // A moment away rather than unavailable: the runtime is coming up for this very folder, and
    // once it is live the key *is* one of its sessions, so the click is a move rather than a
    // refusal — which is why the sentence says to press the task again rather than naming a folder.
    deliver(keyOf())
    await nextTick()

    expect(toasts).toEqual([t('agent.rail.taskUnavailable.starting')])
  })

  it('names the engine when the window runs another one for the same folder', async () => {
    const fake = fakeComposition('opencode')
    composeMock.mockReturnValue(fake.composition)
    const store = useSettingsStore()
    store.agentPanel = true
    shell({})
    await untilDom(() => document.querySelector('[data-agent-panel]') !== null, 'the panel')

    // §3.4's multi-agent boundary: the same vault can be served by a different engine, and that
    // engine's session is not this task's. The engine is named, because it is the whole of the
    // reason.
    deliver(keyOf({ agentId: 'claude-code' }))
    await nextTick()

    expect(toasts).toEqual([
      t('agent.rail.taskUnavailable.otherEngine', { engine: 'opencode' }),
    ])
    expect(composeMock).toHaveBeenCalledTimes(1)
  })

  it('still honours a click it can serve, and opens the rail on that session', async () => {
    const fake = fakeComposition()
    composeMock.mockReturnValue(fake.composition)
    const store = useSettingsStore()
    store.agentPanel = true
    const { state } = shell({})
    await untilDom(() => document.querySelector('[data-agent-panel]') !== null, 'the panel')

    // 收起面板: closing the rail does not stop the runtime (§5.1 任务可以在面板收起后继续), so this
    // is the state the whole flow runs in — a run going on in a session nobody is looking at.
    state.railOpen = false
    await untilDom(() => document.querySelector('.rail-body') === null, 'the rail to leave')
    expect(composeMock).toHaveBeenCalledTimes(1)

    // 完成提醒 → 返回: the click names the session the window is serving, so the rail comes back on
    // it — the session the reader left, not a new one. Nothing is refused here, which is the half
    // the refusal must not swallow.
    deliver(keyOf())
    await nextTick()
    await untilDom(() => document.querySelector('.rail-body') !== null, 'the rail to reopen')
    await untilDom(() => document.querySelector('[data-agent-panel]') !== null, 'the panel')

    expect(toasts).toEqual([])
    expect(state.railOpen).toBe(true)
    // No second engine: the runtime the session came back on is the one that was already running,
    // and the epoch in the key is deliberately not one of the fields compared (see
    // `pet-task-link.ts`) — which is what lets a task from before a restart come back at all.
    expect(composeMock).toHaveBeenCalledTimes(1)
    expect(fake.opened).toEqual([{ vaultId: '/notes/vault', cwd: '/notes/vault' }])
  })
})
