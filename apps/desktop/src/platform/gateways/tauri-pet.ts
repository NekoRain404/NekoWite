/**
 * The pet's real adapter: one call per backend command, one channel per push, and nothing else.
 *
 * This is the only file in the pet that imports a Tauri API. §6.1's rule is a direction rather
 * than a preference — the window sees a `PetGateway` and no JSON-RPC — so the layers above are
 * written against {@link PetIpc} and can be driven by a fake one in a test, while the argument
 * shapes the renderer actually sends stay here, in one table, where a wrong key is one line to
 * find instead of one per method.
 *
 * ## The argument shapes, and why they are spelled this way
 *
 * `@tauri-apps/api` passes the arguments object **verbatim** — no case conversion — and a
 * `#[tauri::command]` without `rename_all = "snake_case"` deserializes its parameters from
 * camelCase keys. That is the opposite of the convention the fs commands use (they declare
 * `rename_all = "snake_case"` and take `vault_root`), and the difference is not cosmetic: a key in
 * the wrong case makes an invoke reject, which reads exactly like the command not existing. Every
 * key below is the camelCase spelling of the Rust parameter it must land on — `characterId` for
 * `character_id` — spelled from the declarations in `commands/desktop_pet.rs`, not from this
 * file's idea of them. `tauri-pet.test.ts` asserts each of the nine against a table of its own.
 *
 * ## Which of these the backend has
 *
 * Every call here has a `#[tauri::command]` behind it. The window half of §7.1 (state, the window
 * list, open, disable, show/hide, close-own, click-through), the settings deep link, the care
 * read, the settings read and write, the task list and the appearance read all exist on the Rust
 * side; the three channels are `listen` registrations rather than calls.
 *
 * **`desktop_pet_tasks` was the one call that had nothing behind it, and that is why this file is
 * the place the failure was found.** A rejected read here is not a missing first payload: the
 * subscription releases its listener and rethrows, so a window mounted against a host that could
 * not answer looked like a pet with no work rather than a pet that could not see. The state it
 * reads now exists (`desktop_pet/task_feed.rs`), fed from the runtime's own frames, and the two
 * lines it needs in `lib.rs` are reported rather than assumed — a command that is not registered
 * is answered by Tauri itself with "command … not found", which names the missing call without an
 * error code invented to say so. That is the same choice `tauri-agent/ipc.ts` documents for the
 * session half of the agent's IPC.
 */

import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isPetAppearance, isPetCatalogueReading } from './pet-contracts'
import type {
  PetAppearance,
  PetCapabilityReport,
  PetCareRead,
  PetCatalogueReading,
  PetCharacterEntry,
  PetFeatureState,
  PetGateway,
  PetSettingsChange,
  PetSettingsDomain,
  PetSettingsLoad,
  PetSettingsPage,
  PetSettingsUpdate,
  PetSettingsWrite,
  PetTaskKey,
  PetTaskProjection,
} from './pet-contracts'

/**
 * The channel the host publishes feature-state changes on.
 *
 * `commands/desktop_pet.rs` declares the same string; the two spellings are one decision. It is
 * the answer to the gap the window host reported: `feature()` answers when asked, and this is how
 * a window learns that the answer changed while it was not asking — which is what makes §7.1's
 * 「无托盘的 Linux 环境仍能从主设置恢复隐藏桌宠」 true rather than eventual.
 *
 * Named like the app's other channels (`fs-change`, `ai-chunk`, `agent-event`): a hyphenated,
 * lowercase noun for the thing the payload is about.
 */
export const PET_FEATURE_CHANNEL = 'pet-feature'

/** The channel the host publishes the task list on. `desktop_pet/task_feed.rs` is its publisher. */
export const PET_TASKS_CHANNEL = 'pet-task'

/**
 * The channel an applied settings write is published on.
 *
 * The gap it closes is the same shape as the one the feature channel closed: the pet window draws
 * the character the `character` domain names, and a user changing that character in the main
 * window's settings had no way to reach a window that was already open. It is *not* the same
 * channel as `PET_SETTINGS_CHANNEL` below, which is the deep link the other way — one is a
 * request a pet window makes, this is news it receives.
 */
export const PET_SETTINGS_CHANGED_CHANNEL = 'pet-settings-changed'

