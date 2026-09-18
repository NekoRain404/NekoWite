/**
 * Where a select's list is drawn, and what keeps it there.
 *
 * `SelectMenu.vue` decides what a select *is* — the rows, the value, the keyboard that walks them,
 * the aria wiring a screen reader reads, and what a press commits. This decides the popup: the
 * arithmetic that puts it against its trigger inside the window, the loop that follows a trigger
 * something else is carrying, the listeners that re-place it rather than dismissing it, and the one
 * dismissal it has — a press outside both boxes. Those two are different subjects because they
 * change for different reasons: every width rule and every placement defect measured so far
 * (`e2e/select-popup-width.spec.ts`, `e2e/settings-resize.spec.ts`,
 * `e2e/select-popup-scope.spec.ts`) moved lines in this half alone, and a new key, a new row shape
 * or a new label never touches it.
 *
 * It was separated when the component reached 617 lines against this project's 600-line cap, and
 * the separation is a *move*: every comment below travelled with the code it explains, because what
 * they record — why the popup follows its trigger through scroll, motion and viewport changes — is
 * the reason the code has the shape it has.
 *
 * **What it does not own.** Whether the list is up: `open` is the caller's and is only read here,
 * because a loop that re-placed a closed list would write the *next* one's position. Why it closed:
 * `close` is the caller's own, called when a press lands outside both boxes — closing a select also
 * releases its modal-stack claim and forgets the active row, and neither is a fact about geometry.
 * And where the popup is *rendered*: that is `popup-host.ts`'s rule, applied by the component, which
 * is the half that holds the trigger at mount. This file owns coordinates.
 *
 * The recipe is the app's own and this is the select's copy of it: `use-detached-popup.ts` (under
 * `features/agent/composables/`) carries the same follow loop and the same dismissal, and
 * `ComboBox.vue` its version. The width rule below is the newest of the three — floor at the
 * control it belongs to, ceiling at the window it is in — and {@link measurePlacement} is where it
 * is stated.
 */
import { nextTick, ref, type Ref } from 'vue'

/** One placement: the popup's box in viewport coordinates, the two width bounds the caller's
 *  stylesheet declares neither of, and the edge it opened from. */
export interface SelectPopupPlacement {
  left: number
  top: number
  minWidth: number
  maxWidth: number | null
  drop: 'down' | 'up'
}

/** What the caller gets back. */
export interface SelectPlacement {
  /**
   * Where the popup was put, and which way it had to open. `drop` is not
   * geometry the component uses — it is what tells the stylesheet which edge of
   * the popup is the one touching the trigger, so the arrival can come from there
   * and the scale can grow out of it.
   *
   * `minWidth`/`maxWidth` are the popup's own bounds, *measured* rather than declared — see
   * {@link measurePlacement} for the two numbers and for why the stylesheet holds neither. */
  pos: Ref<SelectPopupPlacement>
  /** Forget the last placement, so the next open measures from a box that belongs to no trigger. */
  forget(): void
  /** Watch the viewport and the trigger, measure once, and start following. After `open` is true. */
  start(): void
  /** Release every listener and stop the follow loop. On the caller's close, and on its unmount. */
  stop(): void
}

export interface SelectPlacementOptions {
  /** The control it hangs from: what is placed against, and what the follow loop reads one frame at
   *  a time. */
  trigger: Ref<HTMLElement | null>
  /** Its element, or null while it has not rendered. */
  popup: Ref<HTMLElement | null>
  /** Whether the list is up. Read, never written — see the module docblock. */
  open: Ref<boolean>
  /** The caller's own close, for the one dismissal this module has. It decides *that* the press was
   *  outside both boxes; the caller decides what closing means. */
  close: () => void
}

