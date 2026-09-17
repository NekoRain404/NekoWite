/**
 * The character's drag: the ball's rule, on the surface the user actually grabs.
 *
 * A composable rather than a block in `DesktopPetRoot.vue`, and the boundary is the one that file's
 * own header already drew: what the window *draws* and what a pointer can *do to it* are two
 * subjects, and this is the second one whole — the gesture, the two states it reports, the
 * capability it needs, and the pointer capture it takes. The root keeps the template and the
 * wiring; this owns the machinery.
 *
 * **Upstream drags its pet window, and this port did not.** `references/desktop-pet/windows/src/
 * main.ts:555-613` binds the gesture to the sprite canvas and to the bubble, and its comment says
 * why the drag is measured by hand rather than handed to `data-tauri-drag-region`. Two lines of it
 * are the whole of what this ports:
 *
 *   - `:588-590` a press that does not land on the sprite does not start a drag —
 *     `pet.spriteRect && !pet.hitTest(...)` returns early, 「so clicks on the empty area around the
 *     pet don't drag the window」. {@link PetDrag.onPointerDown} is that line, and `PetSprite`'s
 *     `hitTest` and `geometry` — exposed by D2 for a shell that did not exist until now — are
 *     finally its callers.
 *   - `:594` a press that moves more than 4 px is a drag, and `:600-603` a press released without
 *     moving is a click. That arithmetic is `pet-ball-input.ts`'s, where upstream's
 *     `floating-ball.ts` was ported from, so this calls {@link createBallGesture} rather than
 *     restating it: the two surfaces are asked to behave alike, and a second threshold written
 *     here is the defect the sharing prevents.
 *
 * Three things it decides that the orb's own drag does not have to:
 *
 *   - **The drag handle is the character, and only the character.** A press on the transparent
 *     part of the canvas's box reaches the window and starts nothing. The *window* still takes the
 *     press — see `DesktopPetRoot.vue`'s `needsInput` on what that costs — but the drag never
 *     begins from it.
 *   - **A sprite that has not drawn a frame yet is still grabbable.** Upstream allowed the press
 *     through while the sheet was loading, 「so the pet is never untouchable」 (`:588-589`), and
 *     that case is reachable here for the same reason: `hitTest` answers false when there is no
 *     sprite rect to test against. So the *rect* is what refuses a press, never the miss — a
 *     drawn sprite that was missed is refused, a sprite that has not drawn yet is not.
 *   - **The click lands nowhere, and that is now a decision rather than a schema default.**
 *     Upstream's `onPetClick` (`:570-580`) reads `ap_left_click_action` and does one of three
 *     things with a press that did not wander; `none` — its default, and the one a fresh install
 *     carries — does nothing. **This build has no such key**: `message.leftClick` was removed from
 *     the schema, because the three actions it names have no caller here (the first needs a quick
 *     bubble the window shows as its idle line instead, and the other two need more than one
 *     character). So a press reaches `onClick` below and stops, which is upstream's own default
 *     behaviour and no longer something a stored value could ask to change. What is left is the
 *     gesture's other half read as the refusal it is — a press that
 *     does not wander is *not* a drag, which is the whole reason the arithmetic exists. It is not
 *     an emit either: this composable's only consumer is the root, and an event nobody hears is a
 *     promise of a bubble that this build has not designed (`desktop-pet-port-ledger.md:114`).
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { Rect } from '../rendering/sprite-slicer'
import {
  createBallGesture,
  type BallPointer,
  type PetBallPlatform,
} from '../services/pet-ball-input'

/**
 * The part of `PetSprite` this needs: where it drew, and whether a point hit it.
 *
 * A structural type rather than `InstanceType<typeof PetSprite>` — the two methods are the whole
 * of the dependency, and a composable that named the component would be a second import of it that
 * has to be kept in step with the template's `ref`. `DesktopPetRoot.vue` passes the instance it
 * already holds.
 */
export interface PetDragSurface {
  /** Where the sprite actually drew inside its canvas, or null before the first frame. */
  geometry(): { spriteRect: Rect | null }
  hitTest(x: number, y: number): boolean
}

export interface PetDragOptions {
  /**
   * The desktop's drag, when this build has one. Read through a getter because it is a prop and a
   * prop can change: a window handed a platform later has to become grabbable.
   */
  platform: () => PetBallPlatform | null | undefined
  /** Whether the window is drawing at all — the sprite branch's own condition. */
  drawing: () => boolean
  /** What it is drawing, which is null in every state that has no character. */
  sheet: () => string | null
  /** A failure the window has to state about the sheet, which refuses the handle with it. */
  failed: () => boolean
  /** The sprite's instance, for the two things only it can answer. */
  surface: () => PetDragSurface | null
  /**
   * Injected for tests (§10.2): the clock a press is measured against.
   *
   * *Not* the clock `usePetWindow` reads — that one is the host's epoch milliseconds, and this is a
   * monotonic reading whose differences decide whether a press was short enough to be a click.
   */
  now?: (() => number) | null
}

