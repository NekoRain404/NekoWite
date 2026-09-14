/**
 * What a surface on its way out stops being: a place the user can be.
 *
 * A `<Transition>` keeps the leaving element *rendered* for the length of its
 * exit — that is the whole point of it, and it is why the fade is possible at
 * all. What it does not do is take the element out of the tab order, and an
 * element that is fading, out of flow and about to be removed is still a
 * perfectly good focus target: measured on this app's panels, a Tab pressed
 * inside the 195ms exit lands on a control in the departing column, and when
 * the exit ends that column is `display: none` (or unmounted) and the focus
 * falls to `document.body` — so the user's next keystrokes go to nothing at
 * all, which is how a polish item becomes a lost keystroke.
 *
 * `pointer-events` cannot answer this and no stylesheet can: the property that
 * removes a subtree from hit *testing* is not the one that removes it from the
 * tab order, and the property that removes it from the tab order — `visibility`
 * or `display` — is also the property that would take the fade away. `inert`
 * is both in one attribute, and it is the only one of the three that leaves the
 * pixels alone.
 *
 * Written as transition hooks rather than as a wrapper component because the
 * `<Transition>` has to stay where the state lives: the shell owns whether the
 * sidebar is shown, and the rail owns which of its six sections is up. Both
 * hand these two functions to their own `<Transition>`, which is one attribute
 * per direction and keeps the element's lifetime exactly where it was.
 *
 * The clearing half is not optional. These panels are toggled, so the exit can
 * be interrupted or followed by a later reopen, and an `inert` that was never
 * taken off would leave a column that is visible, laid out, and permanently
 * dead to both the pointer and the keyboard. `onEnter` is what guarantees it,
 * and it is the reason this is a pair of hooks and not a single `onLeave`.
 */

/** Vue hands a transition hook the element it is transitioning. */
type Hooked = Element | null | undefined

/** The exit has begun: the element is leaving and is no longer the user's. */
export function markLeaving(el: Hooked): void {
  if (el instanceof HTMLElement) el.inert = true
}

/** The exit was interrupted, or the element is arriving again. */
export function markArrived(el: Hooked): void {
  if (el instanceof HTMLElement) el.inert = false
}
