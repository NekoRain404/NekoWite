/**
 * The care rules: levels, days and badges, as a function of what the ledger settled.
 *
 * Three of the plan's care clauses are decided here rather than in the ledger, and each has a test
 * that fails against the obvious wrong implementation rather than only passing against the right
 * one:
 *
 *  - **日期/时区.** A day key is a *local calendar* question. A `toISOString().slice(0, 10)` day —
 *    which is what a UTC implementation collapses to — is a different day for most of the planet
 *    for part of every day, so the test builds an instant just after local midnight and compares
 *    the key against the instant's own local fields, and (when the machine's own offset makes the
 *    two differ at all) against the UTC spelling, which must not be the answer.
 *  - **无 token.** XP is a function of settled completions, so `petCareReadout` takes an XP total
 *    and a token count cannot enter it. The badge vocabulary is the other half: it is the ledger's,
 *    and the last test reads `care_ledger.rs` rather than a copy, the way
 *    `desktop_pet_ipc_test/capabilities.rs` reads `pet-contracts/platform.ts`.
 *  - **不编数字.** A stored value nobody validated must not produce `NaN`, an infinite loop or a
 *    progress bar outside 0..1, and a day whose usage nobody reported is `null` — never `0`.
 *
 * The rules are pure and the clock is an argument, which is what lets the midnight case be an
 * assertion at all: nothing here reads `Date.now()`.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  PET_CARE_ACHIEVEMENTS,
  PET_CARE_ACHIEVEMENT_LABELS,
  PET_CARE_PANEL_LABELS,
  PET_CARE_STAGES,
  petCareAchievementIcon,
  petCareAchievementName,
  petCareDayKey,
  petCareDisplayLevel,
  petCareEarnedAchievements,
  petCareHunger,
  petCareLevelForXP,
  petCareLevelProgress,
  petCareLevels,
  petCareProgress,
  petCareStageIndex,
  petCareXPToReach,
  type PetCareDayTally,
} from './pet-care-rules'

/** One day of the ledger's trailing window. */
function day(dayKey: string, completions: number, tokens: number | null): PetCareDayTally {
  return { day: dayKey, completions, tokens }
}

describe('the level curve', () => {
  it('reaches level n at 60·n·(n-1) XP, and every level boundary is where the curve says', () => {
    expect(petCareXPToReach(0)).toBe(0)
    expect(petCareXPToReach(1)).toBe(0)
    expect(petCareXPToReach(2)).toBe(120)
    expect(petCareXPToReach(3)).toBe(360)
    expect(petCareXPToReach(10)).toBe(5400)

    expect(petCareLevelForXP(0)).toBe(1)
    expect(petCareLevelForXP(119)).toBe(1)
    expect(petCareLevelForXP(120)).toBe(2)
    expect(petCareLevelForXP(359)).toBe(2)
    expect(petCareLevelForXP(360)).toBe(3)
  })

  it('shows the level one below the internal one, floored at zero', () => {
    expect(petCareDisplayLevel(0)).toBe(0)
    expect(petCareDisplayLevel(120)).toBe(1)
    expect(petCareDisplayLevel(360)).toBe(2)
  })

  it('walks the five stages at the same thresholds the badges use', () => {
    expect(PET_CARE_STAGES).toHaveLength(5)
    expect(petCareStageIndex(0)).toBe(0)
    expect(petCareStageIndex(4)).toBe(0)
    expect(petCareStageIndex(5)).toBe(1)
    expect(petCareStageIndex(10)).toBe(2)
    expect(petCareStageIndex(20)).toBe(3)
    expect(petCareStageIndex(35)).toBe(4)
    expect(petCareStageIndex(400)).toBe(4)
  })

  it('never reports progress outside 0..1, and ends exactly at a level boundary', () => {
    expect(petCareLevelProgress(0)).toBe(0)
    expect(petCareLevelProgress(60)).toBeCloseTo(0.5, 10)
    expect(petCareLevelProgress(119)).toBeLessThan(1)
    expect(petCareLevelProgress(120)).toBe(0)
    expect(petCareLevelProgress(Number.MAX_SAFE_INTEGER)).toBeLessThanOrEqual(1)
  })
})

