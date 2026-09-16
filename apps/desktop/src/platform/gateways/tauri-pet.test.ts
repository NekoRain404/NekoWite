/**
 * V10 — the real gateway: the arguments it sends, and what it gives back.
 *
 * Two claims are worth a suite of their own, and both are about the *wire* rather than about the
 * pet:
 *
 * - **Every command's argument object is the one the Rust side deserializes.** `@tauri-apps/api`
 *   passes the object verbatim, so a camelCase key landing on a `snake_case` parameter makes the
 *   invoke reject — which reads exactly like the command not existing. The first suite therefore
 *   drives `createTauriPetIpc` with `@tauri-apps/api` itself replaced, and reads the command names
 *   and argument objects *after* the adapter has built them — a fake handed in below the adapter
 *   would assert what this file believes the wire is, which is the thing under test.
 * - **A subscription gives back its own removal.** The window's `dispose` is the difference
 *   between one listener per window and one per mount. The unsubscribe reaching the right
 *   registration is asserted here, and so is the case that would otherwise leak: a first read that
 *   fails must release the listener rather than leave a window subscribed to a channel whose
 *   first state it never received.
 *
 * The second suite fakes the port (`PetIpc`) instead, because what it is about is the gateway's
 * own sequencing rather than the wire.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PetFeatureState, PetSettingsLoad, PetTaskProjection } from './pet-contracts'
import {
  createTauriPetIpc,
  createTauriPetConnection,
  PET_FEATURE_CHANNEL,
  PET_SETTINGS_CHANNEL,
  PET_TASKS_CHANNEL,
  type PetIpc,
  type PetWindowInfo,
} from './tauri-pet'

/** `@tauri-apps/api`, replaced. `vi.hoisted` because `vi.mock` is lifted above the imports. */
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  listen: vi.fn(
    async (_event: string, _handler: unknown): Promise<() => void> => () => {},
  ),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }))

/**
 * The wire, call by call.
 *
 * The names are the commands `commands/desktop_pet.rs` declares and the keys are the camelCase
 * spellings of its parameters. A command renamed on one side alone, or an argument key that moved
 * case, fails here rather than in a window whose every call rejects.
 */
const WIRE: [
  string,
  (ipc: ReturnType<typeof createTauriPetIpc>) => Promise<unknown>,
  /** The argument object, or absent when the command takes none. */
  unknown,
][] = [
  ['desktop_pet_state', (ipc) => ipc.state(), undefined],
  ['desktop_pet_windows', (ipc) => ipc.windows(), undefined],
  ['desktop_pet_open', (ipc) => ipc.open('cat'), { characterId: 'cat' }],
  ['desktop_pet_disable', (ipc) => ipc.disable(), undefined],
  ['desktop_pet_set_visible', (ipc) => ipc.setVisible(false), { visible: false }],
  ['desktop_pet_close_own', (ipc) => ipc.closeOwn(), undefined],
  ['desktop_pet_set_click_through', (ipc) => ipc.setClickThrough(true), { ignore: true }],
  ['desktop_pet_capabilities', (ipc) => ipc.capabilities(), undefined],
  ['desktop_pet_open_settings', (ipc) => ipc.openSettings('character'), { page: 'character' }],
  ['desktop_pet_tasks', (ipc) => ipc.tasks(), undefined],
  ['desktop_pet_read_settings', (ipc) => ipc.readSettings('general'), { domain: 'general' }],
  [
    'desktop_pet_update_settings',
    (ipc) => ipc.updateSettings({ domain: 'general' } as never),
    { write: { domain: 'general' } },
  ],
]

describe('the adapter speaks the backend’s own argument shapes', () => {
  beforeEach(() => {
    tauri.invoke.mockClear()
    tauri.listen.mockClear()
    tauri.invoke.mockImplementation(async () => undefined)
  })

  it.each(WIRE)('sends %s with the arguments its parameters deserialize', async (command, call, args) => {
    await call(createTauriPetIpc())

    expect(tauri.invoke).toHaveBeenCalledTimes(1)
    const [sent, sentArgs] = tauri.invoke.mock.calls[0] as [string, unknown]
    expect(sent).toBe(command)
    // The second argument is the object the Rust parameters deserialize from — and it is absent,
    // not an empty object, for a command that takes none: a stray key is an "unexpected argument"
    // rejection, and `{ characterId: undefined }` is a stray key.
    expect(sentArgs).toEqual(args)
  })

  it('subscribes on the host’s own channel names', async () => {
    const ipc = createTauriPetIpc()

    await ipc.onFeature(() => {})
    await ipc.onTasks(() => {})

    // §7.1's hole closed: the feature state has a push channel of its own, and the task list's is
    // D4's. The strings are declared on both sides — `commands/desktop_pet.rs` and here — so the
    // two spellings are one decision, and this is where the TypeScript half is pinned.
    expect(tauri.listen.mock.calls.map(([event]) => event)).toEqual([
      PET_FEATURE_CHANNEL,
      PET_TASKS_CHANNEL,
    ])
    expect(PET_FEATURE_CHANNEL).toBe('pet-feature')
    expect(PET_TASKS_CHANNEL).toBe('pet-task')
  })

  it('carries a page and nothing else when the pet asks for its settings', async () => {
    await createTauriPetIpc().openSettings('care')

    // §7.1: the pet names a page, never a window, a label or a URL. The section is named once, in
    // TypeScript, by `PET_SETTINGS_SECTION` — so the payload is a page and the host carries no
    // second spelling of the section id.
    expect(tauri.invoke).toHaveBeenCalledWith('desktop_pet_open_settings', { page: 'care' })
    expect(PET_SETTINGS_CHANNEL).toBe('pet-open-settings')
  })
})

