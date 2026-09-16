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
  type PetCapabilityReport,
  type PetFeatureState,
  type PetGateway,
  type PetRuntimeLoss,
  type PetSettingsDomain,
  type PetSettingsLoad,
  type PetSettingsPage,
  type PetSettingsUpdate,
  type PetSettingsWrite,
  type PetTaskKey,
  type PetTaskProjection,
} from './pet-contracts'
import { createPetTaskHost } from './memory-pet/host'
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

export interface MemoryPetGateway extends PetGateway {
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
}

export function createMemoryPetGateway(options: MemoryPetOptions = {}): MemoryPetGateway {
  const host = createPetTaskHost({ epoch: MEMORY_PET_EPOCH, now: options.now ?? Date.now })
  const settings = createPetSettingsDouble(options)
  const declared = options.capabilities ?? {}
  const opened: PetSettingsPage[] = []
  let visible = options.visible ?? false

  function featureState(): PetFeatureState {
    return { enabled: settings.enabled(), visible: settings.enabled() && visible }
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
      return featureState()
    },

    async capabilities(): Promise<PetCapabilityReport[]> {
      return PET_CAPABILITIES.map((capability) => ({
        capability,
        finding: declared[capability] ?? unverified(capability),
      }))
    },

    async tasks() {
      return host.tasks()
    },

    async subscribe(onTasks: (tasks: PetTaskProjection[]) => void) {
      return host.subscribe(onTasks)
    },

    async readSettings(domain: PetSettingsDomain): Promise<PetSettingsLoad> {
      return settings.read(domain)
    },

    async updateSettings(write: PetSettingsWrite): Promise<PetSettingsUpdate> {
      return settings.write(write)
    },

    async openSettings(page: PetSettingsPage) {
      opened.push(page)
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
  }
}