/**
 * The channel a click on a task reaches the main window on (§6.2's 点击返回任务).
 *
 * Emitted by `desktop_pet_open_task` to the `main` window, carrying D1's `PetTaskKey` and nothing
 * else. The receiving half is `platform/pet-task-request.ts`, and it was *not* when this comment
 * first said so: the path did not exist, so a click raised the window and emitted an event nobody
 * heard — a name asserting a wiring state that was not so, which this repository keeps finding. It
 * is now a file that exists and a listener `app/pet-task-link.ts` attaches, which is the difference
 * between the two ways of closing the gap.
 */
export const PET_TASK_OPEN_CHANNEL = 'pet-open-task'

/**
 * The channel a pet window's 设置 lands on in the main window.
 *
 * The payload is `{ page }`: the section is named once, in TypeScript, by
 * `PET_SETTINGS_SECTION`, so the host does not carry a second spelling of it.
 */
export const PET_SETTINGS_CHANNEL = 'pet-open-settings'

/**
 * One character window, as the host describes it.
 *
 * `label` is the host's own and is here to be *read*, never sent: no command takes a window, so a
 * caller that has a label has nothing it can do with it (§7.1's 「前端不能自选任意 label」).
 */
export interface PetWindowInfo {
  id: number
  label: string
  characterId: string
}

/** What one close did. */
export interface PetClosedWindow {
  label: string
  characterId: string
}

/**
 * What tearing the pet down did.
 *
 * Both fields describe a *window*, which is the claim: §7.1's 「禁用桌宠销毁动画/监听/计时器，不
 * 取消后台 Agent 任务」 and §4's 「不关闭不影响 Agent 工作、笔记保存与原设置页」. There is no field
 * here for a cancelled run, a deleted character or a cleared ledger, because the host has no way
 * to produce one.
 */
export interface PetTeardownReport {
  closed: PetClosedWindow[]
  failed: { reason: string; [field: string]: unknown }[]
}

/** What the host refused, in the shape `HostRefusal` serializes to. */
export interface PetHostRefusal {
  reason: 'unrecognized-caller' | 'cap-reached' | 'window'
  [field: string]: unknown
}

/**
 * The backend, as this adapter uses it.
 *
 * A port rather than a set of free functions so the gateway can be exercised without a Tauri
 * runtime: `createTauriPetIpc` is the only implementation that talks to the window's IPC, and a
 * test hands the gateway its own.
 */
export interface PetIpc {
  state(): Promise<PetFeatureState>
  windows(): Promise<PetWindowInfo[]>
  open(characterId: string): Promise<PetWindowInfo>
  disable(): Promise<PetTeardownReport>
  setVisible(visible: boolean): Promise<PetFeatureState>
  /** Close the window that is calling. Only a pet window may; the main window is refused. */
  closeOwn(): Promise<PetClosedWindow>
  setClickThrough(ignore: boolean): Promise<void>
  capabilities(): Promise<PetCapabilityReport[]>
  openSettings(page: PetSettingsPage): Promise<void>
  care(): Promise<PetCareRead>
  tasks(): Promise<PetTaskProjection[]>
  appearance(): Promise<PetAppearance>
  library(): Promise<PetCharacterEntry[]>
  importCharacter(): Promise<PetCharacterEntry | null>
  catalogue(): Promise<PetCatalogueReading>
  adoptCharacter(slug: string): Promise<PetCharacterEntry>
  openTask(key: PetTaskKey): Promise<void>
  readSettings(domain: PetSettingsDomain): Promise<PetSettingsLoad>
  updateSettings(write: PetSettingsWrite): Promise<PetSettingsUpdate>
  /** Register a listener. Resolves with the removal of *that* registration. */
  onFeature(onState: (state: PetFeatureState) => void): Promise<() => void>
  onTasks(onTasks: (tasks: PetTaskProjection[]) => void): Promise<() => void>
  onSettingsChanged(onChange: (change: PetSettingsChange) => void): Promise<() => void>
}

