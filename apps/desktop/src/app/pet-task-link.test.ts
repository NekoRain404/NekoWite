/**
 * The return half of §6.2's 点击返回任务, without a pet window or a rail.
 *
 * The flow this exists for is 收起面板 → 完成提醒 → 返回对应会话, so the three things that can be
 * wrong are the three the module's header names: a listener that lives as long as the rail (and so
 * never hears the click it exists for), a click that re-points the store at a session this window
 * does not hold, and a registration nobody releases. The platform adapter is mocked rather than the
 * Tauri API: `onPetTaskRequest` has its own suite, and this one is about what the shell's policy
 * does with a key.
 *
 * The store is the real one over the memory double, for the reason `agent-session.test.ts` gives:
 * what a click addresses is the store's own record table, and a hand-built stub of it would assert
 * a rule this file wrote instead of the rule the store keeps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { attachPetTaskLink } from './pet-task-link'
import { createMemoryAgentGateway } from '../platform/gateways/memory-agent'
import { sessionKey } from '../features/agent/services/agent-session-view'
import { useAgentSessionStore } from '../features/agent/stores/agent-session'
import type { PetTaskKey } from '../platform/gateways/pet-contracts'

const platform = vi.hoisted(() => ({ onPetTaskRequest: vi.fn() }))
vi.mock('../platform/pet-task-request', () => ({
  onPetTaskRequest: platform.onPetTaskRequest,
}))

let mounted: VueApp[] = []
let pinia: Pinia

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
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
  let deliver: (key: PetTaskKey) => void = () => {
    throw new Error('nothing was delivered: the registration did not resolve')
  }
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
    deliver: (key) => deliver(key),
    settle: async () => {
      finish()
      await nextTick()
    },
  }
}

function mount(inputs: { railOpen: () => boolean; onOpenRail: () => void }): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    setup() {
      attachPetTaskLink(inputs)
      return () => null
    },
  })
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
}

/** The store's session, as the composition site hands it over, and the key the pet would send. */
async function opened(): Promise<{ key: PetTaskKey; sessionId: string }> {
  const gateway = createMemoryAgentGateway({ agentId: 'agent-1', profileId: 'profile-1' })
  await gateway.start()
  const session = await gateway.openSession({ vaultId: 'vault-1', cwd: '/tmp/vault' })
  await useAgentSessionStore().attach(gateway, session)
  return { key: { ...session, runId: 'run-0' }, sessionId: session.sessionId }
}

describe('the pet’s task link', () => {
  it('focuses the session the key names, and reads it', async () => {
    const host = registration()
    const { key } = await opened()
    const store = useAgentSessionStore()
    const target = sessionKey(key)
    // A second session, so "the store moved" is something a wrong implementation cannot pass by
    // accident: the record the click must reach is not the only one there.
    const other = sessionKey({ ...key, sessionId: 'ses-other' })
    store.records[other] = { ...store.records[target]!, identity: { ...key, sessionId: 'ses-other' } }
    store.focus(other)

    const onOpenRail = vi.fn()
    mount({ railOpen: () => true, onOpenRail })
    await nextTick()
    await host.settle()

    host.deliver(key)
    await nextTick()

    // The record key is the five identity fields and no run: the same key `useAgentSession` files
    // the panel's own record under, which is what makes a `PetTaskKey` addressable without a
    // second store.
    expect(store.activeKey).toBe(sessionKey({ ...key }))
    // The rail is already on screen, so nothing is asked for. The click moved the store and
    // nothing else.
    expect(onOpenRail).not.toHaveBeenCalled()
  })

  it('asks for the rail, which is the state the whole flow runs in', async () => {
    const host = registration()
    const railOpen = false
    const onOpenRail = vi.fn()
    mount({ railOpen: () => railOpen, onOpenRail })
    await nextTick()
    await host.settle()

    host.deliver({ ...(await opened()).key })

    // §3.1.3 keeps the run going while the panel is away, so the reminder arrives with the panel
    // collapsed — and a return path that only moved the store would put nothing on screen.
    expect(onOpenRail).toHaveBeenCalledTimes(1)
  })

  it('does not re-point the store at a session this window is not holding', async () => {
    const host = registration()
    const { key } = await opened()
    const store = useAgentSessionStore()
    const held = sessionKey(key)
    store.focus(held)

    mount({ railOpen: () => true, onOpenRail: vi.fn() })
    await nextTick()
    await host.settle()

    // A key the engine is no longer running: the window is still raised and the rail still shows
    // what it has, but the store keeps the session that is really on screen. `focus` takes any
    // string, so the alternative is an active key nothing answers to.
    host.deliver({ ...key, runtimeEpoch: 'epoch-2' })

    expect(store.activeKey).toBe(held)
    expect(store.records[sessionKey({ ...key, runtimeEpoch: 'epoch-2' })]).toBeUndefined()
  })

  it('releases the listener when the window goes away, in flight or already resolved', async () => {
    const host = registration()
    mount({ railOpen: () => false, onOpenRail: vi.fn() })
    await nextTick()
    await host.settle()

    mounted.forEach((app) => app.unmount())
    mounted = []
    expect(host.release).toHaveBeenCalledTimes(1)

    // And a registration that had not resolved when the window went away still has an owner.
    const second = registration()
    mount({ railOpen: () => false, onOpenRail: vi.fn() })
    await nextTick()
    mounted.forEach((app) => app.unmount())
    mounted = []
    await second.settle()
    expect(second.release).toHaveBeenCalledTimes(1)
  })
})