describe('a stored total nobody validated', () => {
  it('reads a corrupt XP as zero rather than producing NaN or looping forever', () => {
    for (const corrupt of [Number.NaN, Number.POSITIVE_INFINITY, -5, 1.5]) {
      const readout = petCareLevels(corrupt)
      expect(Number.isFinite(readout.xp)).toBe(true)
      expect(readout.xp).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(readout.xp)).toBe(true)
      expect(Number.isFinite(readout.progress)).toBe(true)
    }
    // 1.5 XP is not a total the ledger can produce (it pays whole units), so it is floored rather
    // than reported as a fraction of a level.
    expect(petCareLevels(1.5).xp).toBe(1)
  })

  it('stays fast for a total far past any real one', () => {
    const started = Date.now()
    const readout = petCareLevels(Number.MAX_SAFE_INTEGER)
    expect(readout.level).toBeGreaterThan(0)
    expect(Date.now() - started).toBeLessThan(250)
  })
})

describe('a day is a local calendar day', () => {
  it('keys an instant by its own local fields', () => {
    const justAfterMidnight = new Date(2026, 8, 16, 0, 30, 0, 0)
    expect(petCareDayKey(justAfterMidnight)).toBe('2026-09-16')

    const justBeforeMidnight = new Date(2026, 8, 16, 23, 59, 59, 999)
    expect(petCareDayKey(justBeforeMidnight)).toBe('2026-09-16')
  })

  it('is not the UTC day, wherever the machine is not on UTC', () => {
    // A local day is only the UTC day on a machine whose offset is zero. Everywhere else — which is
    // everywhere this ships — a UTC-derived key names a different day for part of every day, and it
    // is the *machine's* offset that decides where that part is, so it is read here rather than
    // assumed: this assertion has to mean something on the runner and on the desktop alike.
    const instant = new Date(2026, 8, 16, 0, 30, 0, 0)
    const utcDay = instant.toISOString().slice(0, 10)
    const offsetMinutes = instant.getTimezoneOffset()
    const localDay = petCareDayKey(instant)

    if (offsetMinutes === 0) {
      expect(localDay).toBe(utcDay)
    } else {
      expect(localDay).not.toBe(utcDay)
    }
    expect(localDay).toBe('2026-09-16')
  })

  it('crosses a month end, a year end and a leap day without borrowing a UTC day', () => {
    expect(petCareDayKey(new Date(2026, 1, 28, 23, 0, 0, 0))).toBe('2026-02-28')
    expect(petCareDayKey(new Date(2026, 2, 1, 0, 0, 0, 0))).toBe('2026-03-01')
    expect(petCareDayKey(new Date(2026, 11, 31, 23, 59, 0, 0))).toBe('2026-12-31')
    expect(petCareDayKey(new Date(2027, 0, 1, 0, 1, 0, 0))).toBe('2027-01-01')
    expect(petCareDayKey(new Date(2028, 1, 29, 12, 0, 0, 0))).toBe('2028-02-29')
  })

  it('pads a month and a day that would otherwise sort wrongly', () => {
    expect(petCareDayKey(new Date(2026, 0, 5, 12, 0, 0, 0))).toBe('2026-01-05')
  })
})