export function createTauriPetIpc(): PetIpc {
  return {
    state: () => invoke<PetFeatureState>('desktop_pet_state'),
    windows: () => invoke<PetWindowInfo[]>('desktop_pet_windows'),
    open: (characterId) => invoke<PetWindowInfo>('desktop_pet_open', { characterId }),
    disable: () => invoke<PetTeardownReport>('desktop_pet_disable'),
    setVisible: (visible) => invoke<PetFeatureState>('desktop_pet_set_visible', { visible }),
    closeOwn: () => invoke<PetClosedWindow>('desktop_pet_close_own'),
    setClickThrough: (ignore) =>
      invoke<void>('desktop_pet_set_click_through', { ignore }),
    capabilities: () => invoke<PetCapabilityReport[]>('desktop_pet_capabilities'),
    openSettings: (page) => invoke<void>('desktop_pet_open_settings', { page }),
    care: () => invoke<PetCareRead>('desktop_pet_care_read'),
    tasks: () => invoke<PetTaskProjection[]>('desktop_pet_tasks'),
    appearance: async () => {
      const read = await invoke<PetAppearance>('desktop_pet_appearance')
      // The one place a host path becomes a URL, and it is here rather than in a component for
      // the reason every other argument shape is: `asset://` is how a webview reads a file the
      // host granted, and a component that built one would be a second way to name a file. A
      // `ready` read is the only arm that has a path at all — and the only one this touches: an
      // answer that is not an appearance is handed on as it came, for the caller to state, rather
      // than read here for a `status` it does not have.
      return isPetAppearance(read) && read.status === 'ready'
        ? { ...read, sheetPath: convertFileSrc(read.sheetPath) }
        : read
    },
    library: () => invoke<PetCharacterEntry[]>('desktop_pet_library'),
    importCharacter: () => invoke<PetCharacterEntry | null>('desktop_pet_import_character'),
    catalogue: async () => {
      const read = await invoke<PetCatalogueReading>('desktop_pet_catalogue')
      // Re-read here rather than trusted, the way the appearance arm above re-reads its
      // own answer: a frame that is not a reading is answered with the `unreadable` arm —
      // which is true, and is what the page has a notice for — instead of being handed on
      // for a caller to read a `status` it does not have.
      return isPetCatalogueReading(read) ? read : { status: 'unreadable', detail: 'the host answered with something that is not a catalogue' }
    },
    adoptCharacter: (slug) => invoke<PetCharacterEntry>('desktop_pet_adopt_character', { slug }),
    openTask: (key) => invoke<void>('desktop_pet_open_task', { task: key }),
    readSettings: (domain) => invoke<PetSettingsLoad>('desktop_pet_read_settings', { domain }),
    updateSettings: (write) => invoke<PetSettingsUpdate>('desktop_pet_update_settings', { write }),
    onFeature: (onState) =>
      listen<PetFeatureState>(PET_FEATURE_CHANNEL, (event) => onState(event.payload)),
    onTasks: (onTasks) =>
      listen<PetTaskProjection[]>(PET_TASKS_CHANNEL, (event) => onTasks(event.payload)),
    onSettingsChanged: (onChange) =>
      listen<PetSettingsChange>(PET_SETTINGS_CHANGED_CHANNEL, (event) => onChange(event.payload)),
  }
}

/**
 * The host connection: D1's `PetGateway`, plus the window operations a gateway has no room for.
 *
 * The extras are the pet's *lifecycle* — creating a character window, tearing them all down and
 * closing the one that is calling — plus click-through, and none of them are on `PetGateway`. That
 * interface is what a settings page and a bubble are handed, and §4's rollback is defined as "the
 * switch, which deletes nothing": an object that could be handed to a page and could also close
 * every window would put the teardown one call away from the thing the teardown must not touch.
 * The composition (§10.1) is what holds this narrower object, and it hands the pages only the
 * gateway half.
 *
 * Click-through is the one of the four that the *window* needs rather than the composition, so it
 * is also on `PetWindowGateway` — see that interface for why it is not a teardown. Nothing here
 * changes: this object is what the entry hands the pet window, and it carries every operation
 * either port names.
 */
