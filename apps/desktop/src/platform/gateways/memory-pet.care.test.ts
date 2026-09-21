import { describe, expect, it } from 'vitest'
import { createMemoryPetGateway } from './memory-pet'

describe('the care read the double offers', () => {
  it('answers empty until it is told what the ledger settled', async () => {
    const pet = createMemoryPetGateway()

    // §8's 「token 未知不是 0」 at the read: an unanswered ledger is *nothing to draw*, not a set of
    // zeroes a page could put a level on. The double's default is the same answer a real host gives
    // before anything settles, so a surface written against it is written against that state.
    expect(await pet.care()).toEqual({ status: 'empty' })
  })

  it('hands back exactly the summary it was given, and settles nothing itself', async () => {
    const summary = {
      schemaVersion: 1,
      revision: 4,
      xp: 100,
      meals: 4,
      streakDays: 2,
      unlocked: ['nightOwl'],
      days: [{ day: '2026-09-16', completions: 1, tokens: null }],
      reportedTokens: null,
      unreportedRuns: 4,
      lastSettledAt: 1_789_000_000_000,
    }
    const pet = createMemoryPetGateway({ care: summary })

    // The double is a *host*, not a second ledger: what it answers is what it was configured with,
    // and reading it twice changes nothing. A double that settled would be a second answer to what
    // a completion pays, which is `care_ledger.rs`'s alone (§9).
    const read = await pet.care()
    expect(read).toEqual({ status: 'current', summary })
    expect(await pet.care()).toEqual(read)
  })
})
