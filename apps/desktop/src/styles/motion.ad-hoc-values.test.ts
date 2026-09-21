import { describe, expect, it } from 'vitest'
import { declarations, read } from './motion-source'
import { MOTION_SURFACE } from './motion-surfaces'

/**
 * No ad-hoc motion values: every listed file animates only through the tokens.
 *
 * Split out of `motion.test.ts` when that file crossed the line budget with 70
 * tests in it. The rule is one line of assertion and forty-two cases — one per
 * listed surface — which is why it read as a footnote in the old file and reads
 * as the file's whole subject here. The cases and the assertion are unchanged in
 * the move; only the file is.
 */

describe('no ad-hoc motion values', () => {
  it.each(MOTION_SURFACE)('%s animates only through tokens', (file) => {
    // Prose may quote a duration to explain the scale, in a script no less than
    // in a stylesheet; that is documentation, not a value that reaches an
    // element. See `declarations`.
    const css = declarations(read(file), file)
      // The token definitions themselves: the one place a raw millisecond
      // value is allowed to appear.
      .replace(/--app-motion[\w-]*:\s*[\d.]+m?s\b/g, '')
      // The reduced-motion switch is the deliberate exception — its whole job
      // is to write a near-zero over every other duration.
      .replace(/[^;{}]*!important[^;{}]*/g, '')
    const literals = css.match(/[\d.]+m?s\b/g) ?? []
    expect(literals, `${file} still animates with raw durations`).toEqual([])
  })
})