export interface PetHostConnection extends PetGateway {
  /** The feature state, and whether anything is showing. Same as `PetGateway.feature`. */
  state(): Promise<PetFeatureState>
  /** Every character window the host has open. Read-only: a label is never an argument. */
  windows(): Promise<PetWindowInfo[]>
  /** §7.1's 按需创建: create the window for a character, or return the one already showing it. */
  openCharacter(characterId: string): Promise<PetWindowInfo>
  /** The feature switch going off: every window closes, and the report says which. */
  disable(): Promise<PetTeardownReport>
  /** Close the window that is calling. Refused for any other window. */
  closeOwn(): Promise<PetClosedWindow>
  /**
   * §7.2's pass-through, system half, on the window that is calling.
   *
   * The same operation `PetWindowGateway` declares, and one implementation of it: the window asks
   * and the host reads the caller off the window the IPC arrived from.
   */
  setClickThrough(ignore: boolean): Promise<void>
  /**
   * Hear that a settings domain was written, wherever the write came from.
   *
   * The pet window draws from settings, and the settings page is another window: without this the
   * only way to learn that the character changed would be to ask again on a timer, which is the
   * polling this feature's own rule refuses. A change carries the domain and the revision, so a
   * listener re-reads what it draws and nothing else.
   *
   * Deliberately *not* on `PetGateway`, unlike `subscribeFeature`: a settings page already holds
   * the record it is editing, and the only consumer of this channel is the window that has no
   * other way to hear.
   */
  subscribeSettings(onChange: (change: PetSettingsChange) => void): Promise<() => void>
}

export interface TauriPetOptions {
  /** The IPC port, for a test that wants to drive the adapter without a window. */
  ipc?: PetIpc
}

export function createTauriPetConnection(options: TauriPetOptions = {}): PetHostConnection {
  const ipc = options.ipc ?? createTauriPetIpc()
  return {
    state: () => ipc.state(),
    windows: () => ipc.windows(),
    openCharacter: (characterId) => ipc.open(characterId),
    disable: () => ipc.disable(),
    closeOwn: () => ipc.closeOwn(),
    setClickThrough: (ignore) => ipc.setClickThrough(ignore),

    feature: () => ipc.state(),
    setVisible: (visible) => ipc.setVisible(visible),
    capabilities: () => ipc.capabilities(),
    care: () => ipc.care(),
    tasks: () => ipc.tasks(),
    appearance: () => ipc.appearance(),
    library: () => ipc.library(),
    importCharacter: () => ipc.importCharacter(),
    catalogue: () => ipc.catalogue(),
    adoptCharacter: (slug) => ipc.adoptCharacter(slug),
    openTask: (key) => ipc.openTask(key),
    readSettings: (domain) => ipc.readSettings(domain),
    updateSettings: (write) => ipc.updateSettings(write),
    openSettings: (page) => ipc.openSettings(page),

    // A pure notification, and the one subscription with no first read: a *change* has no current
    // value to deliver, and the state a listener would want is the one its own `appearance` read
    // already answers. Listen-only is therefore not an omission here, the way it would be for the
    // task list.
    subscribeSettings: (onChange) => ipc.onSettingsChanged(onChange),

    async subscribe(onTasks: (tasks: PetTaskProjection[]) => void) {
      // Listen first, then read, so a frame that lands between the two is delivered twice rather
      // than lost. The list is complete every time, so a duplicate is the same answer twice —
      // which is what makes the ordering a choice and not a race.
      const stop = await ipc.onTasks(onTasks)
      try {
        onTasks(await ipc.tasks())
      } catch (cause) {
        // The first read is what a window mounting now needs (§6.2's snapshot-before-subscribe
        // rule), so a host that cannot answer it is not silently given an empty list: the
        // subscription is released and the refusal is the caller's to state.
        stop()
        throw cause
      }
      return stop
    },

    async subscribeFeature(onFeature: (state: PetFeatureState) => void) {
      const stop = await ipc.onFeature(onFeature)
      try {
        onFeature(await ipc.state())
      } catch (cause) {
        stop()
        throw cause
      }
      return stop
    },
  }
}

/**
 * D1's `PetGateway` over the host connection, for the callers that take the narrower interface.
 *
 * A view of the same object rather than a second one: the settings pages get a `PetGateway`, and
 * the lifecycle operations stay on the connection the composition holds.
 */
export function createTauriPetGateway(options: TauriPetOptions = {}): PetGateway {
  return createTauriPetConnection(options)
}
