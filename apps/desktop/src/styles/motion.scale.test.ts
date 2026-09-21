import { describe, expect, it } from 'vitest'
import {
  BEZIER_CURVES,
  CHOREOGRAPHY,
  CYCLIC,
  EXIT,
  LADDER,
  curveOf,
  durationOf,
  tokens,
} from './motion-tokens'

/**
 * The motion scale: how long each step lasts, and which class of interaction it
 * is for.
 *
 * Split out of `motion.test.ts` when that file crossed the line budget with 70
 * tests in it. This file owns the *durations* — the ladder, the cyclic rates and
 * the exit fraction — while `motion.easing.test.ts` owns the curves those
 * durations are spent on. The tests and the bands are unchanged in the move;
 * only the file is.
 */

describe('motion scale', () => {
  it('defines every ladder step, in strictly increasing order', () => {
    const values = LADDER.map((t) => durationOf(tokens, t))
    for (const [i, v] of values.entries()) {
      expect(v, `${LADDER[i]} has a usable duration`).toBeGreaterThan(0)
    }
    for (let i = 1; i < values.length; i++) {
      expect(
        values[i],
        `${LADDER[i]} (${values[i]}ms) must be slower than ${LADDER[i - 1]} (${values[i - 1]}ms)`,
      ).toBeGreaterThan(values[i - 1])
    }
  })

  it('documents which interaction class each step is for', () => {
    // A scale without a stated intent is just numbers: the next person to add
    // a transition has to be able to pick a step without guessing.
    const comments = [...tokens.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0]).join('\n')
    for (const token of [
      ...LADDER,
      ...CYCLIC,
      ...BEZIER_CURVES,
      EXIT,
      ...CHOREOGRAPHY,
    ]) {
      expect(comments, `${token} is named in a comment`).toContain(token)
    }
  })

  it('ships one arriving curve and a distinct accelerating one for exits', () => {
    const enter = curveOf('--app-ease')
    const exit = curveOf('--app-ease-exit')
    expect(enter).toMatch(/^cubic-bezier\(/)
    expect(exit).toMatch(/^cubic-bezier\(/)
    expect(exit, 'exits must not reuse the arriving curve').not.toBe(enter)
  })

  it('defines a cyclic rate for spinners and the caret', () => {
    for (const token of CYCLIC) {
      expect(durationOf(tokens, token), `${token} is a sane cycle`).toBeGreaterThanOrEqual(500)
    }
  })
})
