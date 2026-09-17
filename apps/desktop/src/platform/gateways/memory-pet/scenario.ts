/**
 * What a test asks the double for, and what it gets back.
 *
 * Kept apart from the machinery that carries these out (`./host`, `./settings`) and from
 * the gateway that exposes them (`../memory-pet`) because this is the part a test author
 * reads first, and the part that has to stay complete: a state a test cannot reach is a
 * state no view can be written against.
 *
 * It also holds §7.2's third column as a table, because on a host that has measured
 * nothing *every* capability is unavailable, which makes stating a fallback the default
 * scenario rather than an edge case.
 */
import type { AgentFailureCode } from '../agent-contracts'
import type {
  PetCapability,
  PetCapabilityFinding,
  PetCareSummary,
  PetCatalogueReading,
  PetCharacterEntry,
  PetFallback,
  PetHostAppearance,
  PetTaskKey,
  PetTaskProjection,
} from '../pet-contracts'

/** The vault the double's runs happen in, matching the agent double's demo vault. */
export const MEMORY_PET_VAULT = 'memoir://demo'

/** The agent and profile the double's own runs belong to. Tests that need a second
 *  agent hand `ingest` a frame carrying its identity instead. */
export const MEMORY_PET_AGENT = 'memory'
export const MEMORY_PET_PROFILE = 'default'

/**
 * The runtime instance this host serves. A frame carrying another epoch is a frame from
 * a runtime that is over — what a queue, a restart or a reconnect leaves behind — and it
 * is not applied, for the reason `memory-agent` refuses a handle whose epoch has been
 * superseded.
 */
export const MEMORY_PET_EPOCH = 'epoch-1'

/**
 * §7.2's third column, once: what is done where a capability cannot be used.
 *
 * A table rather than a sentence per capability because it has to be the *default* as
 * well: nothing on a machine that has never been measured is available, and a report
 * has to be able to say what happens instead for every one of them (§7.2 「不伪装已支持」).
 */
const CAPABILITY_FALLBACK: { [C in PetCapability]: PetFallback } = {
  'window-transparency': 'docked-window',
  'window-borderless': 'closable-window',
  'always-on-top': 'closable-window',
  'no-focus-steal': 'closable-window',
  drag: 'clamped-position',
  'position-restore': 'clamped-position',
  'pointer-passthrough': 'compact-window',
  'pointer-follow': 'stay-only',
  'window-climb': 'not-offered',
  'system-notification': 'unread-list',
  'notification-actions': 'unread-list',
}

const UNVERIFIED_DETAIL =
  'not verified on this host yet; §12 records the measured matrix before release'

/**
 * The unverified default, as a value with a declared type so the status stays literal.
 * Exported because the gateway composing this scenario is a different module now: the
 * fallback a capability gets when nothing has been measured belongs beside the table it
 * comes from, not beside the map that adds up the findings.
 */
export function unverified(capability: PetCapability): PetCapabilityFinding {
  return {
    status: 'unverified',
    fallback: CAPABILITY_FALLBACK[capability],
    detail: UNVERIFIED_DETAIL,
  }
}

/**
 * How one frame sat in the stream the host receives.
 *
 * Reported rather than acted on: §6.3's ledger is what decides that a replay must not
 * notify twice or that a gap means restoring from a snapshot, and it can only make
 * those decisions badly if the layer below has already thrown the evidence away.
 */
export interface PetFrameOrder {
  /** The sequence the runtime assigned to the frame. */
  sequence: number
  /**
   * The sequence numbers that never arrived, between the last uninterrupted run of
   * frames this host had and this one. Non-empty means what the host holds was built on
   * a stream with a hole in it.
   */
  missing: number[]
}

/** What the host did with one frame. One arm per fate, each carrying what it has. */
export type PetIngestOutcome =
  /** A pet fact, filed under the task the frame named. */
  | { status: 'applied'; key: PetTaskKey; order: PetFrameOrder; task: PetTaskProjection }
  /** Received and counted, but this kind says nothing about a task's state. */
  | { status: 'no-change'; key: PetTaskKey; order: PetFrameOrder }
  /** A pet fact for a run that already ended: §6.2's terminal states are not revived. */
  | { status: 'settled'; key: PetTaskKey; order: PetFrameOrder; detail: string }
  /** This sequence was already accepted, so it was not applied a second time. */
  | { status: 'replayed'; key: PetTaskKey; order: PetFrameOrder }
  /** From a runtime instance this host is not serving, or about no run at all. */
  | { status: 'foreign'; key: PetTaskKey | null; order: PetFrameOrder; detail: string }
  /** Not a valid event: the ACP validator refused it before the pet saw anything. */
  | { status: 'rejected'; code: AgentFailureCode; message: string }

/** What one scripted run needs. */
export interface MemoryRunOptions {
  vaultId?: string
  /**
   * Reuse a session to model a later turn of one conversation. §6.3 requires the new
   * turn to carry a new run id, which is what keeps it a second task rather than a
   * revival of the first.
   */
  sessionId?: string
}

export interface MemoryPetOptions {
  /** The clock, injected rather than read (§10.2), so coalescing windows are testable. */
  now?: () => number
  /**
   * What this host reports for the capabilities it names. Everything not named stays
   * unverified with its fallback stated — the honest default for a host that has
   * measured nothing, and the one that keeps §7.2's "say what happens instead" on the
   * path a test walks by default.
   */
  capabilities?: { [C in PetCapability]?: PetCapabilityFinding }
  /** Whether a pet is showing to begin with. */
  visible?: boolean
  /** How many of the next settings writes fail, so a save failure is demonstrable (§5.3). */
  writeFailures?: number
  /**
   * The schema version the stored settings claim, so the two cases a real install
   * meets are reachable: newer data this build must not overwrite (§10.2), and older
   * data that has to be migrated.
   */
  storedSchemaVersion?: number
  /**
   * What the care ledger has settled, or nothing at all.
   *
   * The double has no ledger and settles nothing — settlement is `care_ledger.rs`'s, and a
   * second implementation of it here would be a second answer to what one run pays (§9). What it
   * has is the *read*: absent means the host answers `empty`, which is what a host nothing has
   * settled into answers, and a summary means it answers `current` with exactly those totals.
   */
  care?: PetCareSummary
  /**
   * The characters the double's library holds, and the sentence an import is refused with.
   *
   * The library is what `library()` answers and what `appearance()` resolves the stored
   * `characterId` against, so the three arms of an appearance — nothing chosen, a choice that
   * cannot be honoured, a sheet to draw — are all reachable by what a test installs and selects.
   */
  characters?: readonly PetCharacterEntry[]
  importRefusal?: string
  /**
   * What the double's catalogue answers, and the sentence a download is refused with.
   *
   * Absent means the double answers the `unconfigured` arm, which is what this build answered
   * before there was a catalogue and is the honest default for a double that has no network. A
   * `listed` reading makes the gallery reachable; `adoptRefusal` makes the download path's failure
   * reachable, which is the half a page has to be able to draw.
   */
  catalogue?: PetCatalogueReading
  adoptRefusal?: string
  /**
   * What the *app* has published about its own appearance (§1's 「保留现有主题、强调色」).
   *
   * The double's stand-in for the host's relay: the real one is filled by
   * `desktop_pet_publish_host_appearance`, which the app window calls, and a page reads it through
   * `hostAppearance()`. Absent is the fresh-install state — a read that carries nothing, which the
   * page's own reader turns into the app's defaults — and `publishHostAppearance` changes it while
   * a window is mounted, which is the case the channel exists for.
   */
  hostAppearance?: PetHostAppearance
}
