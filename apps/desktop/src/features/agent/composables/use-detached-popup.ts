/**
 * A popup that hangs off a control: where it goes, when it closes, and who owns Escape.
 *
 * The recipe is the app's own — `components/SelectMenu.vue` established it and says why each part
 * is there: teleported to the body and `position: fixed` (a popup drawn inside a scrolled pane
 * would be clipped by it), placed against the trigger and flipped above when the room below runs
 * out, dismissed on a pointer press outside, repositioned rather than dismissed when the viewport
 * moves **or when either box changes size**, and Escape claimed through the modal stack so the list
 * closes rather than the dialog behind it. `ui/ContextMenu.vue` is the same recipe for a menu
 * anchored to a point.
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

  /** Put the box against its trigger, inside the viewport: below the control, flipped above when
   *  that overflows, nudged sideways to fit. */
  async function place(): Promise<PopupPlacement | null> {
    await nextTick()
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
    const placed = await place()
    // Watched after the first measurement, because both boxes have to be in the document before
    // there is anything to watch — the popup is rendered by the caller's own `v-if` and exists
    // only after the `nextTick` `place` waits on.
    watchSize(true)
    return placed
  }

  function hide(): void {
    if (!open.value) return
    open.value = false
    modalStack.releaseModal(escapeToken)
    escapeToken = null
    watchViewport(false)
    watchSize(false)
  }

  onBeforeUnmount(hide)

  return { open, placement, show, hide }
}
