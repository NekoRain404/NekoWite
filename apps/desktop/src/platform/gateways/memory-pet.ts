/**
 * The in-memory pet gateway: a host a test drives by hand.
 *
 * It exists so the pet's states can be written and tested with no window, no
 * notification and no runtime — and, more to the point, so the awkward cases are
 * *representable*: a run that reached a token ceiling, one that was refused, one the
 * user cancelled, a runtime that died mid-run, a permission nobody answered, a frame
 * that arrived twice or out of order, a frame from a runtime instance that is over, and
 * two tasks that both have to stay visible. A view layer can only be written against
 * states a double can actually produce.
 *
 * This path is what a test imports; the pieces behind it are divided by what they are
 * about, the way `memory-agent.ts` divides its own:
 *
 *  - `memory-pet/scenario.ts`   what a test asks for and gets back, and §7.2's fallbacks
 *  - `memory-pet/host.ts`       the tasks it tracks and the frames it receives
 *  - `memory-pet/settings.ts`   the one path that writes a settings domain
 *  - `memory-pet/characters.ts` the library it holds, and what a window would draw from it
 *
 * What is left here is the composition and the surface: the double's own protocol, on
 * top of the `PetGateway` the real adapter also implements, so the two stay
 * interchangeable.
 */
import type {
  AgentFailureCode,
  AgentStopReason,
} from './agent-contracts'
import {
  PET_CAPABILITIES,
  type PetAppearance,
  type PetCapabilityReport,
  type PetCareRead,
  type PetCatalogueReading,
  type PetCharacterEntry,
  type PetFeatureState,
  type PetHostAppearance,
  type PetRuntimeLoss,
  type PetSettingsChange,
  type PetSettingsDomain,
  type PetSettingsLoad,
  type PetSettingsPage,
  type PetSettingsUpdate,
  type PetSettingsWrite,
  type PetTaskKey,
  type PetTaskProjection,
  type PetWindowGateway,
} from './pet-contracts'
import { createPetTaskHost } from './memory-pet/host'
import { createPetCharacterDouble } from './memory-pet/characters'
import { createPetSettingsDouble } from './memory-pet/settings'
import {
  MEMORY_PET_EPOCH,
  unverified,
  type MemoryPetOptions,
  type MemoryRunOptions,
  type PetFrameOrder,
  type PetIngestOutcome,
} from './memory-pet/scenario'

export {
  MEMORY_PET_AGENT,
  MEMORY_PET_EPOCH,
  MEMORY_PET_PROFILE,
  MEMORY_PET_VAULT,
} from './memory-pet/scenario'
export type { MemoryPetOptions, MemoryRunOptions, PetFrameOrder, PetIngestOutcome }

export interface MemoryPetGateway extends PetWindowGateway {
  /** Begin a run the host is tracking; resolves to the key it is filed under. */
  startRun(options?: MemoryRunOptions): PetTaskKey
  /** End the run in flight the way the engine's `run-finished` does. */
  finishRun(key: PetTaskKey, stopReason: AgentStopReason): PetIngestOutcome
  /** Fail the run the way a runtime that is still there reports it. */
  failRun(key: PetTaskKey, code: AgentFailureCode): PetIngestOutcome
  /** Suspend the run on a permission the user has to answer in the host's own UI. */
  requestPermission(key: PetTaskKey, requestId: string): PetIngestOutcome
  /** The host lost the runtime. Resolves to the tasks it had to restate (§6.2's last row). */
  loseRuntime(loss: PetRuntimeLoss): PetTaskProjection[]
  /**
   * Deliver one frame as the host receives it. The frame still has to be a valid ACP
   * event; only its identity, its run and its sequence may be foreign, which is how a
   * replay, a gap and a stale runtime instance are produced.
   */
  ingest(frame: unknown): PetIngestOutcome
  /** The pages `openSettings` was asked for, so the routing §5.1 requires is assertable. */
  openedSettings(): readonly PetSettingsPage[]
  /** The tasks `openTask` was sent, so §6.2's click-to-the-session route is assertable. */
  openedTasks(): readonly PetTaskKey[]
  /**
   * Every input-region request the window made, in order, so §7.2's policy is assertable.
   *
   * A list rather than the current value: the interesting property is not where the window ended
   * up but that it *asked* — a window that never calls this and a window that calls it with the
   * compositor's own default look identical from the state alone, and that identity is the defect
   * this operation was added to remove.
   */
  clickThrough(): readonly boolean[]
  /**
   * The app published its own appearance, as the real flow's first hop does.
   *
   * `desktop_pet_publish_host_appearance` is a command the *app* calls (the host relays what it is
   * told to the windows it created), so a double that only answered a canned value could not show
   * the case the channel exists for: a window that is already mounted and has to follow a write
   * made in another one. Returns the value, like `setVisible`, so a test can assert what a page
   * would have read.
   */
  publishHostAppearance(appearance: PetHostAppearance): PetHostAppearance
}

