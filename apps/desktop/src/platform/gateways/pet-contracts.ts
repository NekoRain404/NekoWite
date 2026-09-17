/**
 * The desktop pet's neutral model — the public entry point.
 *
 * This path is the one every other task imports, so the split behind it is an
 * implementation detail. The pieces are divided by what they are about, the way
 * `./agent-contracts` divides its own:
 *
 *  - `pet-contracts/task.ts`       what a task is: its identity key and its states
 *  - `pet-contracts/events.ts`     what an ACP event, snapshot or loss means for one
 *  - `pet-contracts/config.ts`     the seven settings schemas, versioned and defaulted
 *  - `pet-contracts/platform.ts`   what this machine can do, and what is done instead
 *  - `pet-contracts/care.ts`       what the ledger settled, and the two answers a read has
 *  - `pet-contracts/appearance.ts` the character: what the library holds, and what is drawn
 *  - `pet-contracts/gateway.ts`    the calls the app makes, and the shapes it reads back
 *
 * It is a *projection* contract, not a second source of truth. The ACP contract is where
 * a run's identity, its events and its result are defined; this file's modules reuse
 * those types and add only what a pet needs on top of them — so there is no pet-shaped
 * `sessionId`, no parallel event envelope, and no second way to say "this turn ended"
 * (§6.1).
 *
 * Three things here are structural rather than documented, because a rule that lives
 * only in prose is a rule the next component can forget:
 *
 *  - **There is no `done`.** §6.2's rows are the facts a user sees, and "the turn
 *    stopped" is not one of them: a run that hit a token ceiling, one that was refused,
 *    one the user cancelled and one whose runtime died are four different facts, so no
 *    single success state exists for them to be folded into. The tables in `events.ts`
 *    are total over the ACP kinds, stop reasons and failure codes, so a new one is a
 *    compile error rather than a case that quietly falls through to a default.
 *  - **A capability that is not available cannot be reported without saying what is
 *    done instead** (`platform.ts`). §7.2 requires a missing capability to be *stated*.
 *  - **Nothing here can delete what the user made.** §4's rollback is "turn the feature
 *    off", and characters, care progress and history survive it. This surface has no
 *    erase operation at all — not a settings one and not a lifecycle one — because the
 *    affordance that looks tidy in a teardown path is the one that is unrecoverable for
 *    the user when they switch the pet back on.
 *
 * Names are re-exported one by one rather than with `export *`, the way
 * `./agent-contracts` does it: this is a contract, so what it offers should be a list
 * somebody chose, and a name that disappears from it should be a failing typecheck
 * rather than a silent absence.
 */

export {
  PET_ALERT_BY_STATE,
  PET_TASK_STATES,
  isPetTaskKey,
  isPetTaskSettled,
  petKeyToken,
  petTaskToken,
  samePetTask,
} from './pet-contracts/task'
export type { PetTaskAlert, PetTaskKey, PetTaskOutcome, PetTaskState } from './pet-contracts/task'

export {
  isRuntimeLoss,
  petOutcomeFromEvent,
  petOutcomeFromRuntimeLoss,
  petOutcomeFromSessionState,
  petOutcomeFromSnapshot,
  petStateFromFailure,
} from './pet-contracts/events'
export type { PetRuntimeLoss } from './pet-contracts/events'

export {
  PET_NUMBER_RULES,
  PET_SETTINGS_DEFAULTS,
  PET_SETTINGS_DOMAINS,
  PET_SETTINGS_PAGES,
  PET_SETTINGS_SCHEMA_VERSION,
  PET_SETTINGS_SECTION,
  readPetNumber,
} from './pet-contracts/config'
export type {
  PetAgentIcons,
  PetBubbleDot,
  PetBubbleFilter,
  PetBubbleGrouping,
  PetBubbleMode,
  PetBubbleSeparator,
  PetBubbleTokenEntry,
  PetClipBindings,
  PetIdleMode,
  PetLeftClick,
  PetNumberField,
  PetNumberRule,
  PetPhraseTheme,
  PetRoamMode,
  PetSettingsDomain,
  PetSettingsLoad,
  PetSettingsPage,
  PetSettingsRecord,
  PetSettingsUpdate,
  PetSettingsValues,
  PetSettingsWrite,
} from './pet-contracts/config'

export { PET_CAPABILITIES } from './pet-contracts/platform'
export type {
  PetCapability,
  PetCapabilityFinding,
  PetCapabilityReport,
  PetFallback,
} from './pet-contracts/platform'

export type { PetCareDay, PetCareRead, PetCareSummary } from './pet-contracts/care'

export { isPetCatalogueReading } from './pet-contracts/catalogue'
export type {
  PetCatalogueOffer,
  PetCatalogueReading,
} from './pet-contracts/catalogue'

export { isPetAppearance } from './pet-contracts/appearance'
export type {
  PetAppearance,
  PetCharacterEntry,
  PetSettingsChange,
} from './pet-contracts/appearance'

export type {
  PetFeatureState,
  PetGateway,
  PetTaskProjection,
  PetWindowGateway,
} from './pet-contracts/gateway'
