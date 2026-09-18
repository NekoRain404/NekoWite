/**
 * The return half of §6.2's 点击返回任务, without a pet window.
 *
 * The flow this exists for is 收起面板 → 完成提醒 → 返回对应会话, so the things that can be wrong are
 * the ones the module's header names: a listener that lives as long as the rail (and so never hears
 * the click it exists for), a click that does not put the session it names on screen, a click that
 * asks the rail for a session the runtime cannot serve, a click that *starts* a runtime as a side
 * effect, and a registration nobody releases. The platform adapter is mocked rather than the Tauri
 * API: `onPetTaskRequest` has its own suite, and this one is about what the shell's policy does
 * with a key.
 *
 * **No store is mounted here, and that is the state under test.** The link used to move the agent
 * store's pointer (`focus`) to the session the key named while the rail kept the session it was on,
 * so the store and the screen could name two different sessions and nothing said so. The pointer is
 * gone (`features/agent/stores/agent-session.ts`) and this file no longer imports the store: what a
 * click changes is the rail, through the readings the shell hands in.
 *
 * **The two outcomes are "shown" and "said", and there is no third.** A click either puts the named
 * session on screen — `onShow`, plus `onOpenRail` when the rail is away, because §3.1.3 keeps the
 * run going while the panel is collapsed — or it is refused through `onUnavailable`, which is what
 * the window that knows why (the shell, reading its own rail state) turns into a sentence. What it
 * must never do is what it did until this suite was rewritten: ask for the rail with no runtime up,
 * which starts an engine for whatever folder is open and shows a session the user did not click.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { attachPetTaskLink } from './pet-task-link'
import type { AgentIdentity } from '../platform/gateways/agent-contracts'
import type { PetTaskKey } from '../platform/gateways/pet-contracts'

const platform = vi.hoisted(() => ({ onPetTaskRequest: vi.fn() }))
vi.mock('../platform/pet-task-request', () => ({
  onPetTaskRequest: platform.onPetTaskRequest,
}))

let mounted: VueApp[] = []

/**
 * A Pinia, installed and never read.
 *
 * The link resolves no store any more, and this is here so that the *only* thing a case can fail
 * on is the click's policy: the version this file was written to replace resolved the agent store
 * when it was attached, so a suite without one would have every case in the file failing on a
 * store that is missing rather than on the click that was not honoured — which is the difference
 * between a red that indicts the fix and a red that indicts the harness.
 */
beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  platform.onPetTaskRequest.mockReset()
})

/**
 * One registration, held open until the test resolves it.
 *
 * `listen` resolves after an await, so the interesting states are "registered", "not yet
 * registered" and "the window went away before it resolved" — and a mock that resolves
 * immediately makes the third one unreachable.
 */
function registration(): {
  release: ReturnType<typeof vi.fn>
  settle: () => Promise<void>
  deliver: (key: PetTaskKey) => void
} {
  const release = vi.fn()
  let deliver: ((key: PetTaskKey) => void) | null = null
  let finish = (): void => {}
  platform.onPetTaskRequest.mockImplementation(
    (cb: (key: PetTaskKey) => void) =>
      new Promise<() => void>((done) => {
        deliver = cb
        finish = () => done(release)
      }),
  )
  return {
    release,
    deliver: (key) => {
      if (deliver === null) throw new Error('nothing was delivered: the registration did not resolve')
      deliver(key)
    },
    settle: async () => {
      finish()
      await nextTick()
    },
  }
}

interface LinkState {
  railOpen: boolean
  session: AgentIdentity | null
  shown: string[]
  opened: number
  /** Every click this window could not put on screen, as the key it was refused with. */
  unavailable: PetTaskKey[]
}

/** The shell's readings, as one mutable state a case can move between clicks. */
function linkState(session: AgentIdentity | null, railOpen = true): LinkState {
  return { railOpen, session, shown: [], opened: 0, unavailable: [] }
}

function mount(state: LinkState): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    setup() {
      attachPetTaskLink({
        railOpen: () => state.railOpen,
        onOpenRail: () => {
          state.opened += 1
          state.railOpen = true
        },
        session: () => state.session,
        onShow: (sessionId) => state.shown.push(sessionId),
        onUnavailable: (key) => state.unavailable.push(key),
      })
      return () => null
    },
  })
  app.mount(host)
  mounted.push(app)
}

/** One session of one runtime, as the rail's `live` arm hands it over, and the key the pet sends
 *  for it. */
function session(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    agentId: 'agent-1',
    profileId: 'profile-1',
    runtimeEpoch: 'epoch-1',
    vaultId: '/tmp/vault',
    sessionId: 'ses-a',
    ...overrides,
  }
}

const keyOf = (identity: AgentIdentity, runId = 'run-0'): PetTaskKey => ({ ...identity, runId })

