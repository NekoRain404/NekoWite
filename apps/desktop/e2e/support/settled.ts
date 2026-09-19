/**
 * Wait until the named roots have stopped moving, before a case reads a box or a position off them.
 *
 * A rectangle read while the thing it belongs to is still arriving is a reading of the *motion*,
 * not of the layout: `getBoundingClientRect()` is measured through a transform, so a surface whose
 * arrival is a `scale` or a `translate` reports a box that is smaller, or somewhere else, than the
 * one the engine laid out. That is what `settings-scroll-reset.spec.ts`'s `landed` was written for,
 * where the pet rail's page root settles on exactly `108.5` and `Math.round`'s half-up rule turned
 * 0.0048px of an unfinished 6px entry translate into a whole pixel of verdict (`b36f5a2`).
 *
 * **The condition is asked of the animations, not of two samples.** Comparing consecutive readings
 * was that fix's first attempt and it is not proof: two samples a frame apart can be the same main
 * thread frame, or both inside the flat tail before a spring's last frame lands, and a run took the
 * wrong value through exactly that gap. What has to be true is that the arrival has *finished*.
 *
 * **Why an endless animation cannot hold a reading back.** Only a *running* animation that has an
 * end counts, so a spinner, a pulse or a blinking caret under one of these roots is never something
 * a reader waits for — and a perpetual one can never stall it. A CSS transition and a finite
 * keyframe animation both end, so the wait is bounded by the longest arrival that is actually in
 * flight, and {@link SETTLE_TIMEOUT_MS} is what says a wait that cannot finish is a failure rather
 * than a reader that hangs for ever.
 *
 * **Why the boxes are asked about as well as the animations.** An animation that has not been
 * *created* yet is invisible to `getAnimations()` — and Vue holds a `<Transition>`'s element in its
 * `-enter-from` state for a frame *before* the transition exists, so a reader that asked only about
 * animations between the insert and that frame would be answered instantly and would measure the
 * first frame of the arrival. That is not hypothetical: measured in Chromium on this tree, the
 * select popup below reads `515.48` in its `-enter-from` state against `526` once still (its rung
 * is `scale(0.98)`), and a `settled` that asks only about animations returns immediately when it is
 * called on that frame. So each root is also required not to be *carried* — no `transform`, `scale`,
 * `translate` or `rotate` in its computed style — and neither is any element between it and the
 * document root, because an ancestor's transform is what carries a child's rectangle — for
 * `position: fixed`, it is also the containing-block rule `components/popup-host.ts` exists for —
 * and an ancestor's *own* animation is not in the descendant's subtree.
 *
 * The one cost of that second question is deliberate: if an ancestor ever carries a *permanent*
 * transform, this wait times out and says so rather than reading through it. That is a rectangle
 * this reader cannot check the way it means to, which is worth saying out loud — every root in this
 * suite has a clean chain today, and a case that starts failing here is a case whose reading needs
 * a decision rather than a wider tolerance.
 */
import type { Page } from '@playwright/test'

/** How long a reader waits for the arrivals to end before calling the tree unsettleable. */
const SETTLE_TIMEOUT_MS = 5000

/** The four computed properties that carry a box: each is `none` on an element nothing moves. */
const CARRIERS = ['transform', 'scale', 'translate', 'rotate'] as const

/**
 * Resolve once nothing under every selector names an arrival still in flight, and no box on the
 * chain to the document root is being carried somewhere by one.
 *
 * A selector matching nothing is *not* settled: it waits, and the timeout is what reports it. A
 * root that is not in the document cannot be read, so answering "yes" for it would let a case that
 * misspelled a root — or read one that has already gone — pass on exactly the reading it exists to
 * take. Callers reach this after their own `waitFor` on the element, so a root that never appears
 * is a failure the caller's own wait would have reported first.
 */
export async function settled(page: Page, roots: readonly string[]): Promise<void> {
  await page.waitForFunction(
    ({ selectors, carriers }: { selectors: readonly string[], carriers: readonly string[] }) => {
      /** A running animation with an end — a finite one is an arrival, an endless one is a pulse. */
      const arriving = (animations: readonly Animation[]): boolean =>
        animations.some((animation) => {
          if (animation.playState !== 'running') return false
          const timing = animation.effect instanceof KeyframeEffect
            ? animation.effect.getTiming()
            : null
          return timing === null || timing.iterations !== Infinity
        })

      /** Whether this element's own box is being carried by a transform right now. */
      const carried = (element: Element): boolean => {
        const style = getComputedStyle(element)
        return carriers.some((name) => style.getPropertyValue(name) !== 'none')
      }

      return selectors.every((selector) => {
        const root = document.querySelector(selector)
        if (root === null) return false
        if (arriving(root.getAnimations({ subtree: true }))) return false
        for (let node: Element | null = root; node !== null; node = node.parentElement) {
          if (carried(node)) return false
          // The root's own animations are in the subtree read above; an ancestor's are not, and an
          // ancestor mid-arrival is one of the ways its child's rectangle is not the laid-out box.
          if (node !== root && arriving(node.getAnimations())) return false
        }
        return true
      })
    },
    { selectors: roots, carriers: [...CARRIERS] },
    { timeout: SETTLE_TIMEOUT_MS },
  )
}
