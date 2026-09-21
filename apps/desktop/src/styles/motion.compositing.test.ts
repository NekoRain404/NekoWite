import { describe, expect, it } from 'vitest'
import { declarations, read } from './motion-source'
import { MOTION_SURFACE } from './motion-surfaces'

/**
 * Compositing discipline: when a layer promotion is allowed to be taken out.
 *
 * Split out of `motion.test.ts` when that file crossed the line budget with 70
 * tests in it. It is a small domain and a separate one — promotion is memory and
 * text rendering, not timing — and it was the file's only guard on it. The test
 * is unchanged in the move; only the file is.
 */

describe('compositing discipline', () => {
  it('takes out a promotion only where it is about to be spent', () => {
    // Promotion is a loan against memory and against text rendering: a promoted
    // layer is composited on its own and loses subpixel antialiasing, so a
    // dialog held on its own layer for its whole life renders its text worse
    // than one that is not. Taken out on a transitioning state, though, it buys
    // the exact frame it is for — the element is about to move and the browser
    // would otherwise promote it one frame late.
    let loans = 0
    for (const file of MOTION_SURFACE) {
      for (const [, selector, body] of declarations(read(file), file).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/will-change:/.test(body)) continue
        loans++
        expect(selector, `${file}: ${selector.trim()} holds a promotion at rest`).toMatch(
          /-(?:enter|leave)-active/,
        )
      }
    }
    expect(loans, 'the promotion must actually be used somewhere').toBeGreaterThan(0)
  })
})
