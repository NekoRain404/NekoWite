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
 * Every call here has a `#[tauri::command]` behind it except the task list. The window half of
 * §7.1 (state, the window list, open, disable, show/hide, close-own, click-through), the settings
 * deep link, the care read and the settings read and write all exist on the Rust side; the two
 * channels are `listen` registrations rather than calls. What does not exist is
 * `desktop_pet_tasks`: no state in this process holds D4's projection yet, so no command is
 * invented for it, and a window that calls it is answered by Tauri itself — "command
 * desktop_pet_tasks not found" — which names the call that is missing and needs no error code
 * invented to say so.
 *
 * The settings pair used to be the same answer arriving from the other end — the commands were
 * written and their two lines in `lib.rs`'s handler list were owed — and those lines have since
 * landed, so `desktop_pet_read_settings` and `desktop_pet_update_settings` answer. What that buys
 * the user is the master switch: an applied `general.enabled` is what opens the pet's window
 * (`commands/desktop_pet.rs`'s `apply_feature_switch`). This file does not paper over the one
 * remaining gap — the seam is the seam, and a call nothing answers is left to be refused by Tauri
 * rather than given a stub. That is the same choice `tauri-agent/ipc.ts` documents for the session
 * half of the agent's IPC.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  PetCapabilityReport,
  PetCareRead,
  PetFeatureState,
  PetGateway,
  PetSettingsDomain,
  PetSettingsLoad,
  PetSettingsPage,
  PetSettingsUpdate,
  PetSettingsWrite,
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

/** The channel the host publishes the task list on. D4's Rust side is its publisher. */
export const PET_TASKS_CHANNEL = 'pet-task'

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
  readSettings(domain: PetSettingsDomain): Promise<PetSettingsLoad>
  updateSettings(write: PetSettingsWrite): Promise<PetSettingsUpdate>
  /** Register a listener. Resolves with the removal of *that* registration. */
  onFeature(onState: (state: PetFeatureState) => void): Promise<() => void>
  onTasks(onTasks: (tasks: PetTaskProjection[]) => void): Promise<() => void>
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
    readSettings: (domain) => invoke<PetSettingsLoad>('desktop_pet_read_settings', { domain }),
    updateSettings: (write) => invoke<PetSettingsUpdate>('desktop_pet_update_settings', { write }),
    onFeature: (onState) =>
      listen<PetFeatureState>(PET_FEATURE_CHANNEL, (event) => onState(event.payload)),
    onTasks: (onTasks) =>
      listen<PetTaskProjection[]>(PET_TASKS_CHANNEL, (event) => onTasks(event.payload)),
  }
}

/**
 * The host connection: D1's `PetGateway`, plus the window operations a gateway has no room for.
 *
 * The extra five are the pet's *lifecycle* — creating a character window, tearing them all down,
 * closing the one that is calling, and click-through — and they are deliberately not on
 * `PetGateway`. That interface is what a settings page and a bubble are handed, and §4's rollback
 * is defined as "the switch, which deletes nothing": an object that could be handed to a page and
 * could also close every window would put the teardown one call away from the thing the teardown
 * must not touch. The composition (§10.1) is what holds this narrower object, and it hands the
 * pages only the gateway half.
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
  /** §7.2's pass-through, system half, on the window that is calling. */
  setClickThrough(ignore: boolean): Promise<void>
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
    readSettings: (domain) => ipc.readSettings(domain),
    updateSettings: (write) => ipc.updateSettings(write),
    openSettings: (page) => ipc.openSettings(page),

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
