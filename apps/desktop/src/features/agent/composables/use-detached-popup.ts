/**
 * A popup that hangs off a control: where it goes, when it closes, and who owns Escape.
 *
 * The recipe is the app's own — `components/SelectMenu.vue` established it and says why each part
 * is there: teleported to the body and `position: fixed` (a popup drawn inside a scrolled pane
 * would be clipped by it), placed against the trigger and flipped above when the room below runs
 * out, dismissed on a pointer press outside, repositioned rather than dismissed when the viewport
 * moves, **when either box changes size, or when the trigger is carried somewhere by an animation**
 * — and Escape claimed through the modal stack so the list closes rather than the dialog behind it.
 * `ui/ContextMenu.vue` is the same recipe for a menu anchored to a point.
 *
 * It is here rather than copied into the picker because it is about *geometry and dismissal*
 * rather than about config options: the picker's own file was over the size this project allows
 * one component before the row it belongs to had even been wired to an engine, and this is the
 * half of it that would be identical in the next detached control.
 *
 * What it does not do: decide what is inside the popup, or whether it may open at all. `show`
 * is called by a control that has already decided it can be opened, and a popup the caller hides
 * is hidden — including on unmount, where the listeners and the claim are released with it.
 */
import { onBeforeUnmount, nextTick, ref, type Ref } from 'vue'
import { modalStack } from '../../../services/modal-stack'

export interface PopupPlacement {
  left: number
  top: number
  minWidth: number
  /** Which way it opened, so an arrival can come from the control it belongs to rather than
   *  from the gap on the other side of it. */
  drop: 'down' | 'up'
}

export interface DetachedPopup {
  /** Whether the popup is up. The caller renders it under this. */
  open: Ref<boolean>
  /** Where its element was put. */
  placement: Ref<PopupPlacement>
  /**
   * Open it: claim Escape, watch the viewport, measure, and hand back the box it was given so
   * the caller can do the one thing only it knows — focus whatever is inside.
   */
  show(): Promise<PopupPlacement | null>
  /** Close it. The caller decides where focus goes afterwards. */
  hide(): void
}

export interface DetachedPopupOptions {
  /** How narrow the box may be, in pixels: never narrower than its control, never wider than
   *  this. Zed's own picker floors at 20rems (`config_options.rs:343`). */
  floor: number
  /** The modal-stack name, so a stack trace says which popup claimed Escape. */
  claim: string
  /** The control it hangs from. */
  trigger: Ref<HTMLElement | null>
  /** Its element, or null while it has not rendered. */
  popup: () => HTMLElement | null
}

