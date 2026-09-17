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

/**
 * What the pet does with the idle playlist: pick any clip in it, or walk it in order
 * (upstream `ap_idle_mode`, `settings.ts:1179`).
 */
export type PetIdleMode = 'random' | 'sequential'

/**
 * How the bubble arranges several tasks at once, and whether they are headed by their
 * agent (upstream `ap_bub_mode` and `ap_bub_grouping`, `settings.html:367,374`).
 *
 * The member *names* are the renderer's (`features/desktop-pet/services/pet-bubble-layout.ts`
 * draws `list`/`compact`/`carousel` and `by-agent`/`flat`), not upstream's literals
 * (`byKind`/`all`): one choice spelled once is what keeps the control and the surface
 * from disagreeing about what the user picked.
 */
export type PetBubbleMode = 'list' | 'compact' | 'carousel'
export type PetBubbleGrouping = 'by-agent' | 'flat'

/**
 * Which tasks the bubble keeps (upstream `ap_bub_filter`, `settings.html:383`).
 *
 * Upstream's four options name *states* (`doneAndAbove`, `workingAndWaiting`); these name
 * what the filter does to a row's alert, so a state added to the contract's union does not
 * leave a filter that quietly means something else.
 */
export type PetBubbleFilter = 'all' | 'attention' | 'active' | 'working'

/**
 * The character drawn between a row's fields (upstream `ap_bub_sep`, `settings.html:184`).
 *
 * A closed set of *names* rather than the four characters themselves: upstream's fourth
 * button is a single space, and a stored space is a separator no reader can tell from a
 * value that was trimmed away. The name is the choice; the character it draws is the
 * renderer's.
 */
export type PetBubbleSeparator = 'dot' | 'arrow' | 'bar' | 'space'

/** How a row's state dot is drawn (upstream `ap_bub_dot`, `settings.html:191`). */
export type PetBubbleDot = 'plain' | 'claude'

/**
 * The wording the pet reaches for while something is happening (upstream
 * `ap_theme_phrases`, `settings.html:441`). A vocabulary and not a phrase: the lines
 * themselves are the phrase pools' own (`pet-message-template.ts`), and §5.2 keeps a
 * written line from claiming a state the row is not in.
 */
export type PetPhraseTheme = 'chef' | 'engineer' | 'wizard' | 'explorer' | 'scientist'

/**
 * What a left-click on the pet does (upstream `ap_left_click_action`, `settings.html:202`).
 *
 * `self` and `all` are upstream's 「This pet」 and 「All pets」; the distinction is a
 * multi-character one, so both are representable before the second character lands.
 */
export type PetLeftClick = 'none' | 'self' | 'all'

/**
 * The sprite-sheet row the pet plays for a mood, keyed by mood (upstream `ap_bind_<mood>`,
 * `settings.ts:1197`).
 *
 * The keys are open, like `stateRows`' own in `animation-bindings.ts`: the host state a
 * binding is looked up by is a string there, and a build that closes this set here would
 * be refusing a mood it will learn to draw next release. The *values* are the bounded
 * side — a row both halves agree on, because an out-of-grid row is the "arbitrary frame"
 * §5.2 says must fall back rather than be read.
 */
export type PetClipBindings = Readonly<Record<string, number>>

/**
 * One field of a bubble row, and whether it is shown (upstream `ap_bub_tokens`,
 * `settings.ts:976-1010`; the renderer's `PetBubbleTokenItem` has this shape).
 *
 * `token` is an open name for the same reason a binding's key is: the row fields are the
 * renderer's vocabulary (`PET_BUBBLE_TOKENS`), and a settings schema that declared its own
 * copy of it would be the second truth §9 forbids. A name no renderer knows is dropped by
 * the renderer, which is where the vocabulary lives.
 */
export interface PetBubbleTokenEntry {
  token: string
  visible: boolean
}

/**
 * The icon drawn beside an agent's rows, keyed by agent id (upstream `ap_icon_<agentKind>`,
 * `settings.ts:1092`).
 *
 * Keyed by agent id — an engine's own kind — so §5.2's 「兼容未知 Agent」 holds at the
 * storage layer too: an id no registry knows is an icon for an engine this build has not
 * heard of, not a value to reject. The value is upstream's own spec form
 * (`brand:<kind>` or `sym:<name>`); which of them this build can draw is the renderer's
 * question, and today's answer is that nothing draws one yet.
 */
