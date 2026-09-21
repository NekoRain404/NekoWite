import { describe, expect, it } from 'vitest'
import { main, motion, read } from './motion-source'
import { MOTION_SURFACE } from './motion-surfaces'

/**
 * Reduced motion: the preference is honoured globally, swept last, and leaves
 * the user the final state rather than a stuck frame.
 *
 * Split out of `motion.test.ts` when that file crossed the line budget with 70
 * tests in it. It is a domain of its own — the one user setting the whole layer
 * has to answer to — and the guards are all about the sweep's *reach*: over
 * every listed file, over the delays as well as the durations, over the press
 * movement the sweep cannot fix by itself, and over `main.ts`'s import order.
 * The tests are unchanged in the move; only the file is.
 */

describe('reduced motion', () => {
  it('is honoured globally, not per component', () => {
    expect(motion).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    // Universal selector: a component added tomorrow is covered without its
    // author having to remember. `!important` is required because every Vue
    // scoped style is more specific than `*`.
    expect(motion).toMatch(/\*::before[\s\S]{0,40}\*::after/)
    expect(motion).toContain('animation-duration: 0.01ms !important')
    expect(motion).toContain('animation-iteration-count: 1 !important')
    expect(motion).toContain('transition-duration: 0.01ms !important')
    expect(motion).toContain('scroll-behavior: auto !important')
  })

  it('sweeps the stagger as well as the durations', () => {
    // The duration alone is not enough once anything is staggered. A stepped
    // child carries `backwards` fill, so neutralising its duration but leaving
    // its delay would hold it at the first keyframe — invisible — for the whole
    // delay and then snap it in. That is exactly the thing the preference
    // exists to prevent: content appearing late for no reason the user chose.
    expect(motion).toContain('animation-delay: 0ms !important')
  })

  it('switches the press movement off, rather than only making it instant', () => {
    // Neutralising a duration still lands the end state — a control that
    // shrinks under the finger with no animation at all is *more* jarring than
    // one that eases, not less, and it is still movement. So the press
    // transform is the one thing this round added that the sweep cannot cover
    // by itself, and it is switched off by name.
    const reduced = motion.slice(motion.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced, 'the press movement must be switched off, not just sped up').toMatch(
      /transform:\s*none/,
    )
  })

  it('leaves the reduced-motion user the final state, not a stuck frame', () => {
    // Neutralising an animation this way makes it finish instantly, and with
    // the default `animation-fill-mode: none` the element falls back to its
    // base style. `forwards`/`both` would instead freeze it on the last
    // keyframe — so a rule must always state its resting look outside the
    // keyframes, never inherit it from the animation.
    for (const file of MOTION_SURFACE) {
      const css = read(file)
      expect(css, `${file} must not freeze on the last keyframe`).not.toMatch(
        /animation(?:-fill-mode)?:[^;]*\b(?:forwards|both)\b/,
      )
    }
  })

  it('is the last layer loaded, so it governs every component', () => {
    const imports = [...main.matchAll(/^import\s+'([^']+)'$/gm)].map((m) => m[1])
    expect(imports.indexOf('./styles/motion.css')).toBe(imports.length - 1)
  })
})