export function useDetachedPopup(options: DetachedPopupOptions): DetachedPopup {
  const open = ref(false)
  const placement = ref<PopupPlacement>({ left: 0, top: 0, minWidth: options.floor, drop: 'down' })
  /** Claimed while the popup is up, so Escape closes it rather than whatever is behind it. */
  let escapeToken: symbol | null = null

  /**
   * Put the box against its trigger, inside the viewport: below the control, flipped above when
   * that overflows, nudged sideways to fit.
   *
   * Synchronous, and that is what {@link followTrigger} needs: its loop runs once a frame and must
   * not have two placements in flight, so the part that measures and writes is separated from the
   * `nextTick` that waits for the caller's `v-if` to render the popup — {@link place} keeps that
   * await, and the await is real, because `options.popup()` answers null until it has.
   */
  function measurePlacement(): PopupPlacement | null {
    const trigger = options.trigger.value
    const popup = options.popup()
    if (trigger === null || popup === null) return null
    const pad = 8
    const anchor = trigger.getBoundingClientRect()
    const floor = Math.max(options.floor, Math.min(anchor.width, 280))
    const width = Math.max(popup.offsetWidth, floor)
    const height = popup.offsetHeight
    const below = anchor.bottom + 4
    const above = anchor.top - height - 4
    const dropsDown = below + height <= window.innerHeight - pad || above < pad
    placement.value = {
      left: Math.min(Math.max(pad, anchor.left), Math.max(pad, window.innerWidth - width - pad)),
      top: dropsDown ? Math.min(below, Math.max(pad, window.innerHeight - height - pad)) : above,
      minWidth: floor,
      drop: dropsDown ? 'down' : 'up',
    }
    return placement.value
  }

  async function place(): Promise<PopupPlacement | null> {
    await nextTick()
    return measurePlacement()
  }

  /**
   * The trigger, followed while it moves.
   *
   * It is here because the trigger can move *without* any of the three things this composable
   * watched — the window resizing, anything scrolling, a box changing **size** — and the
   * measurement is what says so. A `ResizeObserver` reports a box that grew; it reports nothing for
   * a box that was *carried*, because a `translate` and a `scale` leave every number of that box
   * unchanged. The rail arrives on exactly that (`appShell.css:181-185`: `--app-motion-drawer-offset`
   * as a `translate`, over `--app-motion-slow`), so a press that lands while the drawer is still
   * moving is placed against a control that has further to go. Measured in Chromium, the config
   * picker pressed the moment it existed: the list settled **55px** to the right of the control it
   * hangs four pixels off, and stayed there.
   *
   * **The instrument is the rectangle, read once a frame.** Not a `ResizeObserver` — see above —
   * and not the rail's own transition events alone, because the drawer is not the only thing that
   * can carry a control: this is the same shape the ComboBox and the select carry
   * (`components/ComboBox.vue`'s `followField`, ported from where that defect was measured), so the
   * blind spot is closed once for all three rather than three times by hand. The loop stops as soon
   * as two frames agree, which is the whole of the cost: three reads for an open with nothing
   * moving, and nothing at all once the control has arrived. The stop is a comparison of the
   * rectangle rather than a timeout, so no duration of the design system is repeated here.
   *
   * The popup's *own* box is not read here and does not need to be: {@link watchSize} observes it,
   * and that half is measured to work — a narrowing query in the session list re-places it within a
   * frame.
   */
  let follow = 0
  /** The rectangle as the last frame read it, and how many frames in a row have agreed. */
  let watched = ''
  let still = 0

  /** The trigger's placement-relevant geometry, as a string to compare frame against frame. Only
   *  the numbers {@link measurePlacement} reads: a rect that differs in a field nothing is placed
   *  from would keep the loop alive for a change no reader can see. */
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
      // The popup may have closed inside the frame (Escape, a choose, a press outside), and a frame
      // spent placing a box that is gone is a write to the *next* one's position.
      if (!open.value) return
      const now = rectKey()
      if (now !== watched) {
        watched = now
        still = 0
        measurePlacement()
      } else {
        // Two agreeing frames, not one: a spring has a frame of near-zero movement at its peak, and
        // a loop that stopped there would leave the box at the wrong end of the overshoot.
        still += 1
        if (still >= 2) return
      }
      follow = requestAnimationFrame(step)
    }
    follow = requestAnimationFrame(step)
  }

  /**
   * A movement starting under an open popup, taken from the DOM rather than waited for.
   *
   * `transitionrun` and `animationstart` bubble, so one listener on the document hears every
   * arrival in it, and the filter is what keeps that from being a re-place per hover colour: only a
   * target that is the control itself or a box *above* it can move the control. `transitionrun`
   * rather than `transitionstart`: it fires when the transition is created, before any delay, which
   * is the earliest moment the movement is a fact.
   */
  function onMotionStart(event: Event): void {
    if (!open.value) return
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

  function onPointerDown(event: PointerEvent): void {
    const target = event.target as Node
    // The trigger is not "outside": its own click owns the toggle, and dismissing here as well
    // would close and immediately reopen the list.
    if (options.trigger.value?.contains(target) === true) return
    if (options.popup()?.contains(target) === true) return
    hide()
  }

  function onViewportChange(): void {
    // Repositioned rather than dismissed, unlike a menu anchored to a point the user clicked:
    // the control is still on screen, and closing would lose the list the reader was reading.
    if (open.value) void place()
  }

  /**
   * The boxes whose change moves the popup, watched while it is up: the popup itself, and the
   * control it hangs from.
   *
   * **The popup's own box is the one that cannot be seen from outside.** `show` measures once, at
   * the instant the caller opens — and a popup is not a fixed size: this app's controls open
   * theirs before their content exists, because the content is a call's answer (the session list
   * is `session/list`, and it is asked for *as* the box appears). Measured on a 1400px window: the
   * history list was placed for the 219px box it had while the answer was in flight, then grew to
   * 290px when the rows arrived, which put its right edge 63px past the window and its ✕ — the
   * rightmost thing in a row — entirely outside it. Resizing the window re-placed it and every ✕
   * came back, which is what made timing the whole cause.
   *
   * The trigger is watched with it because the placement is measured against it: a control that
   * moves or changes width (a bar that wraps, a title that grew) moves the list, and `window`'s
   * own resize event does not fire for that.
   */
  let sized: ResizeObserver | null = null
  /** One re-place per frame: a list arriving is many boxes moving in one tick. */
  let frame = 0

  function schedule(): void {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      // The popup may have closed inside the frame, and a placement published for a box that is
      // gone would move the *next* one before it is measured.
      if (open.value) void place()
    })
  }

  function watchSize(watching: boolean): void {
    if (frame !== 0) {
      cancelAnimationFrame(frame)
      frame = 0
    }
    sized?.disconnect()
    sized = null
    if (!watching) return
    // Absent on old engines and in jsdom; the viewport listeners below still re-place this popup,
    // and a popup that is never re-placed is the behaviour this app had before.
    if (typeof ResizeObserver === 'undefined') return
    const popup = options.popup()
    const trigger = options.trigger.value
    if (popup === null && trigger === null) return
    sized = new ResizeObserver(() => schedule())
    for (const element of [popup, trigger]) {
      if (element !== null) sized.observe(element)
    }
  }

  function watchViewport(watching: boolean): void {
    // Written out rather than dispatched through `document[watching ? 'add' : 'remove'](...)`:
    // the computed method defeats overload resolution, and `onPointerDown` takes a `PointerEvent`,
    // which is not assignable to the generic `EventListener` its siblings satisfy.
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

  async function show(): Promise<PopupPlacement | null> {
    if (open.value) return placement.value
    open.value = true
    escapeToken = modalStack.claimModal(options.claim)
    watchViewport(true)
    watchMotion(true)
    const placed = await place()
    // Watched after the first measurement, because both boxes have to be in the document before
    // there is anything to watch — the popup is rendered by the caller's own `v-if` and exists
    // only after the `nextTick` `place` waits on.
    watchSize(true)
    // And the control is followed from here, because a movement that began before the press is one
    // no event of ours will announce — see `followTrigger()`.
    followTrigger()
    return placed
  }

  function hide(): void {
    if (!open.value) return
    open.value = false
    modalStack.releaseModal(escapeToken)
    escapeToken = null
    watchViewport(false)
    watchSize(false)
    watchMotion(false)
    stopFollowing()
  }

  onBeforeUnmount(hide)

  return { open, placement, show, hide }
}