export interface PetDrag {
  /** A press is armed: the sprite is being held, and it may yet become a drag. */
  readonly pressed: Ref<boolean>
  /** The compositor is moving the window. */
  readonly dragging: Ref<boolean>
  /**
   * Whether this desktop can move the character at all: the one thing the sprite's tooltip is
   * about.
   */
  readonly movable: ComputedRef<boolean>
  /**
   * Whether what is on screen is something the pointer can act on by dragging it.
   *
   * The sprite branch's own three terms plus the capability — exactly the condition the template
   * uses for the canvas — so the window can never take the pointer for a character it is not
   * drawing, and never stays click-through while drawing one it could move. This is also what
   * `DesktopPetRoot`'s `needsInput` reads, which is why it is exposed rather than kept inside.
   */
  readonly handle: ComputedRef<boolean>
  /**
   * What the sprite's tooltip says, in the orb's own words — one sentence for one state, so the two
   * surfaces cannot describe the same machine differently (§5.2's 「不能用的控件要说出来」).
   *
   * A `title` on a canvas that is `aria-hidden` is a pointer's affordance rather than an
   * announcement, and that is the honest reach here: a window drag is a compositor gesture with no
   * keyboard equivalent, so this surface has no key to answer and no role worth claiming.
   */
  readonly hint: ComputedRef<string>
  onPointerDown(event: PointerEvent): void
  onPointerMove(event: PointerEvent): void
  onPointerUp(event: PointerEvent): void
  onPointerCancel(): void
}

export function usePetDrag(options: PetDragOptions): PetDrag {
  const gesture = createBallGesture()
  const pressed = ref(false)
  const dragging = ref(false)

  const movable = computed(() => typeof options.platform()?.startDrag === 'function')

  const handle = computed(
    () =>
      movable.value &&
      options.drawing() &&
      Boolean(options.sheet()) &&
      !options.failed(),
  )

  const hint = computed(() => (movable.value ? 'Drag to move' : 'This desktop cannot move it'))

  /** The cursor reading a gesture is measured from: screen coordinates, and the caller's clock. */
  function pointerOf(event: PointerEvent): BallPointer {
    return {
      screenX: event.screenX,
      screenY: event.screenY,
      at: options.now ? options.now() : performance.now(),
    }
  }

  /**
   * Hand the pointer to the sprite for the rest of the press, so the move and the release arrive
   * even when the cursor leaves the character. The orb's own call, for its reason: a capture is
   * released by the browser and cannot be leaked.
   */
  function capture(event: PointerEvent, on: boolean): void {
    const element = event.currentTarget as HTMLElement | null
    if (!element || typeof event.pointerId !== 'number') return
    try {
      if (on) element.setPointerCapture(event.pointerId)
      else element.releasePointerCapture(event.pointerId)
    } catch {
      // No active pointer to capture (a synthesized event, or one the compositor already took).
    }
  }

  /**
   * Where the press landed, in the canvas's own coordinates.
   *
   * Read from the element's box rather than from `event.offsetX`, which upstream used (`:589`):
   * `offsetX` is relative to whichever node the browser dispatched to, and a hit test whose
   * coordinate space depends on that is one a test cannot drive.
   */
  function spritePoint(event: PointerEvent): { x: number; y: number } {
    const box = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) }
  }

  function onPointerDown(event: PointerEvent): void {
    // Only the primary button, as the orb does and as upstream did (`:583`): a right-click belongs
    // to whatever the window opens for it, and arming a press here would let it become a drag.
    if (event.button !== 0) return
    if (!handle.value) return
    const surface = options.surface()
    const rect = surface?.geometry().spriteRect ?? null
    const point = spritePoint(event)
    if (rect && !surface?.hitTest(point.x, point.y)) return
    capture(event, true)
    if (gesture.down(pointerOf(event)) === 'pressed') pressed.value = true
  }

  function onPointerMove(event: PointerEvent): void {
    if (gesture.move(pointerOf(event)) === 'drag-start') startDrag()
  }

  function onPointerUp(event: PointerEvent): void {
    capture(event, false)
    pressed.value = false
    // The outcome is not read: `up` is called for what it forgets — a press must not outlive its
    // release — and a click has nowhere to go here (see this file's header).
    gesture.up(pointerOf(event))
  }

  /** The compositor owns the pointer from here, which arrives as a cancel rather than a release. */
  function onPointerCancel(): void {
    pressed.value = false
    gesture.cancel()
  }

  function startDrag(): void {
    const platform = options.platform()
    const beginDrag = platform?.startDrag
    // Nothing to move: the tooltip already says so, and `handle` refused the press.
    if (!beginDrag) return
    dragging.value = true
    pressed.value = false
    void endDrag(beginDrag.call(platform))
  }

  async function endDrag(started: Promise<void>): Promise<void> {
    try {
      // Resolves when the operating-system drag is over — upstream's `finally` (`main.ts:597`) and
      // the orb's own `endDrag`, which waits for the same thing.
      await started
    } catch {
      // A drag the compositor refused leaves the character where it was. There is nothing to undo.
    }
    dragging.value = false
    gesture.cancel()
    try {
      await options.platform()?.snap?.()
    } catch {
      // A host that cannot snap keeps the character where the user put it, which is a place they
      // chose.
    }
  }

  return {
    pressed,
    dragging,
    movable,
    handle,
    hint,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  }
}