export function useSelectPlacement(options: SelectPlacementOptions): SelectPlacement {
  /**
   * What a popup is placed *from* rather than to: enough width to exist, and no ceiling — a box
   * without one is what {@link measurePlacement} has to read to learn its content's width. `null`
   * and not `Infinity`, because `max-width: Infinitypx` is not a value.
   */
  const unplaced = (): SelectPopupPlacement => ({
    left: 0,
    top: 0,
    minWidth: 180,
    maxWidth: null,
    drop: 'down',
  })

  const pos = ref<SelectPopupPlacement>(unplaced())

  /**
   * Put the popup against its trigger, inside the viewport: below the control,
   * flipped above when that overflows, nudged sideways to fit.
   *
   * Synchronous, and that is what {@link followTrigger} needs — one loop, one placement in flight —
   * so the measuring half is separated from the `nextTick` that waits for the popup to exist, which
   * {@link place} keeps.
   */
  function measurePlacement(): void {
    const trigger = options.trigger.value
    const popup = options.popup.value
    if (!trigger || !popup) return
    const pad = 8
    const anchor = trigger.getBoundingClientRect()
    // The room the window gives a list — the window less the same pad it keeps from either edge — and
    // the control's own width, clamped into it. Those two are the whole of the popup's width rule:
    // never narrower than the control it belongs to, never wider than the window it is in. The
    // stylesheet declares neither, and the one that used to be there (`max-width: 280px`) was not a
    // ceiling but a second, smaller width — measured in Chromium at 1280x800 through
    // `e2e/select-popup-width.spec.ts`, every select in the settings dialog opened its list at
    // **280px inside a 526px control**, with the labels it exists to show ellipsised at the same
    // character the closed control had already ellipsised them at, and it stayed 280 while the user
    // dragged the dialog wider (the control went 526 -> 606). The floor's own inner 180 is for a
    // control *smaller* than a list can usefully be.
    const ceiling = Math.max(180, window.innerWidth - pad * 2)
    const floor = Math.min(Math.max(180, anchor.width), ceiling)
    // The box, not the rect: the rect is measured through the enter transition. And the clamp below
    // is against the width the popup will *have* — its content's, once the floor and the ceiling have
    // had their say — because the content's alone is the number that crosses the right edge.
    const width = Math.min(Math.max(popup.offsetWidth, floor), ceiling)
    const height = popup.offsetHeight
    const below = anchor.bottom + 4
    const above = anchor.top - height - 4
    // Which way it opened, decided once and carried through to the stylesheet: the
    // popup tells the user where it came from with the pixels it travels, and near
    // the bottom of the window that direction is *up*. A popup that flipped to sit
    // above its trigger while still rising into place from below would be
    // arriving from a gap it does not occupy — the same defect the heading menu
    // and the context menu were both moved off.
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
   * The trigger, followed while it moves — `ComboBox.vue`'s shape, where it was measured first, and
   * the same blind spot `SelectMenu.vue` and `use-detached-popup.ts` both had.
   *
   * The trigger can move *without* either of the two things watched for it — the window
   * resizing, anything scrolling — and a `ResizeObserver` cannot see it either, because `scale` and
   * `translate` leave every number of a box unchanged. The settings pages arrive through exactly that
   * spring (`SettingsPanel.vue`'s page swap), so a press landing while the page is still on its way
   * in is placed against a trigger that goes on moving. `e2e/select-popup-scope.spec.ts` is where
   * that was measured and where the numbers live.
   *
   * So the rectangle is read once a frame, and the loop stops as soon as two frames agree — three
   * reads for an open with nothing moving, and nothing once the trigger has arrived. The stop is the
   * rectangle rather than a timeout, so no duration of the design system is repeated here; two
   * agreeing frames rather than one, because a spring has a frame of near-zero movement at its peak.
   *
   * Re-armed by {@link watchMotion}, and that half is not a refinement: a press made *before* the
   * spring has begun leaves the rectangle still for the two frames this loop allows, so the loop has
   * stopped by the time the movement starts. A movement beginning later announces itself, and the
   * loop is re-armed from there rather than kept alive by a timer guessing an engine's delay.
   */
  let follow = 0
  /** The rectangle as the last frame read it, and how many frames in a row have agreed. */
  let watched = ''
  let still = 0

  /** The trigger's placement-relevant geometry as a string: only the numbers {@link measurePlacement}
   *  reads, so a change in a field nothing is placed from cannot keep the loop alive. */
  function rectKey(): string {
    const rect = options.trigger.value?.getBoundingClientRect()
    return rect === undefined ? '' : `${rect.top}:${rect.left}:${rect.width}:${rect.height}`
  }

  function stopFollowing(): void {
    if (follow !== 0) cancelAnimationFrame(follow)
    follow = 0
    watched = ''
    still = 0
  }

  function followTrigger(): void {
    if (follow !== 0) return
    watched = rectKey()
    still = 0
    const step = (): void => {
      follow = 0
      // The list may have closed inside the frame (Escape, a commit, a press outside), and a frame
      // spent placing a popup that is gone is a write to the *next* one's position.
      if (!options.open.value) return
      const now = rectKey()
      if (now !== watched) {
        watched = now
        still = 0
        measurePlacement()
      } else {
        // Two agreeing frames, not one: a spring has a frame of near-zero movement at its peak, and a
        // loop that stopped there would leave the list at the wrong end of the overshoot.
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
   * that is the trigger itself or a box *above* it can move the trigger. `transitionrun` rather than
   * `transitionstart`: it fires when the transition is created, before any delay.
   */
  function onMotionStart(event: Event): void {
    if (!options.open.value) return
    const target = event.target
    const trigger = options.trigger.value
    if (!(target instanceof Element) || trigger === null) return
    if (target !== trigger && !target.contains(trigger)) return
    followTrigger()
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

  function onPointerDown(e: PointerEvent): void {
    const target = e.target as Node
    // The trigger is not "outside": its own click handler owns the toggle, and
    // dismissing here as well would close and immediately reopen the list.
    if (options.trigger.value?.contains(target)) return
    if (options.popup.value?.contains(target)) return
    options.close()
  }

  function onViewportChange(): void {
    // Repositioned rather than dismissed, unlike ContextMenu: that one is anchored
    // to a point the user clicked and scrolling means it has moved on, while a
    // select belongs to a control still on screen — closing it as a pane scrolled
    // under it would lose the list the user was reading.
    if (options.open.value) void place()
  }

  function watchViewport(watching: boolean): void {
    // Written out rather than dispatched through `document[watching ? 'add' :
    // 'remove'](...)`: the computed method defeats overload resolution, and
    // `onPointerDown` takes a `PointerEvent`, which is not assignable to the
    // generic `EventListener` its sibling handlers satisfy. Explicit branches
    // typecheck without a cast and say the same thing.
    if (watching) {
      document.addEventListener('pointerdown', onPointerDown, true)
      window.addEventListener('resize', onViewportChange)
      window.addEventListener('scroll', onViewportChange, true)
    } else {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }

  /**
   * The placement is forgotten before the list is drawn again, and that is not a tidy-up: `pos`
   * outlives the popup, Vue renders the next one with the *last* `min-width` on its first frame,
   * and the first `measurePlacement` is usually the only one (the follow loop re-places a *moving*
   * trigger, and a list opened at rest has none). So the loop used to read a box the component had
   * sized for a previous, different trigger — invisible while the stylesheet pinned the width at
   * 280px, and a visible misplacement the moment the floor followed the control: measured through
   * `e2e/settings-resize.spec.ts`, the AI provider's list opened **87px to the left of its
   * control**, a `min-width: 908px` from a wider dialog entering the left clamp. Forgetting it
   * makes the placement idempotent, which is the property that was missing.
   */
  function forget(): void {
    pos.value = unplaced()
  }

  /**
   * Start keeping it there, from the owner's own open.
   *
   * After `open` is true, because every listener below reads it. Synchronous, so the first
   * measurement is in flight by the time the owner returns — and the trigger is followed from here
   * too, because a movement that began before the press is one no event of ours will announce: see
   * {@link followTrigger}, which is where that is measured.
   */
  function start(): void {
    watchViewport(true)
    watchMotion(true)
    void place()
    followTrigger()
  }

  function stop(): void {
    watchViewport(false)
    watchMotion(false)
    stopFollowing()
  }

  return { pos, forget, start, stop }
}
