/**
 * The care rules: what a settled ledger means to a person, and nothing about how it got settled.
 *
 * Ported from `references/desktop-pet/windows/src/care.ts` (236 lines) at commit
 * `be171a01273a1ed92a27bcdf72f8a58768bac421`, which is a reachable subset of what upstream does in
 * two other places (`windows/src/main.ts` calls `feedTokens`/`recordMeal`; `state.ts` decides which
 * sessions finished). What came across is the *arithmetic*: the level curve `60·n·(n-1)` and its
 * display offset (`care.ts:87-101`), the five stages and their thresholds (`:103-114`), the level
 * progress bar's fraction (`:117-123`), the local day key (`:142-145`), the fourteen badges with
 * their names and icons (`:37-53`), and the hunger steps (`:130-138`).
 *
 * ## The seam with `R/src/desktop_pet/care_ledger.rs`
 *
 * §9 forbids one rule with two homes. **Settlement is the ledger's** — it is idempotent, it sees the
 * moment a run ended, and it is somewhere a window cannot write. **Meaning is this module's**: which
 * level a total is, how full the bar is, what a badge is called and which totals have crossed a
 * threshold are pure functions of the ledger's summary, so the side that draws them can compute them.
 *
 * The one vocabulary that exists on both sides is the badge list, because the ledger records ids and
 * this module names them. It is not duplicated by hand: `pet-care-rules.test.ts` reads
 * `care_ledger.rs` and fails if the two disagree, the way `desktop_pet_ipc_test/capabilities.rs`
 * reads `pet-contracts/platform.ts`.
 *
 * ## Three differences from upstream, each a rule rather than a style
 *
 *  - **Tokens do not pay.** Upstream's `TOKENS_PER_XP = 5_000` (`care.ts:6`) feeds the pet on the
 *    counts an engine reports, and `tokensToNextLevel` (`:125-128`) turns progress into one. §8
 *    requires settlement 「按实际可信完成事件」 and forbids reading an unknown count as zero, so a
 *    completion pays and a token count is *usage to show*. There is no XP-per-token constant in this
 *    repository, and `petCareLevels` cannot see a token count at all.
 *  - **A day is a local calendar day.** Upstream is already local (`care.ts:142-145`); what is new is
 *    that the rule is written down and the ledger stores the day it settled on rather than
 *    recomputing one from a timestamp later.
 *  - **Nothing here reads a clock.** Every function that needs the time takes it (§10.2's
 *    「参数注入时钟」), which is what makes the midnight cases in the test file assertions.
 *
 * ## What this module deliberately does not have
 *
 * No writer, no storage, no gateway and no network: no function here has a side effect, so a caller
 * that passes invented totals — a preview — gets a drawing and nothing else, because there is nothing
 * else here to get.
 */

/** The five steps the pet grows through. Names are the panel's (`PET_CARE_PANEL_LABELS.stages`). */
export const PET_CARE_STAGES = ['hatchling', 'companion', 'scout', 'hero', 'legend'] as const

export type PetCareStage = (typeof PET_CARE_STAGES)[number]

/**
 * The largest total this module will walk a level curve for.
 *
 * Upstream's `levelForXP` (`care.ts:92-96`) counts up one level at a time, so its cost is the square
 * root of the stored total: fine for a real one, and a frozen window for a value that arrived from a
 * file or a hand-edited store. The ceiling is far past any lifetime total (a million XP is level
 * ~129) and is applied before the walk, so the walk is bounded by construction.
 */
export const PET_CARE_XP_CEILING = 1_000_000_000

/** A stored XP total, as much as one can be trusted: finite, whole, non-negative, bounded. */
export function readPetCareXP(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 0
  return Math.min(Math.floor(raw), PET_CARE_XP_CEILING)
}

/**
 * Total XP to *reach* level `n` (`care.ts:87-90`, and `PetCare.swift` before it).
 *
 * Ported exactly, because it is a rule a stored profile was earned under: changing the curve
 * re-levels every user.
 */
export function petCareXPToReach(level: number): number {
  if (level <= 1) return 0
  return 60 * level * (level - 1)
}

/** The internal level for a total. Levels are 1-based; the *shown* one is one lower. */
export function petCareLevelForXP(xp: number): number {
  const total = readPetCareXP(xp)
  let level = 1
  while (petCareXPToReach(level + 1) <= total) level += 1
  return level
}

/** The level shown to the user (`care.ts:99-101`): the internal level minus one, floored. */
export function petCareDisplayLevel(xp: number): number {
  return Math.max(0, petCareLevelForXP(xp) - 1)
}

