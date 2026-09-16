/**
 * The settings: independent schemas, each versioned and each with explicit defaults
 * (§5.3).
 *
 * Independent because they change for different reasons and at different speeds, and
 * because §5.3 forbids threading one untyped object through every component: a
 * restore-default action on one page must not silently reset another, and a form that
 * does not know what it is editing cannot validate what it writes.
 *
 * Nothing here imports anything. A settings schema that knew about a task or a window
 * would be a schema that cannot be validated on its own, which is what a versioned
 * record exists to allow.
 */

/**
 * §5.3's independent schemas. Each is versioned and defaulted on its own, because
 * they change for different reasons and at different speeds: a restore-default action
 * on one page must not silently reset another, and one untyped object threaded through
 * every component is what §5.3 forbids.
 *
 * §5.1's 高级与集成 page is deliberately not a domain here. Its contents are the
 * external-monitor, cloud and ranking features, which §10 puts in their own sub-plans
 * pending a privacy and service review; giving them a schema now would be shipping a
 * shape for a feature that has not been agreed.
 */
export const PET_SETTINGS_DOMAINS = [
  'general',
  'character',
  'view',
  'message',
  'notification',
  'care',
  'project',
] as const

export type PetSettingsDomain = (typeof PET_SETTINGS_DOMAINS)[number]

/** Every roaming mode the setting may hold. §7.2 decides which ones a machine can use. */
export type PetRoamMode = 'off' | 'stay' | 'follow-pointer' | 'climb'

/** One value per domain, and the source of the record types below. */
export interface PetSettingsValues {
  general: {
    /**
     * §5.1's 启用, and §4's rollback: turning this off stops the pet and cancels
     * nothing else — no agent task, no note save, and no character, care progress or
     * history is deleted. The switch exists for the people who do not want a pet at
     * all, so it defaults on and turns the feature *off*; §7.1's explicit opt-in
     * requirement is about the pet staying resident after its window is closed, which
     * is a different switch from whether the pet exists.
     */
    enabled: boolean
    /**
     * §5.2's Reduce-motion rule, and the reason there is no third value: the pet may
     * follow the host or reduce further, and never the reverse. A `'full'` option
     * would be a setting that cancels a system-wide accessibility choice.
     */
    motion: 'system' | 'reduced'
  }
  character: {
    /**
     * The chosen character, by id. §5.3 keeps identifiers here and the assets in a
     * managed data directory, so a settings write can never be a large blob.
     */
    characterId: string | null
    /** Rendered size in px. Upstream's unclamped `160 * size` (`main.ts:115-117`) is why this is a rule. */
    size: number
  }
  view: {
    /** Window opacity. Upstream feeds a stored value straight into an `rgba` alpha (`main.ts:93`). */
    opacity: number
    /** §7.2 verifies this per desktop; the setting may hold `true` where the capability cannot deliver it. */
    alwaysOnTop: boolean
    /**
     * The roaming mode the user chose. Kept representable even where the capability is
     * not: a profile follows the user between machines, and §5.2 disables the *modes*
     * the platform cannot do rather than rewriting the user's setting behind their back.
     */
    roam: PetRoamMode
  }
  message: {
    /** §6.3's suggested bubble life. */
    bubbleSeconds: number
    /** The bubble's theme, following the host unless locally overridden (§5.2). */
    theme: 'system' | 'light' | 'dark'
  }
  notification: {
    onTurnFinished: boolean
    onStopped: boolean
    onFailed: boolean
    onWaitingInput: boolean
    sound: boolean
    doNotDisturb: boolean
    /**
     * Whether a notification may name the task. Off by default because §6.3 requires
     * titles to carry no note content and no paths unless the user asks for them — a
     * default is the only place that rule can be enforced for users who never open
     * the settings page.
     */
    showTaskTitle: boolean
  }
  care: {
    enabled: boolean
    /** §8: rest reminders are switchable on their own. */
    restReminders: boolean
  }
  project: {
    /** §7.1's cap: three by default, five by explicit configuration. */
    maxCharacters: number
  }
}

/** The defaults §5.3 requires each schema to state outright. */
export const PET_SETTINGS_DEFAULTS: { [D in PetSettingsDomain]: PetSettingsValues[D] } = {
  general: { enabled: true, motion: 'system' },
  character: { characterId: null, size: 160 },
  view: { opacity: 1, alwaysOnTop: true, roam: 'off' },
  message: { bubbleSeconds: 6, theme: 'system' },
  notification: {
    onTurnFinished: true,
    onStopped: true,
    onFailed: true,
    onWaitingInput: true,
    sound: true,
    doNotDisturb: false,
    showTaskTitle: false,
  },
  care: { enabled: true, restReminders: true },
  project: { maxCharacters: 3 },
}

/** A numeric field of {@link PetSettingsValues}, as a `domain.field` path. */
export type PetNumberField =
  | 'character.size'
  | 'view.opacity'
  | 'message.bubbleSeconds'
  | 'project.maxCharacters'

