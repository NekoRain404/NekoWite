import { describe, expect, it } from 'vitest'
import { read } from './motion-source'
import { MOTION_SURFACE } from './motion-surfaces'

/**
 * Responsiveness rules: motion that must not lag the input that caused it.
 *
 * Split out of `motion.test.ts` when that file crossed the line budget with 70
 * tests in it. A caret and a spinner are the two places where easing is a defect
 * rather than a polish — one lags a keystroke, the other reads as a stutter — so
 * they are held to their own domain. The tests are unchanged in the move; only
 * the file is.
 */

describe('responsiveness rules', () => {
  it('never transitions the caret', () => {
    // A caret that eases in lags the keystroke that moved it.
    for (const file of MOTION_SURFACE) {
      expect(read(file), `${file} must not transition caret-color`).not.toMatch(
        /transition:[^;]*caret-color/,
      )
    }
  })

  it('drives every spinner at a constant rate', () => {
    // A rotation that eases in and out reads as a stutter at this speed; the
    // cycle is constant-rate by definition, so it must stay `linear`.
    let spinners = 0
    for (const file of MOTION_SURFACE) {
      for (const line of read(file).split('\n')) {
        if (!line.includes('animation:') || !line.includes('--app-motion-spin')) continue
        spinners++
        expect(line, `${file}: spinner must be linear`).toContain('linear')
      }
    }
    expect(spinners, 'the spinner token must actually be used').toBeGreaterThan(0)
  })
})