/** Which of the five stages a *displayed* level stands in (`care.ts:103-109`). */
export function petCareStageIndex(level: number): number {
  if (level < 5) return 0
  if (level < 10) return 1
  if (level < 20) return 2
  if (level < 35) return 3
  return 4
}

/** How full the level bar is, in 0..1 (`care.ts:117-123`). */
export function petCareLevelProgress(xp: number): number {
  const total = readPetCareXP(xp)
  const level = petCareLevelForXP(total)
  const floor = petCareXPToReach(level)
  const ceiling = petCareXPToReach(level + 1)
  if (ceiling <= floor) return 0
  return Math.min(1, Math.max(0, (total - floor) / (ceiling - floor)))
}

/** What a settled total means to a person. Every field is derived; none of them is stored. */
export interface PetCareLevels {
  /** The total the rest of this was computed from, after the read above. */
  xp: number
  /** The displayed level (`petCareDisplayLevel`). */
  level: number
  stage: PetCareStage
  stageIndex: number
  /** Fraction of the way through the current level, 0..1, and the XP still needed for the next. */
  progress: number
  toNextLevelXP: number
}

/**
 * What an import did to the ledger, as the surface that reports it reads it.
 *
 * The three arms and the field names are the ledger's own (`care_ledger.rs`'s `CareImportOutcome`);
 * what this adds is the shape a panel can walk. Mapping a serialized outcome onto it is the gateway's
 * job, deliberately not this module's: a rules file that parsed a wire format would be one that had
 * to change when the wire did.
 */
export interface PetCareImportReport {
  /** Fields the file raised, by their ids (see {@link PetCarePanelLabels.importFields}). */
  raised: readonly string[]
  /** Fields the ledger already had at or ahead of the file. Kept — nothing was lowered. */
  kept: readonly string[]
  /** Badges the file carried that the ledger did not have. Added, never removed. */
  badgesAdded: number
}

export type PetCareImportResult =
  | { status: 'merged'; report: PetCareImportReport }
  /** The ledger moved between the read and the import: nothing was written. */
  | { status: 'conflict'; currentRevision: number }
  /** Refused whole, with the ledger's own sentence for why. */
  | { status: 'refused'; detail: string }

/** The level readout for a total. */
export function petCareLevels(xp: unknown): PetCareLevels {
  const total = readPetCareXP(xp)
  const stageIndex = petCareStageIndex(petCareDisplayLevel(total))
  const level = petCareLevelForXP(total)
  return {
    xp: total,
    level: Math.max(0, level - 1),
    stage: PET_CARE_STAGES[stageIndex] as PetCareStage,
    stageIndex,
    progress: petCareLevelProgress(total),
    toNextLevelXP: Math.max(0, petCareXPToReach(level + 1) - total),
  }
}

/**
 * One day of the ledger's trailing window.
 *
 * `tokens` is nullable and that is the point: a day nobody reported usage for leaves `null`, a
 * reported zero leaves `0`, and a surface drawing them alike would be §8's 「token 未知不是 0」 broken
 * at the last step. `completions` is what pays, and it is always known.
 */
export interface PetCareDayTally {
  /** The local calendar day this tally belongs to, `YYYY-MM-DD`. */
  day: string
  /** Runs that finished on that day. */
  completions: number
  /** Usage the engine reported that day, or null when nothing reported any. */
  tokens: number | null
}

/** What the ledger hands over: settled totals, and nothing about how they were settled. */
export interface PetCareProgress {
  xp: number
  /** Completed runs that paid. */
  meals: number
  /** Consecutive days with a settled completion. */
  streakDays: number
  /** Badge ids the ledger has awarded. An id this build does not know is shown as itself. */
  /**
   * Badge ids the ledger recorded. Only the ones it cannot re-derive arrive here — the rest are
   * derived by {@link petCareEarnedAchievements} from the totals below, so one badge has one home.
   * An id this build cannot name is kept and shown as itself.
   */
  unlocked: readonly string[]
  /** The trailing window, oldest first. */
  days: readonly PetCareDayTally[]
  /** Usage reported across all runs, or null when none ever reported any. */
  reportedTokens: number | null
  /** Runs that finished without reporting usage. Their usage is unknown, and is not zero. */
  unreportedRuns: number
  /**
   * When the last paying completion settled, in epoch ms, or null if none ever has.
   *
   * An instant and not a day, because hunger is a *duration*: how long ago something happened is a
   * question a calendar cannot answer, and one a timezone change must not be able to move.
   */
  lastSettledAt: number | null
}

