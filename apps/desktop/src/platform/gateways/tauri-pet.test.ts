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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  PetAppearance,
  PetCareRead,
  PetCatalogueReading,
  PetCharacterEntry,
  PetFeatureState,
  PetSettingsChange,
  PetSettingsLoad,
  PetTaskKey,
  PetTaskProjection,
} from './pet-contracts'
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
  // The parameters are declared even though neither implementation reads one, because the
  // *record* is what these two are for: `mock.calls` is `[]` for every call of a zero-parameter
  // mock, so the command name and the argument object below had no types to be read from and the
  // two assertions that read them stopped compiling — while still passing, since Vitest runs the
  // file with the types stripped. Declaring the port's own shape is what makes the recording
  // legible to the checker rather than only to the runtime.
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(async () => undefined),
  listen: vi.fn<(event: string, handler: (event: unknown) => void) => Promise<() => void>>(
    async () => () => {},
  ),
  // The one place a host path becomes a URL. Recorded rather than stubbed to a constant, because
  // what is under test is *that* the sheet's path is converted and that the other arms are not
  // touched — a conversion applied to a `missing` arm would produce a URL to a file nobody
  // granted.
  convertFileSrc: vi.fn<(path: string) => string>((path) => `asset://localhost/${path}`),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
  convertFileSrc: tauri.convertFileSrc,
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }))

/** One task key, spelled as D1 declares it — six fields and no encoding of its own. */
const PET_TASK_KEY = {
  agentId: 'opencode',
  profileId: 'default',
  runtimeEpoch: 'epoch-1',
  vaultId: 'vault-a',
  sessionId: 'ses-1',
  runId: 'run-0',
} as const

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
  // A command with no parameter at all: the ledger is the process's own progress (§6.3), so there
  // is no window, character or domain to name — and the absent argument is what says so.
  ['desktop_pet_care_read', (ipc) => ipc.care(), undefined],
  ['desktop_pet_tasks', (ipc) => ipc.tasks(), undefined],
  // The window's own two reads, and the one route back. `openTask` carries the whole key under
  // `task` — the Rust parameter's name — and nothing else: §6.3's limited target crosses this
  // wire as data, never as a URL or a window name.
  ['desktop_pet_appearance', (ipc) => ipc.appearance(), undefined],
  ['desktop_pet_library', (ipc) => ipc.library(), undefined],
  ['desktop_pet_import_character', (ipc) => ipc.importCharacter(), undefined],
  ['desktop_pet_catalogue', (ipc) => ipc.catalogue(), undefined],
  ['desktop_pet_adopt_character', (ipc) => ipc.adoptCharacter('boba'), { slug: 'boba' }],
  ['desktop_pet_open_task', (ipc) => ipc.openTask(PET_TASK_KEY), { task: PET_TASK_KEY }],
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
    const [sent, sentArgs] = tauri.invoke.mock.calls[0]
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

  it('hands the ledger’s answer on exactly as it arrived', async () => {
    // No reshaping and no defaulting: both arms are the host's to choose, and an adapter that
    // turned `empty` into a zeroed summary — or the other way round — would be inventing a fact
    // about the user's progress. The object identity is the assertion, so a copy that quietly
    // filled a missing field would fail here rather than on a page.
    const ipc = new FakeIpc()
    ipc.careRead = {
      status: 'current',
      summary: {
        schemaVersion: 1,
        revision: 3,
        xp: 75,
        meals: 3,
        streakDays: 2,
        unlocked: ['nightOwl'],
        days: [{ day: '2026-09-16', completions: 1, tokens: null }],
        reportedTokens: 4200,
        unreportedRuns: 1,
        lastSettledAt: 1_789_000_000_000,
      },
    }

    const read = await createTauriPetConnection({ ipc }).care()

    expect(read).toBe(ipc.careRead)
    expect(ipc.calls.map(([name]) => name)).toEqual(['care'])
  })
})

describe('the care summary is the ledger’s own shape', () => {
  /**
   * `R`'s source, read as text: a rename there is the failure this test exists to catch, and the
   * test cannot import a Rust file.
   */
  function ledgerStruct(name: string, until?: string): string[] {
    const rust = readFileSync(
      resolve(__dirname, '../../../src-tauri/src/desktop_pet/care_ledger.rs'),
      'utf8',
    )
    const from = rust.indexOf(`pub struct ${name} {`)
    expect(from, `${name} is not declared in care_ledger.rs`).toBeGreaterThan(-1)
    const to = until === undefined ? rust.length : rust.indexOf(`pub struct ${until} {`, from)
    const body = rust.slice(from, to === -1 ? rust.length : to)
    return [...body.matchAll(/pub (\w+):/g)].map(([, field]) =>
      // serde's `rename_all = "camelCase"`, applied to the ledger's own snake_case declaration.
      field.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
    )
  }

  /** The fields a TypeScript interface declares, in the order it declares them. */
  function declaredFields(file: string, from: string, until: string): string[] {
    const source = readFileSync(resolve(__dirname, file), 'utf8')
    const start = source.indexOf(from)
    expect(start, `${from} is not declared in ${file}`).toBeGreaterThan(-1)
    const end = source.indexOf(until, start)
    return [...source.slice(start, end === -1 ? source.length : end)
      .matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)\??:/gm)].map(([, field]) => field)
  }

  it('declares the fields the ledger serializes, and no second vocabulary', () => {
    // §9, across a wire: the adapter hands the host's answer on without reshaping it, so a field
    // renamed in `care_ledger.rs` arrives as `undefined` and the care panel draws its defaults — a
    // number that stopped arriving, silently, because the panel's input is a `Partial`. The Rust
    // side is pinned by `the_summary_carries_what_was_settled_and_no_level_and_no_price`; this is
    // the other end of the same claim, read off both files rather than copied from one of them.
    expect(declaredFields('./pet-contracts/care.ts', 'export interface PetCareSummary {', 'export type PetCareRead'))
      .toEqual(ledgerStruct('CareSummary', 'CareDayRow'))
    expect(declaredFields('./pet-contracts/care.ts', 'export interface PetCareDay {', 'export interface PetCareSummary {'))
      .toEqual(ledgerStruct('CareDayRow'))
  })
})

