import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { declarations, motion, read } from './motion-source'
import { MOTION_DECLARATION, MOTION_SURFACE, SHARED_ARRIVAL, wearsArrival } from './motion-surfaces'

/**
 * The surface list itself.
 *
 * Split out of `motion.test.ts` when that file crossed the line budget with 70
 * tests in it. This is the domain the rest of the guards depend on: `MOTION_SURFACE`
 * is only worth what its entries are worth, so the list is the first thing
 * asserted — every path exists, every path still renders motion, and every
 * shared class it can be listed for is a class `motion.css` actually animates.
 * The tests and the list are unchanged in the move; only the file is.
 */

describe('the surface list itself', () => {
  it('names a shared class that motion.css actually animates', () => {
    // Wearing the shared arrival is only a reason to be on the list while the
    // arrival is there: a `.dialog` that `motion.css` stopped animating would
    // leave the five dialogs listed for motion nothing declares.
    for (const cls of SHARED_ARRIVAL) {
      expect(motion, `.${cls} is the class motion.css gives the arrival to`).toMatch(
        new RegExp(`\\.${cls}\\s*\\{[^}]*animation:`),
      )
    }
  })

  it('lists only files that exist and still render motion', () => {
    for (const file of MOTION_SURFACE) {
      expect(
        existsSync(resolve(__dirname, file)),
        `${file} is listed as a motion surface and is not there`,
      ).toBe(true)
      // Read stripped, prose and all: a file's own comment naming `.dialog` is
      // documentation and not a class it puts on anything.
      const text = declarations(read(file), file)
      expect(
        MOTION_DECLARATION.test(text) || wearsArrival(text),
        `${file} is listed as a motion surface and no longer renders motion`,
      ).toBe(true)
    }
  })
})
