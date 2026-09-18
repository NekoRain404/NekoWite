/**
 * How big the settings dialog is, where that answer lives, and what a drag on its corner means.
 *
 * ## One home for the size, and it is this file
 *
 * The dialog used to be sized by two declarations in its own stylesheet —
 * `width: min(720px, 100%); height: min(520px, 100%)` — which was one answer in one place, and
 * correct for as long as nobody could change it. A drag makes the size *state*, and a size that is
 * state and also a stylesheet constant is the two-answers defect this repository spent two days
 * removing: the first drag would write an inline width the stylesheet's `min()` still capped, and
 * the handle would then sit somewhere the box was not. So the stylesheet declares no size at all
 * for the dialog any more — it keeps only `max-width`/`max-height: 100%`, which is the *bound*
 * rather than the value — and every pixel of it comes from here, the clean-install default
 * included.
 *
 * The same rule is why the drag reads the room it has from the overlay's own measured box instead
 * of naming the 24px of padding that box is inset by (`SettingsPanel.vue`'s `.settings-overlay`):
 * the stylesheet owns that number, and a `24` written here as well would be a second copy of it
 * that a change to the padding would silently outdate. `DIALOG_BOUNDS_FALLBACK` is the one number
 * this file does carry, and it carries it for hosts with no layout at all — jsdom, a detached page
 * — where it is never rendered; `settings-resize.spec.ts` measures it against the stylesheet's own
 * padding so the two cannot drift.
 *
 * ## The drag, and why it is twice the distance from the centre
 *
 * The dialog is centred in its overlay, so its corner is not a fixed distance from any edge. The
 * obvious drag — add the pointer's delta to the size, which is exactly what
 * `ui/LayoutResizeHandle.vue` does for the sidebar and the rail — is wrong here, and wrong in a way
 * that reads as "the handle is sluggish": the box grows by the delta in *both* directions, so the
 * corner travels at half the pointer's speed and stops short of where the user let go. The
 * relation that keeps the corner under the pointer for a centred box is `size = 2 * |p - c|`, and
 * it is continuous at the grab — the pointer is already at the corner, so it is already at
 * `c + size/2`.
 *
 * ## No transition, on purpose
 *
 * The size is written straight from the pointer, on the frame the pointer moved, and the
 * stylesheet puts no `transition` on the dialog's `width`/`height`. That is §7.3's 正文稳定 applied
 * where it is strongest: an animated resize moves every line of text in the dialog for as long as
 * the curve runs, for a movement the user did not ask for and cannot stop. A drag is not an
 * animation — it is the user's own motion, one-to-one, interruptible at any frame — and the
 * `transition: none` below is asserted rather than assumed so that nobody re-adds one.
 *
 * The write is coalesced to one per frame (the pointer can move several times between paints), so
 * the worst case is one reflow per painted frame — the floor for a live resize, and the same
 * device `LayoutResizeHandle` uses for the rail.
 */
import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from 'vue'
import { persistence } from '../../../services/persistence'
import { readNumber } from '../../../stores/settings-persist'

/** Where the two halves of the size are stored. Scalar keys, like every other setting. */
export const DIALOG_SIZE_KEY_WIDTH = 'nekowite.settings.dialogWidth'
export const DIALOG_SIZE_KEY_HEIGHT = 'nekowite.settings.dialogHeight'

/** What the dialog opens at, and what a double-click on its corner puts it back to. */
export const DIALOG_WIDTH_DEFAULT = 720
export const DIALOG_HEIGHT_DEFAULT = 520

/**
 * The smallest the dialog may be dragged.
 *
 * Measured rather than chosen (`e2e/scratch-bounds` swept the eight sections at nine sizes and
 * reported, per section, any element whose content overflowed its own box and any control whose box
 * escaped the dialog's): the first size at which a settings page clips is **360x300**, where the AI
 * section's model field overflows its row, and every size from **420x320** up is clean on all eight
 * sections. The floor is 480x360 — 60px and 40px of headroom over the last clean size — because the
 * sweep is taken on a page where the five profile pages of the agents tree are in their *unread*
 * state and therefore narrower than their real content, so the true floor is somewhere above the
 * one this host can measure and the error has to be in that direction.
 */
