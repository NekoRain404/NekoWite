import { describe, expect, it } from 'vitest'
import {
  BEZIER_CURVES,
  EXIT,
  LADDER,
  SPRING_CURVE,
  curveOf,
  durationOf,
  guardedCurve,
  springSamples,
  tokens,
} from './motion-tokens'

/**
 * The easing vocabulary: one curve per kind of motion, and the shape of the
 * spring the arrival spends.
 *
 * Split out of `motion.test.ts` when that file crossed the line budget with 70
 * tests in it. `motion.scale.test.ts` owns how long a movement lasts; this file
 * owns what it is shaped like — the beziers, the sampled spring, its overshoot
 * band and the exit's fraction of its entrance. The tests are unchanged in the
 * move; only the file is.
 */

describe('easing vocabulary', () => {
  it('gives each kind of motion its own curve', () => {
    // `--app-ease` is the one the existing contract pins as a bezier, and it is
    // the right shape for a state change: the control is barely moving, and a
    // curve that overshoots there is the mush the brief warns about.
    for (const token of BEZIER_CURVES) {
      expect(curveOf(token), `${token} is a bezier`).toMatch(/^cubic-bezier\(/)
    }
    expect(guardedCurve(SPRING_CURVE), 'the arrival curve is a sampled spring').toMatch(/^linear\(/)
  })

  it('keeps a plain arrival curve for engines that cannot sample one', () => {
    // A `linear()` that an engine cannot parse takes the whole animation
    // shorthand down with it — the declaration is dropped, not degraded — so
    // the fallback is what keeps dialogs animating at all on an older WebKit.
    // It is a once-overshooting bezier: not the settle, but an arrival.
    const fallback = curveOf(SPRING_CURVE)
    expect(fallback).toMatch(/^cubic-bezier\(/)
    expect(fallback, 'the fallback is not the state-change curve').not.toBe(
      curveOf('--app-ease'),
    )
  })

  it('samples the spring on a timeline that never runs backwards', () => {
    // `linear()` interpolates between its stops in the order given. A stop that
    // sits earlier than the one before it makes the curve jump backwards — the
    // surface would visibly stutter — so the sample positions must ascend.
    const samples = springSamples(guardedCurve(SPRING_CURVE))
    expect(samples.length, 'enough samples to be a curve, not a corner').toBeGreaterThan(8)
    expect(samples[0].value, 'a spring starts at rest').toBe(0)
    expect(samples.at(-1)!.value, '...and ends at rest').toBe(1)
    expect(samples.at(-1)!.at, '...at the end of its own timeline').toBe(100)
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].at, `sample ${i} moves forward`).toBeGreaterThan(samples[i - 1].at)
    }
  })

  it('lets the spring settle rather than bounce, which is a seasoning and not the dish', () => {
    // The 回弹 is wanted and it is wanted *small*. It is a settle felt at the end
    // of a movement, not a bounce watched during it — the vocabulary for an
    // arrival here is 淡入淡出 + 缩放, soft and unhurried, and 3.8% of a 1.5%
    // scale on a 720px dialog is under half a pixel. The band is therefore
    // narrow at both ends: above 1 because a spring that never passes its target
    // cannot ring and should have been a bezier; below 0.06 because past that it
    // stops being a settle and starts competing with the text the user is
    // reading. If an arrival should read as springier, the lever is duration or
    // amplitude — not this ratio.
    const samples = springSamples(guardedCurve(SPRING_CURVE))
    const peak = Math.max(...samples.map((s) => s.value))
    expect(peak, 'the spring overshoots').toBeGreaterThan(1)
    // One overshoot, once, and small. 8.4% is what the spring is sampled at,
    // and it is a *fraction of the travel*, not of the value: on the 1.5% scale
    // a surface arrives with that is the `1.002` the design asks for, and on a
    // 6px drift it is the half-pixel crossing past the endpoint. Past a tenth
    // the movement stops being a settle and becomes something the eye follows.
    expect(peak - 1, 'the overshoot stays a settle, not a bounce').toBeLessThan(0.1)
    // ...once, and then it decays back to the target from above without a
    // second excursion past it. That one-sided settle is what 缩放和位移不必同时
    // 回弹, 先只让缩放轻轻超过终点一次 asks for: one crossing of the endpoint,
    // felt rather than watched. A ring that went back under 1 would be a second,
    // opposite movement on a surface the user is trying to read.
    const afterPeak = samples.slice(samples.findIndex((s) => s.value === peak) + 1)
    expect(Math.min(...afterPeak.map((s) => s.value)), 'no second excursion').toBeGreaterThanOrEqual(1)
    expect(afterPeak.at(-1)!.value, 'and it arrives').toBe(1)
  })

  it('makes an exit a fraction of its entrance, not a rung of its own', () => {
    // ~60–70%: an exit that takes as long as its arrival reads as lag on
    // whatever the user does next, and one much shorter reads as a cut. Kept as
    // arithmetic over the rung it mirrors so the ratio cannot drift when a rung
    // is retuned — this used to be hand-picked rungs, and the two relations they
    // produced were 54% and 76%, neither of them in the band.
    const declared = tokens.match(/--app-motion-exit:\s*calc\(var\((--[\w-]+)\)\s*\*\s*([\d.]+)\)/)
    expect(declared, `${EXIT} is a fraction of the rung it mirrors`).not.toBeNull()
    const [, base, ratio] = declared!
    expect(LADDER as readonly string[], `${base} is a rung of the ladder`).toContain(base)
    expect(Number(ratio)).toBeGreaterThanOrEqual(0.6)
    expect(Number(ratio)).toBeLessThanOrEqual(0.7)
    // And a surface's departure uses the rung below its own arrival, which has
    // to land in the same band or the rule only holds for small things.
    const slow = durationOf(tokens, '--app-motion-slow')
    const region = durationOf(tokens, '--app-motion')
    expect(region / slow, 'a surface exits in the same band as a region').toBeGreaterThanOrEqual(0.6)
    expect(region / slow).toBeLessThanOrEqual(0.7)
  })

  it('gives a whole surface long enough to be watched', () => {
    // The bands are the design's, and the reason they moved: at 220ms a dialog
    // read as a jump rather than a move — the eye got a before and an after and
    // no movement in between. Hover is deliberately *not* part of this: it is
    // feedback on something that has not gone anywhere, and a hover that takes
    // a third of a second feels broken in its own way.
    const bands: Array<[string, number, number]> = [
      ['--app-motion-fast', 100, 150],
      ['--app-motion', 250, 350],
      ['--app-motion-slow', 300, 500],
    ]
    for (const [token, lo, hi] of bands) {
      const value = durationOf(tokens, token)
      expect(value, `${token} (${value}ms) is in its band`).toBeGreaterThanOrEqual(lo)
      expect(value, `${token} (${value}ms) is in its band`).toBeLessThanOrEqual(hi)
    }
    // ...and a surface is slower than a region, or the rungs have stopped
    // meaning "how much of the screen this owns".
    expect(durationOf(tokens, '--app-motion-slow')).toBeGreaterThan(durationOf(tokens, '--app-motion'))
  })
})
