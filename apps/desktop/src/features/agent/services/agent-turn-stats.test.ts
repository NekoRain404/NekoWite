/**
 * The turn stopwatch, and the arithmetic that turns it into a sentence.
 *
 * Both halves are pure, and both are the kind of thing that is invisible when it is wrong: a
 * stopwatch restarted by a state word would report the reader's own pause as the turn's length,
 * and a duration rounded up would claim a precision a wall clock does not have.
 */
import { describe, expect, it } from 'vitest'
import {
  INITIAL_AGENT_TURN_CLOCK,
  noteRunState,
  turnDurationParts,
  type AgentTurnClock,
} from './agent-turn-stats'

describe('the turn stopwatch', () => {
  it('measures a run from the moment it became live to the moment it stopped', () => {
    const started = noteRunState(INITIAL_AGENT_TURN_CLOCK, true, 1_000)
    expect(started.startedAt).toBe(1_000)
    expect(started.lastMs).toBeNull()

    const ended = noteRunState(started, false, 6_500)
    expect(ended.startedAt).toBeNull()
    expect(ended.lastMs).toBe(5_500)
  })

  it('does not restart on a state word that changed without the run changing', () => {
    // `waiting-permission` is still the same live run, and so is the `running` after the answer:
    // a stopwatch that restarted on either would report the reader's pause as the turn's length.
    const started = noteRunState(INITIAL_AGENT_TURN_CLOCK, true, 1_000)
    const stillLive = noteRunState(started, true, 4_000)
    expect(stillLive).toBe(started)
    expect(noteRunState(stillLive, false, 6_000).lastMs).toBe(5_000)
  })

  it('keeps the previous measurement while a new run is in flight', () => {
    // The bar shows the last finished turn's numbers — tokens included — so the clock has to
    // survive the next run's start rather than blanking beside a token count that stayed.
    const first = noteRunState(noteRunState(INITIAL_AGENT_TURN_CLOCK, true, 0), false, 3_000)
    const second = noteRunState(first, true, 10_000)
    expect(second.lastMs).toBe(3_000)
    expect(second.startedAt).toBe(10_000)
    expect(noteRunState(second, false, 11_000).lastMs).toBe(1_000)
  })

  it('measures nothing when it never saw the run begin', () => {
    // A panel mounted mid-run, or remounted after one: the view still carries `lastResult`, and
    // a turn this window did not watch must have no duration rather than a partial one.
    const seenLate: AgentTurnClock = { startedAt: null, lastMs: null }
    expect(noteRunState(seenLate, false, 50_000)).toBe(seenLate)
    expect(noteRunState(INITIAL_AGENT_TURN_CLOCK, false, 50_000).lastMs).toBeNull()
  })

  it('refuses a duration that ran backwards', () => {
    // A wall clock can be adjusted under a run in flight. A negative duration is not a reading,
    // and reporting one would be worse than reporting nothing.
    const started = noteRunState(INITIAL_AGENT_TURN_CLOCK, true, 10_000)
    expect(noteRunState(started, false, 9_000).lastMs).toBeNull()
  })
})

describe('a duration as numbers', () => {
  it('splits whole seconds the way Zed’s own formatter does', () => {
    // `duration_alt_display` (zed-main/crates/util/src/time.rs:3-15): hours, minutes, seconds,
    // each floored — 59s is 59s and 61s is 1m 1s.
    expect(turnDurationParts(0)).toEqual({ hours: 0, minutes: 0, seconds: 0 })
    expect(turnDurationParts(59_000)).toEqual({ hours: 0, minutes: 0, seconds: 59 })
    expect(turnDurationParts(60_000)).toEqual({ hours: 0, minutes: 1, seconds: 0 })
    expect(turnDurationParts(3_723_000)).toEqual({ hours: 1, minutes: 2, seconds: 3 })
  })

  it('rounds down rather than up', () => {
    // A wall clock that claims a tenth of a second is claiming a precision it does not have —
    // 999ms is not a second of work.
    expect(turnDurationParts(999)).toEqual({ hours: 0, minutes: 0, seconds: 0 })
    expect(turnDurationParts(1_999)).toEqual({ hours: 0, minutes: 0, seconds: 1 })
  })
})