/** Everything the panel draws: the ledger's facts, plus what they mean. */
export interface PetCareReadout extends PetCareProgress, PetCareLevels {}

/** A corrupt field, read as the least it could have been rather than as a fact it is not. */
function count(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 0
  return Math.floor(raw)
}

function tallyOf(raw: PetCareDayTally | undefined | null): PetCareDayTally {
  const day = typeof raw?.day === 'string' && raw.day.length > 0 ? raw.day : ''
  const tokens = typeof raw?.tokens === 'number' && Number.isFinite(raw.tokens) ? raw.tokens : null
  return { day, completions: count(raw?.completions), tokens }
}

/**
 * The full readout, from however much of the ledger's summary arrived.
 *
 * The input is partial on purpose: a build whose gateway has not been wired yet, a record that came
 * back half-read and a preview's invented totals all reach the panel through this door, and the
 * panel must draw *something* truthful for each — which it can only do if a missing field is a
 * default rather than an exception.
 */
export function petCareProgress(progress?: Partial<PetCareProgress> | null): PetCareReadout {
  const xp = readPetCareXP(progress?.xp)
  const tokens =
    typeof progress?.reportedTokens === 'number' && Number.isFinite(progress.reportedTokens)
      ? progress.reportedTokens
      : null
  return {
    ...petCareLevels(xp),
    xp,
    meals: count(progress?.meals),
    streakDays: count(progress?.streakDays),
    unlocked: Array.isArray(progress?.unlocked) ? progress.unlocked : [],
    days: Array.isArray(progress?.days) ? progress.days.map(tallyOf) : [],
    reportedTokens: tokens,
    unreportedRuns: count(progress?.unreportedRuns),
    lastSettledAt:
      typeof progress?.lastSettledAt === 'number' && Number.isFinite(progress.lastSettledAt)
        ? progress.lastSettledAt
        : null,
  }
}

/**
 * The local calendar day of a `Date`, spelled `YYYY-MM-DD` (upstream's `dayKey`, `care.ts:142-145`).
 *
 * Local fields and not `toISOString().slice(0, 10)`: a UTC spelling names a different day for part
 * of every day everywhere the machine's offset is not zero, and "part of every day" is exactly
 * where a streak is decided. A day is the day the *user* is living in; the ledger stores the key it
 * settled under so that reading the record back — in another timezone, after a flight — cannot move
 * a completion to a different day.
 */