export function createMemoryPetGateway(options: MemoryPetOptions = {}): MemoryPetGateway {
  const host = createPetTaskHost({ epoch: MEMORY_PET_EPOCH, now: options.now ?? Date.now })
  const settings = createPetSettingsDouble(options)
  // The library shares the settings double, so a page that chooses a character through the
  // gateway's own `updateSettings` is choosing the character the next `appearance()` answers with
  // — the flow this read exists for, and the one a test of "chosen, then drawn" drives.
  const characters = createPetCharacterDouble(options, settings)
  const declared = options.capabilities ?? {}
  const opened: PetSettingsPage[] = []
  const openedTasks: PetTaskKey[] = []
  const clickThroughRequests: boolean[] = []
  const featureListeners = new Set<(state: PetFeatureState) => void>()
  const settingsListeners = new Set<(change: PetSettingsChange) => void>()
  const hostAppearanceListeners = new Set<(appearance: PetHostAppearance) => void>()
  let visible = options.visible ?? false
  let hostAppearance: PetHostAppearance = { ...(options.hostAppearance ?? {}) }

  function featureState(): PetFeatureState {
    return { enabled: settings.enabled(), visible: settings.enabled() && visible }
  }

  /**
   * Tell every feature subscriber what the state is now.
   *
   * The whole state, not a delta, for the reason the contract gives: a subscriber that missed a
   * frame is stale rather than wrong. The double publishes from the two places a real host would
   * — its own `setVisible`, and a settings write that landed — so a window's behaviour under a
   * change made in another window is reachable from a test.
   */
  function publishFeature(): void {
    const state = featureState()
    for (const listener of featureListeners) listener(state)
  }

  /** One applied settings write, as the window that draws from settings hears it. */
  function publishSettingsChanged(change: PetSettingsChange): void {
    for (const listener of settingsListeners) listener(change)
  }

  /**
   * Tell every mounted window what the app's appearance is now — the whole appearance, not a
   * delta, for the reason every other channel here pushes whole states: a subscriber that missed
   * one is stale for a frame rather than wrong for ever.
   */
  function publishHostAppearanceChanged(next: PetHostAppearance): void {
    for (const listener of hostAppearanceListeners) listener(next)
  }

  return {
    async feature() {
      return featureState()
    },

    async setVisible(next: boolean) {
      // Showing a disabled pet is not something the host does, and it is not an error
      // either: the caller gets the resulting state back, so a request that did not
      // happen is visible as one rather than reported as success.
      visible = next
      publishFeature()
      return featureState()
    },

    async capabilities(): Promise<PetCapabilityReport[]> {
      return PET_CAPABILITIES.map((capability) => ({
        capability,
        finding: declared[capability] ?? unverified(capability),
      }))
    },

    async care(): Promise<PetCareRead> {
      // The double reports; it does not settle. `settle` is `care_ledger.rs`'s and is idempotent
      // per run key (§6.3's 「重复/乱序事件不增加 XP」), so a second implementation here would be a
      // second answer to what one completion pays — the thing §9 forbids. What a test drives with
      // this is the *read*: the two arms, and what a surface draws from each.
      return options.care ? { status: 'current', summary: options.care } : { status: 'empty' }
    },

    async tasks() {
      return host.tasks()
    },

    async subscribe(onTasks: (tasks: PetTaskProjection[]) => void) {
      return host.subscribe(onTasks)
    },

    async subscribeFeature(onFeature: (state: PetFeatureState) => void) {
      featureListeners.add(onFeature)
      // Delivered now, like the task subscription's first call: the current state is complete,
      // so there is no window between reading it and subscribing that needs a replay buffer.
      onFeature(featureState())
      return () => {
        featureListeners.delete(onFeature)
      }
    },

    async readSettings(domain: PetSettingsDomain): Promise<PetSettingsLoad> {
      return settings.read(domain)
    },

    async updateSettings(write: PetSettingsWrite): Promise<PetSettingsUpdate> {
      const update = settings.write(write)
      // The other window's route to the switch: a settings page that turns the pet on or off
      // writes the `general` domain, and the pet's own window has to hear it — that write is
      // what §7.1's way back *is*. Only an applied write publishes: a refused one left the state
      // where it was, and telling subscribers otherwise would make the window act on a change
      // that did not happen.
      if (update.status === 'applied') {
        // The window that draws from settings hears every applied write, whatever the domain —
        // the real host publishes the same frame (`commands/desktop_pet.rs`), and a subscriber
        // decides for itself which domains it draws from. Only an *applied* write: a refused or
        // conflicted one left the store where it was, and telling a listener otherwise would have
        // it re-read for a change that did not happen. The revision is the record's own, so a
        // listener sees the number the store is at rather than one this file computed.
        publishSettingsChanged({
          domain: update.record.domain,
          revision: update.record.revision,
        })
        if (write.domain === 'general') publishFeature()
      }
      return update
    },

    async subscribeSettings(onChange: (change: PetSettingsChange) => void) {
      settingsListeners.add(onChange)
      // Listen-only, exactly as the adapter is: a *change* has no current value to deliver, and
      // the state a subscriber wants is the one its own read already answers.
      return () => {
        settingsListeners.delete(onChange)
      }
    },

    async hostAppearance(): Promise<PetHostAppearance> {
      return hostAppearance
    },

    async subscribeHostAppearance(onChange: (appearance: PetHostAppearance) => void) {
      hostAppearanceListeners.add(onChange)
      // Listen-only, exactly as the adapter is: the value is what `hostAppearance()` answers, and
      // a change is news rather than a state — so there is no first delivery to make.
      return () => {
        hostAppearanceListeners.delete(onChange)
      }
    },

    async openSettings(page: PetSettingsPage) {
      opened.push(page)
    },

    async appearance(): Promise<PetAppearance> {
      return characters.appearance()
    },

    async library(): Promise<PetCharacterEntry[]> {
      return characters.library()
    },

    async importCharacter(): Promise<PetCharacterEntry | null> {
      // `null` is the user closing the picker, which no test drives: what it drives is an import
      // that happened, and an import the library refused (the option's sentence).
      return characters.importCharacter()
    },

    async catalogue(): Promise<PetCatalogueReading> {
      return characters.catalogue()
    },

    async adoptCharacter(slug: string): Promise<PetCharacterEntry> {
      // The refusal is a rejection and not a null, which is the shape the contract asks for: the
      // only `null` in this gateway is a dialog the user closed, and a failed download is not one.
      return characters.adoptCharacter(slug)
    },

    async openTask(key: PetTaskKey) {
      openedTasks.push(key)
    },

    async setClickThrough(ignore: boolean) {
      // Recorded and not applied: a double has no compositor to hold an input region, and the
      // claim worth asserting is that the window asked (§7.2) — the effect is the real window's.
      clickThroughRequests.push(ignore)
    },

    startRun: host.startRun,
    finishRun: host.finishRun,
    failRun: host.failRun,
    requestPermission: host.requestPermission,
    loseRuntime: host.loseRuntime,
    ingest: host.ingest,

    openedSettings() {
      return opened
    },

    openedTasks() {
      return openedTasks
    },

    clickThrough() {
      return clickThroughRequests
    },

    publishHostAppearance(next: PetHostAppearance) {
      hostAppearance = { ...next }
      publishHostAppearanceChanged(hostAppearance)
      return hostAppearance
    },
  }
}
