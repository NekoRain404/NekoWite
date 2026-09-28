import { nextTick, type Ref } from 'vue'
import type ComboBoxList from './ComboBoxList.vue'

type ComboPlacement = {
  left: number
  top: number
  minWidth: number
  maxWidth: number | null
  drop: 'down' | 'up'
}

export function useComboPlacement({ inputEl, listEl, open, pos }: {
  inputEl: Ref<HTMLInputElement | null>
  listEl: Ref<InstanceType<typeof ComboBoxList> | null>
  open: Ref<boolean>
  pos: Ref<ComboPlacement>
}) {
  /**
   * Put the popup against the field, inside the viewport: below the control, flipped
   * above when that overflows, nudged sideways to fit.
   *
   * Synchronous, and that is what `followField()` needs: the loop below runs once a frame and must
   * not have two placements in flight, so the part that measures and writes is separated from the
   * `nextTick` that waits for the list to exist. The await is real — `listEl` is rendered by the
   * `v-if` `show()` sets, and `measure()` answers null until it is — so it stays in {@link place}.
   */
  function measurePlacement(): void {
    const anchor = inputEl.value?.getBoundingClientRect()
    // Measured by the list, placed by the field: it is the field that can measure
    // its own anchor, and the list that holds the box to place against it.
    const box = listEl.value?.measure()
    if (!anchor || !box) return
    const pad = 8
    // The room the window gives a list — the window less the same pad it keeps from either edge — and
    // the field's own width, clamped into it. Those two are the whole of the popup's width rule:
    // never narrower than the field it belongs to, never wider than the window it is in. The
    // stylesheet declares neither, and the two that used to be there were both 280px — a
    // `Math.min(anchor.width, 280)` on this floor and a `max-width: 280px` on the list's own rule
    // (`ComboBoxList.vue`) — measured by `e2e/combo-popup-width.spec.ts` at 1280x800, where the
    // model field is 455px and the list opened at **280px inside it**, and stayed 280 while the user
    // dragged the dialog wider (the field went 455 -> 535). The floor's own inner 180 is for a field
    // *smaller* than a list can usefully be.
    const ceiling = Math.max(180, window.innerWidth - pad * 2)
    const floor = Math.min(Math.max(180, anchor.width), ceiling)
    // The box, not the rect: the rect is measured through the enter transition. And the clamp below
    // is against the width the popup will *have* — its content's, once the floor and the ceiling
    // have had their say — because the content's alone is the number that crosses the right edge.
    const width = Math.min(Math.max(box.width, floor), ceiling)
    const height = box.height
    const below = anchor.bottom + 4
    const above = anchor.top - height - 4
    // Which way it opened, carried through to the stylesheet: near the bottom of
    // the window the list flips above the field, and its arrival has to flip with
    // it. A list that sat above its field while rising into place from below would
    // arrive from a gap it never occupied. See SelectMenu.place, which this ports.
    const dropsDown = below + height <= window.innerHeight - pad || above < pad
    pos.value = {
      left: Math.min(Math.max(pad, anchor.left), Math.max(pad, window.innerWidth - width - pad)),
      top: dropsDown
        ? Math.min(below, Math.max(pad, window.innerHeight - height - pad))
        : above,
      minWidth: floor,
      maxWidth: ceiling,
      drop: dropsDown ? 'down' : 'up',
    }
  }

  async function place(): Promise<void> {
    await nextTick()
    measurePlacement()
  }

  /**
   * The field, followed while it moves.
   *
   * It is here because the anchor can move *without* any of the three things this component watches
   * — the window resizing, anything scrolling, its own boxes changing size — and the measurement is
   * what says so. The settings pages arrive through a `scale`/`translate` transition
   * (`SettingsPanel.vue:347-355`: `--app-motion-slow` on the surface spring), so a press that lands
   * while the AI page is still on its way in is placed against a field that goes on moving for the
   * length of the spring. Measured in Chromium, at 1280x720, with the press made in the same frame
   * the page swap starts: the list settled **20.719px below and 6.688px right** of the field it is
   * supposed to hang 4px off (and the stale number the report carried, 19.59px, is the same defect
   * at their window and their body size).
   *
   * **The instrument the report suggested would not have found it.** A `ResizeObserver` on the field
   * fires nothing for this: `scale` and `translate` are transforms, so the field's box never changes
   * size — measured, over the 17px that field travelled the observer reported not one callback. What
   * *is* observable is the rectangle itself, so one is read per frame — and the loop stops as soon
   * as two frames agree, which is the whole of the cost: three reads for an open with nothing
   * moving, and nothing at all once the field has arrived. The stop is a comparison of the rectangle
   * rather than a timeout, so no duration of the design system is repeated here; a spring's last
   * hundredth of a pixel keeps the loop alive for exactly as long as it takes, and the placement it
   * wrote is the one the field has come to rest at.
   *
   * Re-armed by {@link watchMotion} as well, and that half is not a refinement: the case the spec's
   * own flow measures is a press made *before* the page swap's spring has begun to move, where the
   * field's rectangle is still for the two frames the loop allows and the loop has stopped by the
   * time the transition starts — measured, that flow settled 16.5px out with the open alone arming
   * it. A movement that starts later announces itself (`transitionrun`, `animationstart`), so the
   * loop is re-armed from there rather than kept alive by a timer that would have to guess how long
   * an engine takes to begin.
   */
  let follow = 0
  /** The rectangle as the last frame read it, and how many frames in a row have agreed. */
  let watched = ''
  let still = 0

  /** The field's placement-relevant geometry, as a string to compare frame against frame. Only the
   *  numbers `measurePlacement` reads: a rect that differs in a field nothing is placed from would
   *  keep the loop alive for a change no reader can see. */
  function rectKey(): string {
    const rect = inputEl.value?.getBoundingClientRect()
    return rect === undefined ? '' : `${rect.top}:${rect.left}:${rect.width}:${rect.height}`
  }

  function stopFollowing(): void {
    if (follow !== 0) cancelAnimationFrame(follow)
    follow = 0
    watched = ''
    still = 0
  }

  function followField(): void {
    if (follow !== 0) return
    watched = rectKey()
    still = 0
    const step = (): void => {
      follow = 0
      // The list may have closed inside the frame (Escape, a commit, a press outside), and a
      // frame spent placing a popup that is gone is a write to the *next* one's position.
      if (!open.value) return
      const now = rectKey()
      if (now !== watched) {
        watched = now
        still = 0
        measurePlacement()
      } else {
        // Two agreeing frames, not one: a spring has a frame of near-zero movement at its peak, and
        // a loop that stopped there would leave the list at the wrong end of the overshoot.
        still += 1
        if (still >= 2) return
      }
      follow = requestAnimationFrame(step)
    }
    follow = requestAnimationFrame(step)
  }

  /**
   * A movement starting under an open list, taken from the DOM rather than waited for.
   *
   * `transitionrun` and `animationstart` bubble, so one listener on the document hears every arrival
   * in it, and the filter is what keeps that from being a re-place per hover colour: only a target
   * that is the field itself or a box *above* it can move the field. `transitionrun` rather than
   * `transitionstart`: it fires when the transition is created, before any delay, which is the
   * earliest moment the movement is a fact.
   */
  function onMotionStart(event: Event): void {
    if (!open.value) return
    const target = event.target
    const field = inputEl.value
    if (!(target instanceof Element) || field === null) return
    if (target !== field && !target.contains(field)) return
    followField()
  }

  function watchMotion(watching: boolean): void {
    if (watching) {
      document.addEventListener('transitionrun', onMotionStart)
      document.addEventListener('animationstart', onMotionStart)
    } else {
      document.removeEventListener('transitionrun', onMotionStart)
      document.removeEventListener('animationstart', onMotionStart)
    }
  }
  return { place, watchMotion, followField, stopFollowing }
}
