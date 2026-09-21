/**
 * What the care ledger settled, and the two answers a read can come back with (§8).
 *
 * This is a *readout*, not a second set of rules. `R/src/desktop_pet/care_ledger.rs` decides what a
 * completion pays and records the decision; everything a person sees derived from those totals —
 * the level, the stage, the progress fraction, the badges — is `pet-care-rules.ts`'s, computed
 * where it is drawn. `CareLedger::summary` says the same thing from its side: carrying a level here
 * would be the second level curve §9 forbids.
 *
 * **Nothing about how a total was reached is on this wire.** No level, no price, no login, no
 * balance: `the_summary_carries_what_was_settled_and_no_level_and_no_price`
 * (`tests/desktop_pet_care_test/local.rs`) asserts the serialized key set exactly, and the field
 * names below are that set, camelCased by serde from the ledger's own declaration. `PetCareProgress`
 * in `pet-care-rules.ts` is the same fields seen from the surface that draws them, so a summary
 * reaches the panel without a mapping layer in between — one vocabulary, two readers.
 */

/** One day of the ledger's trailing window, oldest first. */
export interface PetCareDay {
  /** The machine's local calendar day, `YYYY-MM-DD`. */
  day: string
  /** Runs that finished on that day. Always known: this is what pays. */
  completions: number
  /**
   * Usage the engines reported that day, or `null` when nothing reported any.
   *
   * `null` and `0` are different facts and this type keeps them apart: a reported zero is a day
   * whose usage is known to be none, and a `null` is a day nobody measured (§8's 「token 未知不是
   * 0」).
   */
  tokens: number | null
}

/** What the ledger recorded: settled totals, and no interpretation of them. */
export interface PetCareSummary {
  /** The ledger's own record version, for whoever has to decide whether it can be read (§10.2). */
  schemaVersion: number
  /**
   * The store revision. It moves when something is decided — a settlement or an import — so a
   * caller can tell a record it has already seen from one that changed under it (§5.3's shape,
   * applied to a store that is not a settings domain).
   */
  revision: number
  xp: number
  /** Completed runs that paid. */
  meals: number
  /** Consecutive days with a settled completion. */
  streakDays: number
  /** Badge ids settlement recorded. The derivable ones are derived where they are drawn. */
  unlocked: string[]
  /** The trailing window, oldest first. */
  days: PetCareDay[]
  /** Usage reported across every run, or `null` while nothing has reported any. */
  reportedTokens: number | null
  /** Runs that finished without reporting usage. Their usage is unknown, and is not zero. */
  unreportedRuns: number
  /** When the last paying completion settled, in epoch ms, or `null` if none ever has. */
  lastSettledAt: number | null
}

/**
 * What a read of the ledger produced.
 *
 * The second arm is the whole design. A ledger nothing has settled into has totals — `xp: 0`,
 * `meals: 0`, no streak, no day — and handing those over would have a surface draw level 0 and an
 * empty bar for a user who has completed five hundred runs. That is §8's 「token 未知不是 0」 one
 * level up: `meals: 0` would read *the absence of a record* as *a record of absence*, when the
 * truth is that nothing has been recorded at all. So the totals are not sent unless something
 * settled, and the caller is told which of the two it is holding — the arms are things the caller
 * *does*, not a record with a flag, the way `PetSettingsLoad`'s are.
 *
 * The arm this build could not produce is now the third one, and it arrived with the store exactly as
 * the previous revision of this comment said it would. The ledger is written to a file, so a record a
 * newer build left there can be met — and this build cannot make rows out of fields it does not know,
 * so it loads an *empty* ledger and must not replace the file (§10.2). Answering `empty` for that
 * would draw level 0 for a user whose progress is sitting on disk, which is the same invented figure
 * the second arm exists to refuse. The spelling is kebab-case, which is the one `PetSettingsLoad`
 * already uses for the same three facts.
 */
export type PetCareRead =
  | { status: 'current'; summary: PetCareSummary }
  | { status: 'empty' }
  | { status: 'read-only' }