describe('the pet’s task link', () => {
  it('asks the rail for the session the key names, when the rail is on another one of its runtime', async () => {
    const host = registration()
    // The disagreement this file was fixed for, constructed: the rail shows one session of its
    // runtime and the pet's task names another — the state a reader reaches by starting a new
    // session while a task goes on in the old one, or by picking an older row from the history
    // list. The click must move what is on screen, not a pointer behind it.
    const state = linkState(session({ sessionId: 'ses-a' }))
    mount(state)
    await nextTick()
    await host.settle()

    host.deliver(keyOf(session({ sessionId: 'ses-b' })))
    await nextTick()

    expect(state.shown).toEqual(['ses-b'])
    // The rail was already on screen, so nothing is asked of the shell's own toggle.
    expect(state.opened).toBe(0)
  })

  it('asks for nothing when the key names the session already on screen', async () => {
    const host = registration()
    const state = linkState(session({ sessionId: 'ses-a' }))
    mount(state)
    await nextTick()
    await host.settle()

    host.deliver(keyOf(session({ sessionId: 'ses-a' })))

    // A move to where the reader already is would be a remount for nothing — and the engine would
    // refuse the load underneath it (`session-open`).
    expect(state.shown).toEqual([])
  })

  it('says the task is not available instead of asking for a session of another runtime', async () => {
    const host = registration()
    const shown = session({ sessionId: 'ses-a', vaultId: '/tmp/vault' })
    const state = linkState(shown, false)
    mount(state)
    await nextTick()
    await host.settle()

    // Another vault, and another engine: `agent_load_session` refuses the first before the engine
    // is asked, and a session of the second is not this runtime's to serve. The window is still
    // raised by the host, and what it shows is the refusal — *not* a rail opened on the session it
    // happens to hold, which is what this case used to assert and what a reader could not tell
    // apart from the return they asked for.
    const otherVault = keyOf(session({ sessionId: 'ses-b', vaultId: '/tmp/other' }))
    const otherEngine = keyOf(session({ sessionId: 'ses-c', agentId: 'another-engine' }))
    host.deliver(otherVault)
    host.deliver(otherEngine)

    expect(state.shown).toEqual([])
    expect(state.unavailable).toEqual([otherVault, otherEngine])
    // Nothing is asked of the shell's own toggle either: opening the rail is what starts an engine
    // for the folder that happens to be open, and the click did not ask for that.
    expect(state.opened).toBe(0)
  })

  it('takes a task from before the runtime was restarted, which is the same engine and vault', async () => {
    const host = registration()
    // The engine's session ids outlive a runtime instance — that is what its own history list is —
    // so the only fields that decide whether this window can go back to a session are the engine,
    // the profile and the vault. The epoch names the instance, and it is not one of them.
    const state = linkState(session({ runtimeEpoch: 'epoch-2' }))
    mount(state)
    await nextTick()
    await host.settle()

    host.deliver(keyOf(session({ runtimeEpoch: 'epoch-1', sessionId: 'ses-b' })))

    expect(state.shown).toEqual(['ses-b'])
  })

  it('asks for the rail, which is the state the whole flow runs in', async () => {
    const host = registration()
    const state = linkState(session({ sessionId: 'ses-b' }), false)
    mount(state)
    await nextTick()
    await host.settle()

    host.deliver(keyOf(session({ sessionId: 'ses-b' })))

    // §3.1.3 keeps the run going while the panel is away, so the reminder arrives with the panel
    // collapsed — and a return path that only asked the rail for a session would put nothing on
    // screen.
    expect(state.opened).toBe(1)
    expect(state.shown).toEqual([])
  })

  it('says the task is not available when no runtime is up, and starts nothing', async () => {
    const host = registration()
    const state = linkState(null, false)
    mount(state)
    await nextTick()
    await host.settle()

    const key = keyOf(session({ sessionId: 'ses-b' }))
    host.deliver(key)

    // The case this file was fixed for, and the reason it raises the window and stops there: with
    // no runtime up, asking for the rail would start an engine for the folder that happens to be
    // open and then show a *new* session on it — a process spawned and a subscription spent by a
    // click on a decoration, and the reader looking at a conversation they never asked for. The
    // click is answered with the refusal instead, and the key travels with it so the window can
    // say which task and which folder it could not show.
    expect(state.unavailable).toEqual([key])
    expect(state.shown).toEqual([])
    expect(state.opened).toBe(0)
  })

  it('says the task is not available when the rail is already on screen with no runtime', async () => {
    const host = registration()
    const state = linkState(null, true)
    mount(state)
    await nextTick()
    await host.settle()

    const key = keyOf(session({ sessionId: 'ses-b' }))
    host.deliver(key)

    // The rail being up changes nothing about whether this window can serve the key — and the
    // refusal is the answer in both states, which is what keeps the two from drifting: an open
    // rail with no runtime is a window whose panel may be mid-start, refused, or switched off.
    expect(state.unavailable).toEqual([key])
    expect(state.shown).toEqual([])
    expect(state.opened).toBe(0)
  })

  it('releases the listener when the window goes away, in flight or already resolved', async () => {
    const host = registration()
    mount(linkState(null, false))
    await nextTick()
    await host.settle()

    mounted.forEach((app) => app.unmount())
    mounted = []
    expect(host.release).toHaveBeenCalledTimes(1)

    // And a registration that had not resolved when the window went away still has an owner.
    const second = registration()
    mount(linkState(null, false))
    await nextTick()
    mounted.forEach((app) => app.unmount())
    mounted = []
    await second.settle()
    expect(second.release).toHaveBeenCalledTimes(1)
  })
})
