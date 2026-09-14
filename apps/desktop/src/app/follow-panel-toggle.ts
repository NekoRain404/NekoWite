/**
 * The content follows the columns.
 *
 * The toolbars' toggle is a layout change: the sidebar and the note list occupy
 * half a screen between them, and when they close the flex row gives that width
 * back in the single frame the user clicked in. That reflow is not something to
 * animate away — animating the *width* is what re-wraps the body for the whole
 * of the movement, which is the one thing the design explicitly rules out
 * (打开侧栏不要让正文连续数十帧重新换行), and a WebKitGTK measurement of it
 * cost 42ms → 461ms input-to-paint against 46ms → 40ms when nothing re-wrapped.
 * One reflow, in the click frame, is what this app has always done.
 *
 * What is added is the half a reflow cannot give: the *displacement*. The
 * content's origin moves by the width of the cluster, and moving it back over
 * the length of the panel's own transition turns a teleport into a glide. A
 * `translate` is composited, so text that moves does not re-flow — the text is
 * at its final width from the first frame and only its position is animated.
 *
 * **Why this is measured rather than declared.** The obvious shape is a pair of
 * keyframes selected by a class, and it is wrong at exactly the moment this work
 * exists for: reverse the toggle mid-flight and the class flips, the keyframe
 * changes, and the content snaps to the other end of its travel — a jump of the
 * whole cluster's width, in the opposite direction from the one the user just
 * asked for. I watched it do that. A transition interpolates from the computed
 * value, which is what makes the panels themselves reversible, so the content's
 * starting point has to be *read* rather than assumed: measure where the box is
 * on screen, let the DOM patch, measure again, and hand the difference back as
 * the transition's start. On a reversal the second measurement is taken through
 * the running transform, so the glide continues from wherever it had got to.
 *
 * Nothing here gates anything. The measurement is a read, the styles are
 * presentational, and the whole thing runs inside the frame the class change
 * was already going to take — the state is correct before any of it happens,
 * which is the premise the rest of this layer is built on.
 */
import { nextTick, watch, type Ref } from 'vue'

/** Below this, the box did not move and a glide would be a lie. */
const NEGLIGIBLE_PX = 1

/**
 * Arrange for `el` to travel from wherever it is now to wherever the layout has
 * just put it, over `duration` (a token name, so the timing comes from
 * tokens.css like every other duration here). The curve is `--app-ease-travel`,
 * which is symmetric: a half-screen move on an ease-out lurches off the line and
 * one on an exit curve stops dead on arrival, and both were measured (see the
 * token). The *durations* stay the panel's own — 300ms in, 195ms out — so the
 * two halves of the gesture still finish together.
 */
function glide(el: HTMLElement | null, fromLeft: number, duration: string): void {
  if (!el) return
  // Stand the element up with no transform at all before reading where the
  // layout has put it. A reversal lands *inside* the previous glide, so the
  // rect would otherwise be the new layout position plus the old transform
  // still running — a number that is neither, and a displacement computed from
  // it overshoots by exactly the part of the old glide that had not finished.
  // (That is what the second version of this did, and the content jumped by the
  // cluster's width on every reversal.)
  el.style.transition = 'none'
  el.style.translate = '0px'
  void el.offsetWidth
  const layoutLeft = el.getBoundingClientRect().left
  const dx = fromLeft - layoutLeft
  if (Math.abs(dx) < NEGLIGIBLE_PX) return
  // Plant the box where the user last saw it, and commit that: the reflow is
  // what makes the next assignment a *change* the browser can interpolate
  // rather than a second value in the same style computation.
  el.style.translate = `${dx}px 0`
  void el.offsetWidth
  // `transitionend` bubbles, and this element is the whole content area — the
  // first hover anywhere inside it would otherwise fire this handler, clear the
  // displacement mid-flight, and leave the next toggle measuring a box that had
  // already snapped home. (It did exactly that: the reversal jumped by the full
  // width of the cluster because a descendant's transition had ended first.) So
  // the event has to be ours: this element, this property.
  const clear = (event: TransitionEvent): void => {
    if (event.target !== el || event.propertyName !== 'translate') return
    el.style.transition = ''
    el.style.translate = ''
    el.removeEventListener('transitionend', clear)
  }
  // A timer would do the same job, but this is the element saying it arrived,
  // and nothing behind it is waiting: the inline transition goes away with the
  // displacement, so the element is left exactly as the stylesheet describes it
  // and a later toggle starts from a clean box.
  el.addEventListener('transitionend', clear)
  el.style.transition = `translate ${duration} var(--app-ease-travel)`
  el.style.translate = ''
}

/**
 * Watch a panel's visibility and glide `el` behind it.
 *
 * `flush: 'sync'` is load-bearing and it is not a style preference. The reading
 * has to be taken while the box is still where the user can see it, and a
 * default (`pre`) watcher only *usually* runs before the patch — when it does
 * not, `el.value` can be null or the box can already have moved, and the
 * compensation is then computed from a position that never existed. That is not
 * hypothetical: the first version of this used `?? 0` for the missing element
 * and the reversal jumped by the full width of the cluster, because "no
 * measurement" silently became "the box is at the left edge".
 *
 * So: read synchronously, and if there is nothing to read, do nothing. A glide
 * that does not happen leaves the content where the layout put it, which is
 * exactly where it was before this module existed.
 */
export function useFollowPanel(el: Ref<HTMLElement | null>, visible: () => boolean): void {
  watch(
    visible,
    (open: boolean) => {
      const box = el.value
      if (!box) return
      const fromLeft = box.getBoundingClientRect().left
      void nextTick(() => {
        // Same *durations* as the panel's own fade either way, so the two halves
        // of the gesture finish together — but the **arriving** curve in both
        // directions, never the departing one. `--app-ease-exit` accelerates
        // away from where it started and stops dead on arrival, which is right
        // for a panel the user is done with and wrong for content that is being
        // *put somewhere*: measured on a 528px close, the per-frame steps ran
        // 26 → 64 → 89 → 107 → 124 → 118 px and then zero. On `--app-ease` the
        // movement is spent early and the last frames are a settle into place,
        // which is the same shape the open already had.
        glide(
          el.value,
          fromLeft,
          open ? 'var(--app-motion)' : 'var(--app-motion-exit)',
        )
      })
    },
    { flush: 'sync' },
  )
}