export const DIALOG_WIDTH_MIN = 480
export const DIALOG_HEIGHT_MIN = 360

/** What an arrow key moves each axis by. The panes' own handle steps 16 as well. */
export const DIALOG_SIZE_STEP = 16

/**
 * The room a dialog gets when there is no box to measure.
 *
 * The 1280x800 window every measurement in this programme is taken at, less the overlay's own
 * padding on each side — the same arithmetic `SettingsPanel.vue`'s `.settings-overlay` performs in
 * CSS, and `settings-resize.spec.ts` reads the stylesheet to assert the two still agree. This is
 * only ever the answer for a host that has no layout: a real window measures its own overlay.
 */
export const DIALOG_OVERLAY_PADDING = 24
export const DIALOG_BOUNDS_FALLBACK = {
  width: 1280 - 2 * DIALOG_OVERLAY_PADDING,
  height: 800 - 2 * DIALOG_OVERLAY_PADDING,
} as const

/** A width and a height in CSS pixels. */
export interface DialogSize {
  width: number
  height: number
}

/** The largest size the window allows. Never smaller than the floors. */
export type DialogBounds = DialogSize

/** A point in client coordinates. */
export interface DialogPoint {
  x: number
  y: number
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/**
 * Hold a wanted size inside what the window allows.
 *
 * The floor wins a disagreement, because the two ends mean different things: the upper bound is
 * "the window is not that big", which is a fact about the room, while the floor is "the dialog
 * cannot render below this", which is a fact about the dialog. A window narrower than the floor is
 * a window this product cannot be in (`tauri.conf.json`'s `minWidth: 860`), so the only way to
 * reach the disagreement is a host that reports no layout at all — and there, a dialog at its floor
 * is a dialog, while a dialog of negative width is not.
 */
export function clampDialogSize(size: DialogSize, bounds: DialogBounds): DialogSize {
  const width = Math.max(DIALOG_WIDTH_MIN, Math.floor(bounds.width))
  const height = Math.max(DIALOG_HEIGHT_MIN, Math.floor(bounds.height))
  return {
    width: clamp(Math.round(size.width), DIALOG_WIDTH_MIN, width),
    height: clamp(Math.round(size.height), DIALOG_HEIGHT_MIN, height),
  }
}

/**
 * The size a centred dialog takes when its corner is dragged to `pointer`.
 *
 * `2 * |p - c|` per axis, which is the only relation that keeps the corner under the pointer for a
 * box centred at `c` — see this file's header. The result is floored, so a pointer that has been
 * dragged inside the centre reports the smallest dialog rather than a collapsed one; the upper end
 * is the caller's to clamp because only the caller can measure the window.
 */
export function sizeFromPointer(pointer: DialogPoint, center: DialogPoint): DialogSize {
  return {
    width: Math.max(DIALOG_WIDTH_MIN, Math.round(2 * Math.abs(pointer.x - center.x))),
    height: Math.max(DIALOG_HEIGHT_MIN, Math.round(2 * Math.abs(pointer.y - center.y))),
  }
}

/**
 * The size the last session left, held inside the room a dialog gets when nothing can be measured.
 *
 * Per axis, so a key someone hand-edited into nonsense costs one dimension rather than both — the
 * same reading `readNumber` gives every other numeric setting.
 */
export function readStoredDialogSize(): DialogSize {
  return clampDialogSize(
    {
      width: readNumber(DIALOG_SIZE_KEY_WIDTH, DIALOG_WIDTH_DEFAULT),
      height: readNumber(DIALOG_SIZE_KEY_HEIGHT, DIALOG_HEIGHT_DEFAULT),
    },
    DIALOG_BOUNDS_FALLBACK,
  )
}

export interface UseDialogSizeOptions {
  /**
   * The overlay the dialog is centred in: the element whose content box is the room a drag has.
   *
   * Passed in rather than measured from the dialog, because the dialog's own box is the thing being
   * decided — a drag that clamped against it would ratchet, each frame's answer becoming the next
   * frame's bound.
   */
  overlayRef: Ref<HTMLElement | null>
}

export interface DialogSizeModel {
  /** The size to render at, already held inside the window the app is in. */
  rendered: ComputedRef<DialogSize>
  /** The largest the window allows right now. Exposed for the handle's `aria-valuemax`. */
  bounds: ComputedRef<DialogBounds>
  /** Whether a pointer drag is in progress, for the handle's own pressed state. */
  dragging: Ref<boolean>
  /** Bind to the handle's `pointerdown`. */
  onHandlePointerDown: (event: PointerEvent) => void
  /** Bind to the handle's `keydown`: arrows one step, Home the floor, End the window. */
  onHandleKeydown: (event: KeyboardEvent) => void
  /** Bind to the handle's `dblclick`: back to the clean-install size. */
  onHandleDoubleClick: () => void
}

/**
 * The dialog's size, its persistence, and the drag on its corner.
 *
 * The whole of the state is `size` — one ref, one writer per gesture — and `rendered` is a view of
 * it through the window's current bounds. Nothing else holds a width or a height: the stylesheet
 * has none, `SettingsPanel.vue` has none, and a reader looking for "how big is the dialog" has one
 * file to open.
 */
export function useDialogSize(options: UseDialogSizeOptions): DialogSizeModel {
  const { overlayRef } = options

  /** The size the user asked for. Survives a window that cannot hold it. */
  const size = ref<DialogSize>(readStoredDialogSize())
  const dragging = ref(false)

  /**
   * The window the app is in, as a ref so the clamp below recomputes when it changes.
   *
   * Read from `innerWidth`/`innerHeight` rather than from the overlay alone: the overlay is
   * `position: fixed; inset: 0`, so the window *is* its border box, and a page mid-mount has an
   * overlay but no box yet.
   */
  const viewport = ref({ width: 0, height: 0 })
  function measureViewport(): void {
    viewport.value = { width: window.innerWidth, height: window.innerHeight }
  }

  /**
   * The room a drag has, measured from the overlay's own content box.
   *
   * The overlay is the flex container the dialog is centred in and it is `inset: 0` with padding,
   * so its content box is exactly the area a dialog may occupy — the same area the stylesheet's
   * `max-width: 100%` resolves against, which is what keeps the drag's ceiling and the render's
   * ceiling the same number instead of two numbers that have to be kept equal by hand.
   */
  function measureBounds(): DialogBounds {
    const overlay = overlayRef.value
    if (overlay === null || viewport.value.width === 0) return DIALOG_BOUNDS_FALLBACK
    const style = getComputedStyle(overlay)
    const horizontal = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
    const vertical = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
    const width = overlay.clientWidth - (Number.isFinite(horizontal) ? horizontal : 0)
    const height = overlay.clientHeight - (Number.isFinite(vertical) ? vertical : 0)
    // A box that is not laid out yet answers 0, and 0 is the one answer that must not be believed:
    // it would clamp every stored size down to the floor on the frame before the layout arrives.
    if (width <= 0 || height <= 0) return DIALOG_BOUNDS_FALLBACK
    return { width, height }
  }

  const bounds = computed<DialogBounds>(() => {
    // `viewport` is read so the computed re-runs on a window resize; the measurement itself is the
    // overlay's, which is what makes the padding the stylesheet's number and not this file's.
    void viewport.value
    return measureBounds()
  })

  /**
   * What to render at, held inside the window the app is in *now*.
   *
   * A window that shrank under a stored size is answered here and not by writing the shrunk value
   * back: `size` keeps what the user asked for, so growing the window again puts the dialog back
   * where they left it rather than making them drag it a second time. A second window, a narrower
   * one, is a rendering condition — not a reason to forget a size the user chose.
   */
  const rendered = computed<DialogSize>(() => clampDialogSize(size.value, bounds.value))

  function commit(): void {
    persistence.set(DIALOG_SIZE_KEY_WIDTH, String(size.value.width))
    persistence.set(DIALOG_SIZE_KEY_HEIGHT, String(size.value.height))
  }

  /** Write a wanted size, held inside the window, and record it. */
  function apply(next: DialogSize): void {
    size.value = clampDialogSize(next, bounds.value)
    commit()
  }

  /**
   * Where the dialog is centred, in client coordinates.
   *
   * From the overlay's *border* box, because `justify-content: center` centres inside the content
   * box and the padding is symmetric — so the centre of the two boxes is the same point, and the
   * border box is the one that does not need the padding parsed a second time.
   */
  function center(): DialogPoint {
    const overlay = overlayRef.value
    if (overlay === null) return { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    const box = overlay.getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  }

  let drag: {
    onMove: (event: PointerEvent) => void
    onUp: () => void
    flush: () => void
  } | null = null

  function stopDrag(): void {
    const current = drag
    if (current === null) return
    drag = null
    dragging.value = false
    document.body.classList.remove('is-dialog-resizing')
    window.removeEventListener('pointermove', current.onMove)
    window.removeEventListener('pointerup', current.onUp)
    window.removeEventListener('pointercancel', current.onUp)
  }

  function onHandlePointerDown(event: PointerEvent): void {
    if (event.button > 0) return
    event.preventDefault()
    const middle = center()
    let pending: PointerEvent | null = null
    let last: PointerEvent | null = null
    let raf = 0
    // One write per painted frame. `pointermove` fires far faster than the display paints, and the
    // dialog holds a scrolling page of text: a write per event would reflow it several times per
    // frame for a movement the frame can only show once.
    const onMove = (pointerEvent: PointerEvent): void => {
      last = pointerEvent
      pending = pointerEvent
      if (raf !== 0) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (pending === null) return
        size.value = clampDialogSize(
          sizeFromPointer({ x: pending.clientX, y: pending.clientY }, middle),
          bounds.value,
        )
        pending = null
      })
    }
    // The release writes the pointer's final position even when a frame is already queued —
    // `last` survives the callback clearing `pending`, so a release right after a flush still
    // lands where the user let go.
    const flush = (): void => {
      if (raf !== 0) {
        cancelAnimationFrame(raf)
        raf = 0
        if (last !== null) {
          size.value = clampDialogSize(
            sizeFromPointer({ x: last.clientX, y: last.clientY }, middle),
            bounds.value,
          )
        }
      }
      pending = null
    }
    const onUp = (): void => {
      flush()
      stopDrag()
      commit()
    }
    drag = { onMove, onUp, flush }
    dragging.value = true
    document.body.classList.add('is-dialog-resizing')
    try {
      ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    } catch {
      // jsdom and older hosts lack pointer capture; the window listeners still work.
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  /**
   * The keyboard's three axes' worth of control, which is what makes the handle a control rather
   * than a mouse-only affordance: arrows step one axis each, Home is the floor and End the window,
   * and every one of them goes through the same `apply` the drag uses.
   */
  function onHandleKeydown(event: KeyboardEvent): void {
    const room = bounds.value
    const step = event.shiftKey ? DIALOG_SIZE_STEP * 4 : DIALOG_SIZE_STEP
    const next: DialogSize = { ...rendered.value }
    switch (event.key) {
      case 'ArrowLeft':
        next.width -= step
        break
      case 'ArrowRight':
        next.width += step
        break
      case 'ArrowUp':
        next.height -= step
        break
      case 'ArrowDown':
        next.height += step
        break
      case 'Home':
        next.width = DIALOG_WIDTH_MIN
        next.height = DIALOG_HEIGHT_MIN
        break
      case 'End':
        next.width = room.width
        next.height = room.height
        break
      default:
        return
    }
    event.preventDefault()
    apply(next)
  }

  function onHandleDoubleClick(): void {
    apply({ width: DIALOG_WIDTH_DEFAULT, height: DIALOG_HEIGHT_DEFAULT })
  }

  onMounted(() => {
    measureViewport()
    window.addEventListener('resize', measureViewport)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('resize', measureViewport)
    stopDrag()
  })

  return {
    rendered,
    bounds,
    dragging,
    onHandlePointerDown,
    onHandleKeydown,
    onHandleDoubleClick,
  }
}