/** What a stored number has to satisfy, and what it becomes when it does not. */
export interface PetNumberRule {
  min: number
  max: number
  integer: boolean
  /** The value a stored number outside the rule is replaced by, decided once here (§5.3). */
  fallback: number
}

/**
 * The rules, keyed by field. One table because §5.3 requires the interface and the
 * backend to apply the *same* rule, and a rule that exists in two places is a rule
 * that agrees until the day it does not.
 */
export const PET_NUMBER_RULES = {
  'character.size': { min: 64, max: 320, integer: true, fallback: 160 },
  'view.opacity': { min: 0.15, max: 1, integer: false, fallback: 1 },
  'message.bubbleSeconds': { min: 1, max: 60, integer: true, fallback: 6 },
  'project.maxCharacters': { min: 1, max: 5, integer: true, fallback: 3 },
} satisfies Record<PetNumberField, PetNumberRule>

/**
 * A stored number, or the rule's fallback.
 *
 * Finiteness is checked before the range because the two failures come from different
 * places and only one of them is a range error: upstream clamps the range but reads
 * the value with `parseInt` and no finiteness guard
 * (`windows/src/roam/types.ts:112`), so a stored `"fast"` becomes a `NaN` speed that
 * reaches the physics; and `parseInt(...) || 100` (`windows/src/main.ts:115`) turns a
 * stored `0` into `100`, which is a fallback chosen by JavaScript's truthiness rather
 * than by anyone.
 */
export function readPetNumber(raw: unknown, rule: PetNumberRule): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return rule.fallback
  if (raw < rule.min || raw > rule.max) return rule.fallback
  if (rule.integer && !Number.isInteger(raw)) return rule.fallback
  return raw
}

/** One domain's values, with the version they were written under and the revision they are at. */
export type PetSettingsRecord = {
  [D in PetSettingsDomain]: {
    domain: D
    schemaVersion: number
    revision: number
    values: PetSettingsValues[D]
  }
}[PetSettingsDomain]

/** One domain's write. The revision is what the writer read, and nothing else (§5.3). */
export type PetSettingsWrite = {
  [D in PetSettingsDomain]: {
    domain: D
    revision: number
    values: PetSettingsValues[D]
  }
}[PetSettingsDomain]

/** The schema version this build writes. */
export const PET_SETTINGS_SCHEMA_VERSION = 1

/**
 * What reading a domain produced.
 *
 * The four arms are four different things the caller has to do, which is why they are
 * not a record with a flag: `defaults` and `migrated` may be written back, `current`
 * need not be, and `read-only` must not be — §10.2 requires a build that meets a
 * newer schema to leave it alone rather than overwrite it with guesses.
 */
export type PetSettingsLoad =
  | { status: 'current'; record: PetSettingsRecord }
  | {
      status: 'migrated'
      record: PetSettingsRecord
      fromVersion: number
      /**
       * Dotted paths whose stored value could not be used and took its rule's fallback.
       * Reported rather than applied silently, so a field the user set can be shown to
       * have been repaired instead of quietly reading as something they never chose.
       */
      repaired: string[]
    }
  | { status: 'defaults'; reason: 'absent' | 'unreadable'; record: PetSettingsRecord }
  | { status: 'read-only'; reason: 'schema-newer'; foundVersion: number }

/**
 * What writing a domain produced.
 *
 * `conflict` is §5.3's cross-window rule: a write based on a revision that is no longer
 * current is refused, and the caller reloads — it never merges, because merging a stale
 * form into a fresh one is how a value the user just changed on another page is
 * undone. `failed` exists so a write that could not be persisted is neither reported as
 * success nor turned into an exception the caller might treat as a bug; the edited
 * value stays with the caller and the write stays retryable.
 */
export type PetSettingsUpdate =
  | { status: 'applied'; record: PetSettingsRecord }
  | { status: 'conflict'; current: PetSettingsRecord }
  | { status: 'refused'; reason: 'invalid-value' | 'schema-newer'; message: string }
  | { status: 'failed'; message: string }

/**
 * §5.1's settings sub-pages, which the pet names when it asks the host to open the
 * main window on one of them.
 *
 * Not the same list as {@link PetSettingsDomain}: a page is a place a person goes and
 * a domain is a schema, and the two happen to differ here — the page called 气泡与消息
 * holds the `message` domain beside parts of `view`, and 高级与集成 has no schema of
 * its own yet. A caller naming a page therefore cannot accidentally name a schema, and
 * neither has to be kept in step with the other.
 */
export const PET_SETTINGS_PAGES = [
  'general',
  'character',
  'bubble',
  'notification',
  'care',
  'project',
  'advanced',
] as const

export type PetSettingsPage = (typeof PET_SETTINGS_PAGES)[number]

/**
 * The section id the settings navigation has to declare (§10.1 adds it to
 * `features/settings/types.ts`, which this task does not own). It is named here so the
 * pet never spells it out itself; a mismatch is caught by the integration check in D12
 * rather than by a right-click that opens nothing.
 */
export const PET_SETTINGS_SECTION = 'desktop-pet'