export function petCareDayKey(date: Date): string {
  const year = `${date.getFullYear()}`.padStart(4, '0')
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** The fourteen badges, in upstream's order (`care.ts:37-40`). The ledger awards these ids. */
export const PET_CARE_ACHIEVEMENTS = [
  'firstMeal',
  'sessions100',
  'sessions500',
  'tokens1M',
  'tokens10M',
  'tokens50M',
  'level5',
  'level10',
  'level20',
  'level35',
  'streak7',
  'streak14',
  'streak30',
  'nightOwl',
] as const

export type PetCareAchievement = (typeof PET_CARE_ACHIEVEMENTS)[number]

/** A badge's words and the name of the picture drawn beside them (`care.ts:41-53`). */
export interface PetCareAchievementLabel {
  name: string
  /** An icon *name*, not a glyph: which picture that is belongs to the surface that draws it. */
  icon: string
}

export const PET_CARE_ACHIEVEMENT_LABELS: Record<PetCareAchievement, PetCareAchievementLabel> = {
  firstMeal: { name: 'First Meal', icon: 'utensils' },
  sessions100: { name: '100 Sessions', icon: 'trophy' },
  sessions500: { name: '500 Sessions', icon: 'award' },
  tokens1M: { name: '1M Tokens', icon: 'flame' },
  tokens10M: { name: '10M Tokens', icon: 'zap' },
  tokens50M: { name: '50M Tokens', icon: 'bomb' },
  level5: { name: 'Level 5', icon: 'star' },
  level10: { name: 'Level 10', icon: 'sparkles' },
  level20: { name: 'Level 20', icon: 'shield' },
  level35: { name: 'Level 35', icon: 'crown' },
  streak7: { name: '7-Day Streak', icon: 'calendar' },
  streak14: { name: '14-Day Streak', icon: 'calendarCheck' },
  streak30: { name: '30-Day Streak', icon: 'calendarDays' },
  nightOwl: { name: 'Night Owl', icon: 'moon' },
}

/**
 * The one threshold table, keyed by badge, over the settled totals.
 *
 * Total over `PetCareAchievement` on purpose: a badge added to the vocabulary is a missing row here
 * rather than a badge that quietly never appears. Thirteen rows read a total, and the fourteenth is
 * `nightOwl` — `false`, because the fact it needs is the *hour* a completion happened at, which no
 * total carries. Settlement records that one (`care_ledger.rs`'s `RECORDED_BADGES`) and it arrives in
 * {@link PetCareProgress.unlocked}; re-deriving it here would mean inventing the hour.
 */
const PET_CARE_EARNED: Record<PetCareAchievement, (readout: PetCareReadout) => boolean> = {
  firstMeal: (readout) => readout.meals >= 1,
  sessions100: (readout) => readout.meals >= 100,
  sessions500: (readout) => readout.meals >= 500,
  // Unreported usage cannot earn one of these: `reportedTokens` is a lower bound, so a badge earned
  // from it is earned, and a null — nothing ever reported — is not a large number (§8).
  tokens1M: (readout) => (readout.reportedTokens ?? 0) >= 1_000_000,
  tokens10M: (readout) => (readout.reportedTokens ?? 0) >= 10_000_000,
  tokens50M: (readout) => (readout.reportedTokens ?? 0) >= 50_000_000,
  level5: (readout) => readout.level >= 5,
  level10: (readout) => readout.level >= 10,
  level20: (readout) => readout.level >= 20,
  level35: (readout) => readout.level >= 35,
  streak7: (readout) => readout.streakDays >= 7,
  streak14: (readout) => readout.streakDays >= 14,
  streak30: (readout) => readout.streakDays >= 30,
  nightOwl: () => false,
}

/**
 * Every badge earned, in vocabulary order, then any id the ledger recorded that this build cannot name.
 *
 * Two halves, joined once: what the totals imply, and what settlement had to write down. Both are
 * monotone — the totals only rise and the ledger only adds — so a badge once shown never disappears,
 * which is the property that makes drawing them from state safe rather than something the record has
 * to guarantee.
 */
export function petCareEarnedAchievements(readout: PetCareReadout): string[] {
  const recorded = new Set(readout.unlocked)
  const earned = PET_CARE_ACHIEVEMENTS.filter((id) => PET_CARE_EARNED[id](readout) || recorded.has(id))
  const known = new Set<string>(PET_CARE_ACHIEVEMENTS)
  const unnamed = readout.unlocked.filter((id) => !known.has(id))
  return [...earned, ...unnamed]
}

/** A badge's name, or the id itself when a newer ledger awarded one this build cannot name. */
export function petCareAchievementName(id: string): string {
  return (PET_CARE_ACHIEVEMENT_LABELS as Record<string, PetCareAchievementLabel | undefined>)[id]
    ?.name ?? id
}

/** A badge's icon name, or null when there is no picture for it — the panel draws it differently. */
export function petCareAchievementIcon(id: string): string | null {
  return (PET_CARE_ACHIEVEMENT_LABELS as Record<string, PetCareAchievementLabel | undefined>)[id]
    ?.icon ?? null
}

/** How the pet looks, by how long ago it last ate (`care.ts:130-138`). */
export type PetCareHunger = 'full' | 'satisfied' | 'peckish' | 'hungry' | 'starving'

const HOUR_MS = 3_600_000

/**
 * The hunger step for a settled completion at `lastSettledAt`, read at `now` — both in epoch ms.
 *
 * `now` is an argument (§10.2) and a `now` *before* the last meal is floored at "full" rather than
 * turned into a negative age: the clock that moved is the machine's, and a pet that read it as
 * starving because a timezone changed would be reporting the wrong thing about the user's own day.
 */
export function petCareHunger(lastSettledAt: number | null, now: number): PetCareHunger {
  if (lastSettledAt === null || !Number.isFinite(lastSettledAt)) return 'peckish'
  const hours = Math.max(0, now - lastSettledAt) / HOUR_MS
  if (hours < 4) return 'full'
  if (hours < 10) return 'satisfied'
  if (hours < 24) return 'peckish'
  if (hours < 48) return 'hungry'
  return 'starving'
}

/**
 * The panel's wording, field by field.
 *
 * Here rather than inside `PetCarePanel.vue` because a label a component keeps to itself is a label
 * the pet's i18n namespace cannot reach (§10.1 wires the namespace in, not this task) — and because
 * two of the keys are *vocabularies* rather than sentences: the stage names and the hunger steps are
 * one word per key of `PET_CARE_STAGES` and `PetCareHunger`, so a step added to either is a missing
 * key here rather than a surface that quietly shows an English word. Placeholders are `{name}` and
 * are filled by the panel with `fillPetLabel`.
 */
export interface PetCarePanelLabels {
  /** The surface's own name, for the keyboard and the screen reader. */
  panel: string
  /** This build has no ledger to read, so no progress number is drawn. */
  absent: string
  /** The stored record is from a newer build: shown as it is, never written over (§10.2). */
  readOnly: string
  /** What is on screen is a sample, and nothing on it was earned. */
  preview: string
  /** `{level}` — the level row. `{hunger}` — how the pet is doing. */
  level: string
  hunger: string
  /** `{days}` — days in a row with a settled completion. `{count}` — completions all time. */
  streak: string
  meals: string
  /** The level bar's accessible name. `{level}`, `{percent}`. */
  progress: string
  /** The heading over the badges. `{earned}`, `{total}`. */
  achievements: string
  /** A badge the ledger awarded, and a badge it did not. */
  earned: string
  locked: string
  /** `{tokens}` — usage the engines reported. */
  usage: string
  /** Nothing ever reported usage, which is not the same as nothing having been used. `{count}` runs
   * finished without reporting, which §8's 「token 未知不是 0」 exists to keep visible. */
  usageUnknown: string
  usagePartial: string
  /** What one day's usage cell says when nobody reported any. */
  dayUnknown: string
  /** `{day}`, `{count}`, `{tokens}` — one day in the window. */
  day: string
  /** The same row, for the day the caller's clock is standing in. */
  dayToday: string
  /** One word per `PetCareStage`, and one per `PetCareHunger` step. */
  stages: Record<PetCareStage, string>
  hungerSteps: Record<PetCareHunger, string>
  /** The import result's heading. */
  importTitle: string
  /** `{fields}` — what the file raised, and what the ledger already had ahead of it. */
  importRaised: string
  importKept: string
  /**
   * A word for each field an import can report, keyed by the ledger's own ids
   * (`care_ledger.rs`'s `IMPORT_FIELDS`, which `pet-care-rules.test.ts` reads).
   */
  importFields: Record<string, string>
  /** The ledger moved between the read and the import: nothing was written. */
  importConflict: string
  /** `{reason}` — the import was refused whole. */
  importRefused: string
  /** Signing in, syncing and the leaderboard are not in this build (§5.2, §3.4). */
  online: string
}

export const PET_CARE_PANEL_LABELS: PetCarePanelLabels = {
  panel: 'Growth',
  absent: 'No progress is recorded in this build: the ledger that settles rewards has not landed, so nothing here is drawn and nothing is earned.',
  readOnly: 'This progress was recorded by a newer version of the app, so it is shown as it is and nothing is written to it.',
  preview: 'Sample data: this is what the panel will look like. Nothing here is recorded and nothing is earned.',
  level: 'Level {level}',
  hunger: 'Feeling {hunger}',
  streak: '{days} days running',
  meals: '{count} completed',
  progress: 'Level {level}, {percent} percent of the way to the next',
  achievements: '{earned} of {total} earned',
  earned: 'Earned',
  locked: 'Not yet',
  usage: '{tokens} reported',
  usageUnknown: 'Usage unknown: nothing has reported any yet, and an unknown count is not zero.',
  usagePartial: '{count} finished runs reported no usage.',
  dayUnknown: 'usage unknown',
  day: '{day}: {count} done, {tokens}',
  dayToday: '{day} (today): {count} done, {tokens}',
  stages: {
    hatchling: 'Hatchling',
    companion: 'Companion',
    scout: 'Scout',
    hero: 'Hero',
    legend: 'Legend',
  },
  hungerSteps: {
    full: 'full',
    satisfied: 'satisfied',
    peckish: 'peckish',
    hungry: 'hungry',
    starving: 'starving',
  },
  importTitle: 'Imported progress',
  importRaised: 'Raised from the file: {fields}',
  importKept: 'Kept as they were, because they were already ahead: {fields}',
  importFields: {
    xp: 'total XP',
    meals: 'completed runs',
    streak: 'the streak',
    days: 'recent days',
    tokens: 'reported usage',
  },
  importConflict: 'The progress changed while the file was being read, so nothing was imported. Read the file again to import it into what is there now.',
  importRefused: 'The file was not imported: {reason}. Nothing was changed.',
  online: 'Signing in, syncing across devices and the leaderboard are not part of this build, and no control for them is offered here.',
}