describe('the badges the ledger can award', () => {
  it('names every badge it knows, and shows an id it does not know as itself', () => {
    for (const id of PET_CARE_ACHIEVEMENTS) {
      expect(PET_CARE_ACHIEVEMENT_LABELS[id].name.length).toBeGreaterThan(0)
      expect(petCareAchievementName(id)).toBe(PET_CARE_ACHIEVEMENT_LABELS[id].name)
    }
    // An id from a newer ledger is kept and shown, not dropped and not renamed: the same rule the
    // settings schema applies to an agent id it has not heard of (§5.2 「兼容未知 Agent」).
    expect(petCareAchievementName('streak365')).toBe('streak365')
    expect(petCareAchievementIcon('streak365')).toBeNull()
  })

  it('derives the badges a set of totals has earned', () => {
    const earned = (progress: Parameters<typeof petCareProgress>[0]): string[] =>
      petCareEarnedAchievements(petCareProgress(progress))

    expect(earned({})).toEqual([])
    expect(earned({ meals: 1 })).toEqual(['firstMeal'])
    expect(earned({ meals: 100 })).toEqual(['firstMeal', 'sessions100'])
    expect(earned({ meals: 500 })).toEqual(['firstMeal', 'sessions100', 'sessions500'])
    // The badges follow the *displayed* level, which is one below the internal one: level 5 shown is
    // 60·6·5 = 1800 XP, exactly as `petCareDisplayLevel` reports it.
    const shown = (level: number): number => petCareXPToReach(level + 1)
    expect(petCareDisplayLevel(shown(5))).toBe(5)
    expect(earned({ xp: shown(5) })).toContain('level5')
    expect(earned({ xp: shown(5) - 1 })).not.toContain('level5')
    expect(earned({ xp: shown(35) })).toContain('level35')
    expect(earned({ streakDays: 7 })).toEqual(['streak7'])
    expect(earned({ streakDays: 30 })).toEqual(['streak7', 'streak14', 'streak30'])
  })

  it('cannot earn a badge for usage nobody reported', () => {
    // §8: a token count that is unknown is not a large one. `reportedTokens` is a lower bound, so a
    // badge it does earn is earned; a null — nothing ever reported — earns nothing.
    expect(petCareEarnedAchievements(petCareProgress({ reportedTokens: null }))).toEqual([])
    expect(petCareEarnedAchievements(petCareProgress({ reportedTokens: 0 }))).toEqual([])
    expect(petCareEarnedAchievements(petCareProgress({ reportedTokens: 999_999 }))).toEqual([])
    expect(petCareEarnedAchievements(petCareProgress({ reportedTokens: 1_000_000 }))).toEqual([
      'tokens1M',
    ])
  })

  it('shows a badge the ledger recorded and cannot re-derive, and keeps one it cannot name', () => {
    // `nightOwl` is the record's, not the totals': it was earned by the hour a completion happened
    // at, and the totals no longer carry that hour. A badge from a newer build is shown as its id.
    const readout = petCareProgress({ meals: 1, unlocked: ['nightOwl', 'streak365'] })
    expect(petCareEarnedAchievements(readout)).toEqual(['firstMeal', 'nightOwl', 'streak365'])
    // Nothing else can invent it: a total alone never produces the recorded one.
    expect(petCareEarnedAchievements(petCareProgress({ meals: 500 }))).not.toContain('nightOwl')
  })

  it('is the ledger’s vocabulary rather than a second one', () => {
    // §9 forbids two sources of truth for one rule. What the ledger *writes down* is read out of
    // `R/src/desktop_pet/care_ledger.rs` — the one badge settlement records, and the field names an
    // import reports — and compared with this file's, the way `desktop_pet_ipc_test/capabilities.rs`
    // reads `pet-contracts/platform.ts`.
    const ledger = resolve(__dirname, '../../../../src-tauri/src/desktop_pet/care_ledger.rs')
    const text = readFileSync(ledger, 'utf8')
    const consts = new Map(
      [...text.matchAll(/pub const ([A-Z_]+): &str = "([A-Za-z0-9-]+)";/g)].map((match) => [
        match[1] as string,
        match[2] as string,
      ]),
    )

    const nightOwl = consts.get('NIGHT_OWL')
    expect(nightOwl).toBeDefined()
    expect(PET_CARE_ACHIEVEMENTS).toContain(nightOwl)

    const importFields = [...consts.entries()]
      .filter(([name]) => name.startsWith('IMPORT_'))
      .map(([, value]) => value)
    expect(importFields.length).toBeGreaterThan(0)
    // Every field an import can report has a word here, and no word names a field the ledger cannot
    // report: a report is what the user reads to find out what an import did to their progress.
    expect([...importFields].sort()).toEqual(Object.keys(PET_CARE_PANEL_LABELS.importFields).sort())
  })
})

describe('usage nobody reported', () => {
  it('keeps an unreported day unknown instead of reading it as zero', () => {
    const days = [day('2026-09-15', 2, null), day('2026-09-16', 1, 0)]
    const readout = petCareProgress({ xp: 120, days })
    // The readout carries both through untouched; `null` and `0` are different facts and a display
    // that folded them together would be §8's 「token 未知不是 0」 broken at the last step.
    expect(readout.days[0]?.tokens).toBeNull()
    expect(readout.days[1]?.tokens).toBe(0)
    expect(readout.days[0]?.completions).toBe(2)
  })
})

describe('how long since the last settled completion', () => {
  const fed = Date.UTC(2026, 8, 16, 12, 0, 0)

  it('walks the five steps on the hours since, with the clock injected', () => {
    expect(petCareHunger(null, fed)).toBe('peckish')
    expect(petCareHunger(fed, fed)).toBe('full')
    expect(petCareHunger(fed, fed + 3.9 * 3_600_000)).toBe('full')
    expect(petCareHunger(fed, fed + 4 * 3_600_000)).toBe('satisfied')
    expect(petCareHunger(fed, fed + 10 * 3_600_000)).toBe('peckish')
    expect(petCareHunger(fed, fed + 24 * 3_600_000)).toBe('hungry')
    expect(petCareHunger(fed, fed + 48 * 3_600_000)).toBe('starving')
  })

  it('reads a clock that went backwards as "just fed" rather than as a negative age', () => {
    // A machine that crossed a timezone, or whose clock was corrected, must not turn a settled
    // completion into an age the pet cannot describe; the floor is "full".
    expect(petCareHunger(fed, fed - 3_600_000)).toBe('full')
  })
})