/** Every call a port received, in order, with its arguments. */
type Call = [name: string, args: unknown[]]

class FakeIpc implements PetIpc {
  readonly calls: Call[] = []
  readonly featureListeners = new Set<(state: PetFeatureState) => void>()
  readonly taskListeners = new Set<(tasks: PetTaskProjection[]) => void>()
  taskReadFails: string | null = null

  private record(name: string, ...args: unknown[]): void {
    this.calls.push([name, args])
  }

  async state(): Promise<PetFeatureState> {
    this.record('state')
    return { enabled: true, visible: true }
  }

  async windows(): Promise<PetWindowInfo[]> {
    this.record('windows')
    return []
  }

  async open(characterId: string): Promise<PetWindowInfo> {
    this.record('open', characterId)
    return { id: 1, label: 'pet-1', characterId }
  }

  async disable() {
    this.record('disable')
    return { closed: [], failed: [] }
  }

  async setVisible(visible: boolean): Promise<PetFeatureState> {
    this.record('setVisible', visible)
    return { enabled: true, visible }
  }

  async closeOwn() {
    this.record('closeOwn')
    return { label: 'pet-1', characterId: 'cat' }
  }

  async setClickThrough(ignore: boolean): Promise<void> {
    this.record('setClickThrough', ignore)
  }

  async capabilities() {
    this.record('capabilities')
    return []
  }

  async openSettings(page: string): Promise<void> {
    this.record('openSettings', page)
  }

  async tasks(): Promise<PetTaskProjection[]> {
    this.record('tasks')
    if (this.taskReadFails) throw new Error(this.taskReadFails)
    return []
  }

  async readSettings(domain: string): Promise<PetSettingsLoad> {
    this.record('readSettings', domain)
    return { status: 'read-only', reason: 'schema-newer', foundVersion: 9 }
  }

  async updateSettings(write: { domain: string }): Promise<never> {
    this.record('updateSettings', write)
    throw new Error('the host refused the write')
  }

  async onFeature(onState: (state: PetFeatureState) => void): Promise<() => void> {
    this.record('onFeature')
    this.featureListeners.add(onState)
    return () => {
      this.record('offFeature')
      this.featureListeners.delete(onState)
    }
  }

  async onTasks(onTasks: (tasks: PetTaskProjection[]) => void): Promise<() => void> {
    this.record('onTasks')
    this.taskListeners.add(onTasks)
    return () => {
      this.record('offTasks')
      this.taskListeners.delete(onTasks)
    }
  }

  /** Deliver as the host's own event would. */
  pushFeature(state: PetFeatureState): void {
    for (const listener of this.featureListeners) listener(state)
  }
}

describe('a subscription gives back its own removal', () => {
  it('delivers the current state first, then every change, and stops on unsubscribe', async () => {
    const ipc = new FakeIpc()
    const connection = createTauriPetConnection({ ipc })
    const seen: PetFeatureState[] = []

    const stop = await connection.subscribeFeature((state) => seen.push(state))
    ipc.pushFeature({ enabled: true, visible: false })
    stop()
    ipc.pushFeature({ enabled: false, visible: false })

    // The first delivery is the current state — the read after the listen, so a frame in the gap
    // is delivered twice rather than lost — and the last push reaches nobody.
    expect(seen).toEqual([
      { enabled: true, visible: true },
      { enabled: true, visible: false },
    ])
    expect(ipc.calls.map(([name]) => name)).toEqual(['onFeature', 'state', 'offFeature'])
    expect(ipc.featureListeners.size).toBe(0)
  })

  it('releases the listener when the first read fails', async () => {
    const ipc = new FakeIpc()
    ipc.taskReadFails = 'command desktop_pet_tasks not found'
    const connection = createTauriPetConnection({ ipc })

    // A window that mounted and could not be told what it is looking at has nothing to listen
    // for: keeping the registration would leave it subscribed to a channel whose first state it
    // never received. The refusal is the caller's to state, so it is rethrown rather than
    // swallowed into an empty list.
    await expect(connection.subscribe(() => {})).rejects.toThrow('not found')
    expect(ipc.taskListeners.size).toBe(0)
    expect(ipc.calls.map(([name]) => name)).toEqual(['onTasks', 'tasks', 'offTasks'])
  })

  it('keeps each subscription’s removal to itself', async () => {
    const ipc = new FakeIpc()
    const connection = createTauriPetConnection({ ipc })

    const first = await connection.subscribeFeature(() => {})
    const second = await connection.subscribeFeature(() => {})
    first()
    second()

    expect(ipc.featureListeners.size).toBe(0)
    expect(ipc.calls.filter(([name]) => name === 'offFeature')).toHaveLength(2)
  })
})
