/**
 * The surface the application calls, and the two shapes it reads back.
 *
 * It sits apart from the vocabulary it is built from because it changes for a different
 * reason: when *who talks to whom* changes, not when a state or a setting is added. The
 * pet window cannot start, cancel or re-send a task, and no method here deletes
 * anything — §6.1's single source of truth and §4's rollback, expressed as an interface.
 */
import type {
  PetSettingsDomain,
  PetSettingsLoad,
  PetSettingsPage,
  PetSettingsUpdate,
  PetSettingsWrite,
} from './config'
import type { PetCapabilityReport } from './platform'
import type { PetTaskKey, PetTaskState } from './task'

/**
 * Whether the feature is on, and whether a pet is on screen right now.
 *
 * Two fields and not one, because §5.1 lists 启用 and 显示 apart and they have
 * different consequences: "the feature is off" means no window, no animation, no
 * timers — and, per §7.1, still no cancelled agent task — while "hidden" is a pet that
 * is running with its drawing stopped and its reminders intact. Collapsing them would
 * make a temporary hide indistinguishable from a disable, and the user's way back
 * would be the wrong one.
 */
export interface PetFeatureState {
  enabled: boolean
  /** Meaningful only while enabled; a disabled feature has nothing to show. */
  visible: boolean
}

/** One task as the host hands it to a window. */
export interface PetTaskProjection {
  key: PetTaskKey
  state: PetTaskState
  /** See {@link PetTaskOutcome.permissionRequestId}: an id to route with, never something to answer with. */
  permissionRequestId: string | null
  /** Host clock, in epoch ms. Injected rather than read (§10.2) so coalescing windows are testable. */
  updatedAt: number
}

/**
 * What the application calls.
 *
 * Every method reads or changes what the *host* knows; none of them reaches an agent,
 * and none can start, cancel or re-send a task. That is §6.1's single source of truth
 * expressed as an interface: the pet window cannot influence a run, so it cannot
 * become a second place where a run's life is decided.
 *
 * No method deletes anything. §4's rollback is the settings switch, and characters,
 * care progress and history outlive it — an erase affordance reachable from a window
 * that is being torn down would be unrecoverable for the user who switches the pet
 * back on.
 */
export interface PetGateway {
  /** The switch, and whether anything is showing. */
  feature(): Promise<PetFeatureState>
  /**
   * Hide or show the pet, returning the state the host ended up in.
   *
   * It returns the state rather than nothing because a request to show a disabled
   * feature does not do anything, and the caller has to be able to tell: the answer is
   * the same channel the truth comes back on, instead of a silent no-op that looks
   * like success.
   */
  setVisible(visible: boolean): Promise<PetFeatureState>
  /** What this machine was verified to do, each with what happens where it cannot (§7.2). */
  capabilities(): Promise<PetCapabilityReport[]>
  /**
   * Every task the pet shows.
   *
   * The order is not part of the contract: §6.3's ranking — attention needed, then
   * working, then a brief completion, then idle — is a display rule computed from
   * `state` and `updatedAt`, and fixing it here would put a display decision in the
   * host.
   */
  tasks(): Promise<PetTaskProjection[]>
  /** Call `onTasks` with the current list now, and on every change after that. Resolves with the unsubscribe. */
  subscribe(onTasks: (tasks: PetTaskProjection[]) => void): Promise<() => void>
  /** Read one domain, and the revision a write has to be based on. */
  readSettings(domain: PetSettingsDomain): Promise<PetSettingsLoad>
  /** Write one domain, refused when the revision it was based on has moved on (§5.3). */
  updateSettings(write: PetSettingsWrite): Promise<PetSettingsUpdate>
  /**
   * Ask the host to bring the main window up focused on a settings page (§5.1). The
   * pet names a page and never a window, a label or a URL: §7.1 gives the host the
   * window identity, and a front end that could choose one could choose the wrong one.
   */
  openSettings(page: PetSettingsPage): Promise<void>
}