export type PetAgentIcons = Readonly<Record<string, string>>

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
     *
     * It is the master gate and not one of the two windows: with this off there is no
     * pet window at all, whichever way `characterWindow` and `ball` are set. Each
     * window then follows its *own* switch on top of this one — the rule is one
     * sentence, read in one place (`feature_switch.rs`), so that the page's control
     * and the host's read cannot disagree about what a field means.
     */
    enabled: boolean
    /**
     * §5.2's Reduce-motion rule, and the reason there is no third value: the pet may
     * follow the host or reduce further, and never the reverse. A `'full'` option
     * would be a setting that cancels a system-wide accessibility choice.
     */
    motion: 'system' | 'reduced'
    /**
     * §5.1's 悬浮球: whether the floating ball's window is one of the pet's.
     *
     * It defaults on, which is what upstream's own stored flag means (`read_ball_visible`'s
     * `unwrap_or(true)`) and what this app did before the field existed — the switch makes
     * the existing behaviour a choice rather than changing it. Upstream's own
     * 「Show floating ball」 row (`windows/settings.html:50-52`) is what this ports: the ball
     * follows *this* flag and nothing else, so it is still there when the character's window
     * is not. `enabled` remains the master gate above it.
     */
    ball: boolean
    /**
     * §5.1's 显示角色窗口 / the plan's 「主角色显示」 — upstream's 「Show main pet」
     * (`windows/settings.html:69-71`, applied by `set_pet_visible`, `src-tauri/src/lib.rs:613-623`),
     * which is a port and not an addition: upstream can show the ball without the character,
     * which is exactly what that row exists to allow.
     *
     * It decides whether the pet's *character* window exists, and it is the second of the two
     * per-window switches beside `ball` — neither of them is a master switch. It defaults on,
     * which is what upstream's own `checked` means and what this build did before the field
     * existed, so a stored record read by this build opens exactly the windows it opened
     * before. Off with `ball` on is the choice the pair exists for: 「只开悬浮球」.
     */
    characterWindow: boolean
  }
  character: {
    /**
     * The chosen character, by id. §5.3 keeps identifiers here and the assets in a
     * managed data directory, so a settings write can never be a large blob.
     */
    characterId: string | null
    /** Rendered size in px. Upstream's unclamped `160 * size` (`main.ts:115-117`) is why this is a rule. */
    size: number
    /** The row each mood plays, on top of the sheet's own mapping (`animation-bindings.ts`). */
    bindings: PetClipBindings
    /**
     * The clips the idle mood cycles through, in order (upstream `ap_idle_clips`). Empty
     * is a real value and not a missing one: the playlist is off, which is how upstream's
     * `startIdleCycling` reads an empty list too (`pet.ts:215`).
     */
    idleClips: readonly number[]
    idleMode: PetIdleMode
    /**
     * How long one idle clip stays on screen, in seconds (upstream `ap_idle_interval`,
     * `settings.ts:1180`). Seconds and not milliseconds because that is the unit the
     * control counts in; converting once, at the renderer's edge, is what keeps the stored
     * value the one the user typed.
     */
    idleIntervalSeconds: number
  }
  view: {
    /**
     * §7.2 verifies this per desktop; the setting may hold `true` where the capability cannot deliver it.
     *
     * Not a migrated upstream setting: upstream hardcodes `.always_on_top(true)` at all four of its
     * window builders (`references/desktop-pet/windows/src-tauri/src/lib.rs:295,368,463,557`) and its
     * settings page has no such row. It is this port's own §7.2 gate around a preference, and
     * `window_host` is what applies it.
     */
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
    /** The text size in px (upstream `ap_font_size`, three buttons at 10/12/14). */
    fontSize: number
    /**
     * The bubble's background alpha (upstream `ap_opacity`).
     *
     * **The bubble's, and not the window's.** Upstream's `applyBubble` feeds this value straight
     * into `--bubble-bg`'s `rgba(…, op)` alpha and returns, leaving every other surface alone
     * (`references/desktop-pet/windows/src/main.ts:88-100`, control at `settings.html:172-173` on
     * the Bubble page), and the ledger and the plan file the key under 气泡与消息
     * (`desktop-pet-port-ledger.md:112`, plan §5.2 「Bubble：主题、透明度、字体……」).
     *
     * It is filed here for that reason, and it is *not* a window opacity: upstream has no such
     * setting, and this build has no way to honour one — `tauri`/`tao` expose no window-opacity call
     * at all, so a control filed that way could only write a value nothing reads.
     */
    opacity: number
    /**
     * Whether the pet chatters while nothing is happening (upstream `ap_idle`,
     * rendered on the bubble page as 「Show idle message」, `settings.html:176`).
     *
     * Filed on `message` rather than on `character`, where the ledger's table puts it:
     * the row is a bubble-behaviour switch, and the page that draws it is 气泡与消息.
     */
    idle: boolean
    layoutMode: PetBubbleMode
    /** How many rows the surface shows at once (upstream `ap_bub_max`, `settings.html:380`). */
    layoutMaxRows: number
    grouping: PetBubbleGrouping
    /** Whether the rows are ordered by their agent (upstream `ap_bub_sortkind`). */
    sortByKind: boolean
    filter: PetBubbleFilter
    separator: PetBubbleSeparator
    dot: PetBubbleDot
    phraseTheme: PetPhraseTheme
    leftClick: PetLeftClick
    /**
     * The agents whose rows are not drawn (upstream `ap_bub_hidden`, `settings.ts:962`).
     *
     * §5.2 requires the list to be built 「从当前 Agent 注册表」 rather than from upstream's
     * fixed names; what is stored is the *choice*, so an id stays meaningful after the
     * engine it names is installed again — which is why an unknown id is kept and not
     * repaired away.
     */
    hiddenAgents: readonly string[]
    /** The row's fields and their order. Empty means the renderer's own preset (§5.2's 预设). */
    tokens: readonly PetBubbleTokenEntry[]
    /**
     * The pool a quick bubble is drawn from, one line each (upstream `ap_quick_bubbles`,
     * `settings.ts:1771`).
     *
     * Empty by default where upstream seeds five English lines (`QUICK_DEFAULTS`): those
     * are words the *pet* would say, and putting them in the user's mouth before they asked
     * is not a default this schema should decide. A page may offer them as a reset.
     */
    quickBubbles: readonly string[]
    agentIcons: PetAgentIcons
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
  general: { enabled: true, motion: 'system', ball: true, characterWindow: true },
  character: {
    characterId: null,
    size: 160,
    // Empty rather than upstream's own mapping (`STATE_ROW`): the sheet's defaults live in
    // `animation-bindings.ts`, and a binding map that repeated them here would be a second
    // copy of the spritesheet layout to keep in step.
    bindings: {},
    idleClips: [],
    idleMode: 'random',
    idleIntervalSeconds: 5,
  },
  view: { alwaysOnTop: true, roam: 'off' },
  message: {
    bubbleSeconds: 6,
    theme: 'system',
    fontSize: 12,
    // Upstream's own default (`ap_opacity`'s `|| 92` in `main.ts:93`): 92% of the bubble's own
    // background colour, which is what its slider opens on.
    opacity: 0.92,
    idle: true,
    layoutMode: 'list',
    layoutMaxRows: 5,
    grouping: 'by-agent',
    sortByKind: false,
    filter: 'all',
    separator: 'dot',
    dot: 'plain',
    phraseTheme: 'chef',
    leftClick: 'none',
    hiddenAgents: [],
    tokens: [],
    quickBubbles: [],
    agentIcons: {},
  },
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
  | 'character.idleIntervalSeconds'
  | 'message.bubbleSeconds'
  | 'message.opacity'
  | 'message.fontSize'
  | 'message.layoutMaxRows'
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
  // Upstream's own floor and default (`MIN_IDLE_INTERVAL_MS` and `DEFAULT_IDLE_INTERVAL` in
  // `animation-bindings.ts`), with the ceiling a minute: a clip that changes less often than
  // that is a still image with a timer attached.
  'character.idleIntervalSeconds': { min: 1, max: 60, integer: true, fallback: 5 },
  // Upstream's own slider ends, 60 to 100 percent (`settings.html:172`, `main.ts:93`), kept as the
  // fraction the alpha is: the floor is why a stored value cannot leave a bubble whose text is
  // unreadable, and the default is the value that slider opens on.
  'message.opacity': { min: 0.6, max: 1, integer: false, fallback: 0.92 },
  'message.bubbleSeconds': { min: 1, max: 60, integer: true, fallback: 6 },
  // Upstream's three buttons are 10/12/14 and it accepts any parsed integer
  // (`settings.ts:1051`); the rule keeps upstream's span and refuses everything outside it,
  // so the sizes between the buttons stay representable for a fine-grained control later.
  'message.fontSize': { min: 10, max: 14, integer: true, fallback: 12 },
  // Upstream's slider is 1–10 with a default of 5 (`settings.html:380`, `settings.ts:957`).
  'message.layoutMaxRows': { min: 1, max: 10, integer: true, fallback: 5 },
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

/**
 * The schema version this build writes.
 *
 * 2 is 1 plus the animation, phrase and layout fields the ledger's remaining rows needed
 * (D7d). 3 is 2 plus `general.characterWindow`, the second of the pet's two per-window
 * switches. The bump is what makes §10.2's rule do its work in the other direction: a build
 * that only knows the older version meets the newer record, reports `read-only` and leaves it
 * alone, instead of reading the fields it recognises, defaulting the ones it does not and
 * writing that back over what the user chose — which for a field like `characterWindow` would
 * bring back a window they had switched off.
 */
export const PET_SETTINGS_SCHEMA_VERSION = 3

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
