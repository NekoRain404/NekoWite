/**
 * The motion layer's sheets, in the order `main.ts` loads them.
 *
 * The motion guards read these sheets joined — the `motion.*.test.ts` files
 * through `motion-source.ts`, and `surface-exit.test.ts` directly — for the
 * same reason: several of their assertions are *negative*. `declarations(motion)`
 * must not hold a `.dialog :nth-child` rule; the exit guard asserts the absence
 * of `.dialog-enter-from`. A negative assertion run against a sheet that no
 * longer contains the selector passes while checking nothing, so a reader that
 * named one sheet would be checking whichever half happened to hold the rule on
 * the day it was written.
 *
 * That is why the list is one list and not two. A sheet added to one copy and
 * not the other is not a missing test — it is a guard that has silently stopped
 * reading a file, which is the whole failure mode this project has spent a day
 * on. The readers cannot simply import the list from one another: importing a
 * test module registers its suites, so `surface-exit.test.ts` importing a guard
 * from `motion.scale.test.ts` would run that file's tests inside its own. The
 * readers that are not guards themselves live in `motion-source.ts`, which is
 * why that module exists.
 */
export const MOTION_SHEETS = ['./surface-motion.css', './motion.css'] as const