/** Every call a port received, in order, with its arguments. */
type Call = [name: string, args: unknown[]]

class FakeIpc implements PetIpc {
  readonly calls: Call[] = []
  readonly featureListeners = new Set<(state: PetFeatureState) => void>()
  readonly taskListeners = new Set<(tasks: PetTaskProjection[]) => void>()
  readonly settingsListeners = new Set<(change: PetSettingsChange) => void>()
  taskReadFails: string | null = null
  /**
   * What the host answers for care. The empty arm by default, because that is what a host that has
   * settled nothing answers — and the read is a pass-through, which is what the test below says.
   */
  careRead: PetCareRead = { status: 'empty' }

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

  async care(): Promise<PetCareRead> {
    this.record('care')
    return this.careRead
  }

  async openSettings(page: string): Promise<void> {
    this.record('openSettings', page)
  }

  async tasks(): Promise<PetTaskProjection[]> {
    this.record('tasks')
    if (this.taskReadFails) throw new Error(this.taskReadFails)
    return []
  }

  async appearance(): Promise<PetAppearance> {
    this.record('appearance')
    // `unset` is the arm a fresh install answers, and the arm that has nothing to convert — so a
    // pass-through test below can assert the read reached the connection unchanged.
    return { status: 'unset' }
  }

  async library(): Promise<PetCharacterEntry[]> {
    this.record('library')
    return []
  }

  async importCharacter(): Promise<PetCharacterEntry | null> {
    this.record('importCharacter')
    return null
  }

  async catalogue(): Promise<PetCatalogueReading> {
    this.record('catalogue')
    return { status: 'unconfigured' }
  }

  async adoptCharacter(slug: string): Promise<PetCharacterEntry> {
    this.record('adoptCharacter', slug)
    return {
      characterId: slug,
      packName: slug,
      kind: 'remote',
      files: 'intact',
      installedAtMs: 1,
    }
  }

  async openTask(key: PetTaskKey): Promise<void> {
    this.record('openTask', key)
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

  async onSettingsChanged(onChange: (change: PetSettingsChange) => void): Promise<() => void> {
    this.record('onSettingsChanged')
    this.settingsListeners.add(onChange)
    return () => {
      this.record('offSettingsChanged')
      this.settingsListeners.delete(onChange)
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

  it('passes the window’s own reads through, and converts nothing but a ready sheet', async () => {
    const ipc = new FakeIpc()
    const connection = createTauriPetConnection({ ipc })

    // The four calls the window and the settings page make beside D1's surface: each is handed to
    // the port unchanged, which is what makes the *adapter* the only place the wire is spelled.
    await expect(connection.appearance()).resolves.toEqual({ status: 'unset' })
    await expect(connection.library()).resolves.toEqual([])
    await expect(connection.importCharacter()).resolves.toBeNull()
    const key = {
      agentId: 'a',
      profileId: 'p',
      runtimeEpoch: 'epoch-1',
      vaultId: 'v',
      sessionId: 'ses-1',
      runId: 'run-0',
    }
    await connection.openTask(key)

    expect(ipc.calls.map(([name]) => name)).toEqual([
      'appearance',
      'library',
      'importCharacter',
      'openTask',
    ])
    expect(ipc.calls[3][1]).toEqual([key])
  })

  it('listens for a settings change without a first read, and stops on unsubscribe', async () => {
    const ipc = new FakeIpc()
    const connection = createTauriPetConnection({ ipc })
    const seen: PetSettingsChange[] = []

    // A change is a notification, not a state: there is no "current value" to deliver first, and
    // the state a listener wants is the one its own `appearance` read already answers.
    const stop = await connection.subscribeSettings((change) => seen.push(change))
    for (const listener of ipc.settingsListeners) listener({ domain: 'character', revision: 2 })
    stop()

    expect(seen).toEqual([{ domain: 'character', revision: 2 }])
    expect(ipc.calls.map(([name]) => name)).toEqual(['onSettingsChanged', 'offSettingsChanged'])
    expect(ipc.settingsListeners.size).toBe(0)
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
