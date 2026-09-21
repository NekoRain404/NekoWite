import { declarations, read } from './motion-source'

/**
 * The motion token vocabulary: the ladder, the curves and the amplitudes, and
 * the reads that pull them out of `tokens.css`.
 *
 * Split out of `motion.test.ts` when that file crossed the line budget with 70
 * tests in it, so that the duration guards, the easing guards and the
 * choreography guards could each name the same vocabulary instead of restating
 * it. The values and the bands are unchanged; only the file they are read from
 * is.
 */

export const tokens = read('./tokens.css')

// The motion ladder, ordered by how far a thing travels and how much of the
// screen it owns. A step only earns its place if the class above or below it
// would be visibly wrong on it.
export const LADDER = [
  '--app-motion-micro',
  '--app-motion-fast',
  '--app-motion',
  '--app-motion-slow',
] as const

// Constant-rate motion is not a transition — a steady rotation or a text
// caret has no arrival to decelerate, so it sits outside the ladder.
export const CYCLIC = ['--app-motion-spin', '--app-motion-blink', '--app-motion-pulse'] as const

// One curve per *kind* of motion. A cubic bezier cannot ring, so the settle the
// arrival curve needs has to be a sampled spring; and a spring cannot be asked
// to behave like a state change, where it reads as mush. Collapsing these back
// onto one curve is the regression this guards.
export const BEZIER_CURVES = ['--app-ease', '--app-ease-exit', '--app-ease-attention'] as const
export const SPRING_CURVE = '--app-ease-surface'

// The departure fraction: an exit is not a rung, it is a cut-down entrance.
export const EXIT = '--app-motion-exit'

/** The arrival curve, by name, so a guard can ask where it was spent. */
export const CURVE_SURFACE = SPRING_CURVE

// There is one choreography value and it is a distance: how far a surface drifts
// while it settles.
//
// The stagger that used to sit beside it is gone, and its removal is the one
// assertion in the motion suite that was deliberately rewritten rather than
// satisfied. It used to read `--app-motion-stagger` here and, below, `expect(spent, 'the
// stagger token must actually be spent').toBeGreaterThan(0)` — the two together
// made a *cascade* mandatory: a parent fading in while its children faded in one
// after another. That is the "stacked animation" the brief rules out in so many
// words (一个交互动作只保留一个主动画 / 父容器淡入时，子项不再逐个淡入), and it is
// also the half of the arrival that could not be reversed, because a delay
// belongs to an animation and cancelling the animation drops the child straight
// to its resting state. The guards now run the other way, and the note
// beside each says what it supersedes.
export const CHOREOGRAPHY = ['--app-motion-travel'] as const

// How *much* things move, kept in tokens.css beside the durations so the next
// person tunes one place. Each is a fraction, and each has a band the brief
// names: the surface amplitude specifically may not go back up, because 4% on a
// wide dialog is 29px of travel under text that is trying to be read.
export const AMPLITUDES = {
  '--app-motion-scale-surface': [0.9, 0.99],
  '--app-motion-scale-pop': [0.9, 0.99],
  '--app-motion-press-scale': [0.9, 1],
} as const

export const durationOf = (css: string, token: string): number => {
  const m = css.match(new RegExp(`${token}:\\s*([\\d.]+)m?s\\b`))
  if (!m) throw new Error(`${token} is not defined with a time value`)
  return Number(m[1]) * (m[0].trimEnd().endsWith('ms') ? 1 : 1000)
}

export const curveOf = (token: string): string => {
  const m = tokens.match(new RegExp(`${token}:\\s*([^;]+);`))
  if (!m) throw new Error(`${token} is not defined`)
  return m[1].trim()
}

/** The spring, which is declared under its @supports guard rather than in :root. */
export const guardedCurve = (token: string): string => {
  // Read from the comment-stripped text all the way through: the prose above
  // the fallback names the guard, so searching the raw file finds that mention
  // and then hands back the fallback declaration instead of the spring.
  const bare = declarations(tokens)
  const at = bare.indexOf('@supports')
  if (at === -1) throw new Error(`${token} is not behind a support guard`)
  const m = bare.slice(at).match(new RegExp(`${token}:\\s*([^;]+);`))
  if (!m) throw new Error(`${token} is not declared under @supports`)
  return m[1].replace(/\s+/g, ' ').trim()
}

/** A `linear()` easing as the samples it is made of: value, and where it sits. */
export function springSamples(curve: string): { value: number; at: number }[] {
  const body = curve.replace(/^linear\(/, '').replace(/\)$/, '')
  return body.split(',').map((stop, i, all) => {
    const [value, position] = stop.trim().split(/\s+/)
    return {
      value: Number(value),
      at: position ? Number(position.replace('%', '')) : i === 0 ? 0 : i === all.length - 1 ? 100 : NaN,
    }
  })
}
