<script setup lang="ts">
/**
 * The floating ball: the one thing on the desktop that stays where it was put.
 *
 * Ported from `references/desktop-pet/windows/src/floating-ball.{html,ts}` and the orb's rules in
 * `windows/src/styles.css` at commit `be171a01273a1ed92a27bcdf72f8a58768bac421`:
 *
 *   - the orb itself, 56 px inside an 80 px window with a 12 px margin (`styles.css:227-236`),
 *     drawn as upstream drew it — radial highlight, ring, inset bevel — with the press and drag
 *     states at `:291-298`
 *   - the three gestures: primary press and release (`floating-ball.ts:197-238`), which
 *     `../services/pet-ball-input` decides, and the context menu that opens settings (`:227-231`)
 *   - the hint upstream put in the orb's `title` (`:113`), which is also where a desktop that
 *     cannot move the ball says so — with upstream's 「Left-click: menu」 clause removed, because
 *     that click opens nothing here (see {@link hint})
 *
 * What the port changed:
 *
 *   - Upstream built the ball out of `document.getElementById` and five module-level variables
 *     (`floating-ball.ts:20-35`), because one webview held one ball. This is a component with its
 *     gesture in a closure, so two windows cannot share a press.
 *   - The window is `../../services/pet-ball-input`'s {@link PetBallPlatform} rather than an
 *     import of `@tauri-apps/api`: `startDragging` (`:219`) and `snap_floating_ball` (`:222`)
 *     arrive as one optional parameter, which is §3's adaptation and what lets a machine that
 *     cannot do either say so instead of looking broken.
 *   - The orb is a real `<button>` with a name. Upstream's `<div id="ball">` could only be
 *     clicked with a mouse; §7.2's Linux desktops include keyboard users, and a control that a
 *     keyboard cannot reach is one they do not have.
 *   - The character is D2's `PetSprite`, not an `<img>` of the app icon. Upstream's ball wore
 *     the application icon (`floating-ball.html:11-13`); here the ball occupies a character's slot
 *     on the desktop, so it wears that character when it has one and falls back to upstream's
 *     plain orb when it does not.
 *   - A character that cannot be drawn is *reported*, and the orb is what is left. Upstream had
 *     an `<img>` that simply broke; a `PetSprite` with neither `on-load-error` nor
 *     `on-unavailable` is worse than that — it states nothing and goes on running a frame timer
 *     for a canvas nothing will ever paint (`pet-failure-recovery.md` §7.3). Both are wired
 *     below, and the branch is refused while either is true, which unmounts the sprite and takes
 *     its timer with it.
 *
 * What it deliberately does not own: the menu. Upstream's ball carried the quick-bubble form and
 * its presets in the same file (`:10-12`, `:123-190`); that is the bubble feature's job here (§10's D9), so
 * this component reports the gesture and the composition decides what opens. It owns neither the
 * window's size nor its position — §7.1 gives the window identity to the host, and the ball only
 * asks the platform to drag and to snap.
 *
 * Its strings are literal English, like `DesktopPetRoot.vue`'s and for the same reason: the pet
 * window must not import the app's whole dictionary (§7.1). §10.1 gives the pet its own i18n
 * namespace to the integrator, and this component is one of the places it plugs in.
 */
import { computed, ref, watch } from 'vue'
import { usePetDrawingFailure } from '../composables/use-pet-drawing-failure'
import type { SpriteClock } from '../rendering/animation-bindings'
import type { ImageFactory } from '../rendering/sprite-sheet'
import {
  createBallGesture,
  type BallPointer,
  type PetBallPlatform,
} from '../services/pet-ball-input'
import PetSprite from './PetSprite.vue'

const props = withDefaults(
  defineProps<{
    /** The character whose face the ball wears; null draws upstream's plain orb. */
    imageUrl?: string | null
    /** The character's state, for the sprite's frame rows (D2's mapping). */
    state?: string
    /** The orb's diameter in CSS px. Upstream's `--ball-size` (`styles.css:235`). */
    size?: number
    /** §5.1's 显示. A hidden ball draws nothing, and the host gives its window up. */
    visible?: boolean
    /** Whether the ball's own menu is open; a press with it open puts it away. */
    menuOpen?: boolean
    /** The desktop's drag and snap; absent → the ball says it cannot be moved (§7.2). */
    platform?: PetBallPlatform | null
    /** §5.2's reduce-motion, as the app decided it. The system's own setting is honoured too. */
    reduceMotion?: boolean
    /** Injected for tests (§10.2): the clock the click window is measured against. */
    now?: (() => number) | null
    /** Injected for tests: passed to `PetSprite` unchanged. */
    clock?: SpriteClock
    /** Injected for tests: passed to `PetSprite` unchanged. */
    createImage?: ImageFactory
  }>(),
  {
    // Only the props whose absence has a meaning are defaulted, the way `DesktopPetRoot.vue`
    // does it: `null` for the character there is none of, and the three test seams left at
    // `undefined` because "not given" is what has to reach `PetSprite` and the gesture. `now`
    // in particular must stay a value rather than become a factory: it *is* a function, and a
    // clock this component invented would be one a test could not take away.
    imageUrl: null,
    state: 'idle',
    size: 56,
    visible: true,
    menuOpen: false,
    platform: null,
    reduceMotion: false,
    now: undefined,
    clock: undefined,
    createImage: undefined,
  },
)

const emit = defineEmits<{
  /** The ball was clicked: show the menu, or put it away. */
  'toggle-menu': []
  /** A press while the menu was open. Upstream `:189-190`: the press closes it and does not reopen it. */
  'dismiss-menu': []
  /** The ball was right-clicked. Where that lands is the host's (§7.1); this only reports it. */
  'open-settings': []
  /**
   * The ball cannot draw the character it was given, or can again. The sentence is
   * `usePetDrawingFailure`'s, so the host that shows it says what the pet window says.
   */
  'draw-failure': [notice: string | null]
}>()

/**
 * The two states `PetSprite` reports when it cannot draw, and when they stop being true.
 *
 * Declared here rather than left to the composition, because the props have to be *passed* for
 * the ball to hear them at all: a sprite with no `on-load-error` has no way to say a character
 * is broken, and one with no `on-unavailable` is the inert case — a player and a frame timer
 * built for a canvas that will never be painted, ticking at 3-8 Hz with nothing to do and
 * nothing to say (`pet-failure-recovery.md` §7.3). Wiring both is what makes the refusal below
 * reachable, and the refusal is what stops that timer.
 *
 * `drawing` is the ball's own lifetime: the branch further down mounts the sprite only while the
 * ball is visible and has a character, which is exactly the canvas the composable's second rule
 * is about. `imageUrl` is read through a computed rather than passed as the prop, because the
 * composable watches it and a prop read directly would be watched for its identity alone.
 */
const drawing = computed(() => props.visible && Boolean(props.imageUrl))
const {
  notice: drawingFailure,
  onLoadError: onSpriteLoadError,
  onUnavailable: onSpriteUnavailable,
} = usePetDrawingFailure({ imageUrl: computed(() => props.imageUrl ?? null), drawing })

/**
 * Say it out loud to whoever can place it. The orb is 56px and has room for no sentence at all,
 * so the same division the gestures above use applies here: this component reports, and the
 * composition decides where a sentence goes. `immediate` because the first state is worth
 * stating — a host that only heard about changes would have to guess at the one it mounted with.
 */
watch(drawingFailure, (notice) => emit('draw-failure', notice), { immediate: true })

/** Upstream's margin between the orb and its window (`styles.css:236`), so hover and shadow fit. */
const BALL_MARGIN = 12
/** Share of the orb the character is drawn at. Upstream's `#ball img` (`styles.css:300-308`). */
const FACE_RATIO = 0.58
/**
 * What a screen reader calls the ball. A name, not the hint: the hint is a `title`, which is
 * announced as the description, and a name that reads like three instructions is announced twice.
 */
const NAME = 'Desktop pet ball'

// `aria-haspopup="true"` stood beside the label until the left-click clause left the hint. It was
// the same claim — "activating this shows a menu" — made to assistive technology rather than to a
// hovering pointer, and it is false for the same reason: there is no menu yet. It comes back with
// the menu. `:aria-expanded="menuOpen"` stays, because it reads `false` and that is true.

const gesture = createBallGesture()
const pressed = ref(false)
const dragging = ref(false)

const frameSize = computed(() => props.size + BALL_MARGIN * 2)
const faceSize = computed(() => Math.round(props.size * FACE_RATIO))
/** Whether this desktop can move the ball at all: the one thing the hint has to be honest about. */
const movable = computed(() => typeof props.platform?.startDrag === 'function')

const hint = computed(() => {
  // Upstream's hint said 「Left-click: menu · Right-click: settings · Drag」 (`:113`). The
  // left-click clause is **gone, and it is the one clause that was a promise rather than a
  // description**: the menu needs a window resize this build cannot do and an action design it has
  // not made (`PetBallWindow.vue`'s header, `desktop-pet-port-ledger.md:114`), so a press on the orb
  // opens nothing. A tooltip that says it opens a menu is the app asserting something it does not
  // do — the detail a user notices *because* they believe it — and the clause comes back in the same
  // change that gives the click something to do. What is left is what happens: right-click really
  // does open the pet's page, and the movement clause below says which of the two this desktop got.
  const base = 'Right-click: settings'
  const movement = movable.value ? 'Drag to move' : 'This desktop cannot move it'
  // A failure is appended and never replaces the rest: the two clauses above stay true whatever
  // the character did. It is here as well as in the emit because the orb is the whole window and
  // a user has no other way to learn that the ball is plain because the character broke — and
  // because the sentence is `usePetDrawingFailure`'s, so this is the same words the pet window
  // shows rather than a second description of one failure.
  return drawingFailure.value ? `${base} · ${movement} · ${drawingFailure.value}` : `${base} · ${movement}`
})

function clockOf(): number {
  return props.now ? props.now() : performance.now()
}

/** The cursor reading a gesture is measured from: screen coordinates, and the host's clock. */
function pointerOf(event: PointerEvent): BallPointer {
  return { screenX: event.screenX, screenY: event.screenY, at: clockOf() }
}

/**
 * Hand the pointer to this element for the rest of the press, so the move and the release arrive
 * even when the cursor leaves the 56 px orb. Upstream listened on `window` instead (`:208`, `:226`)
 * and had to remove those listeners again; a capture is released by the browser and cannot be
 * leaked. A desktop that refuses the capture costs the gesture its moves, not its correctness.
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

function onPointerDown(event: PointerEvent): void {
  // Only the primary button. Upstream returned for any other (`:198`), which is what keeps the
  // right-click's own gesture from also arming a click.
  if (event.button !== 0) return
  if (props.menuOpen) {
    emit('dismiss-menu')
    return
  }
  capture(event, true)
  if (gesture.down(pointerOf(event)) === 'pressed') pressed.value = true
}

function onPointerMove(event: PointerEvent): void {
  if (gesture.move(pointerOf(event)) === 'drag-start') startDrag()
}

function onPointerUp(event: PointerEvent): void {
  capture(event, false)
  pressed.value = false
  if (gesture.up(pointerOf(event)) === 'click') emit('toggle-menu')
}

/** The compositor owns the pointer from here, which arrives as a cancel rather than a release. */
function onPointerCancel(): void {
  pressed.value = false
  gesture.cancel()
}

function startDrag(): void {
  const beginDrag = props.platform?.startDrag
  // Nothing to move: the hint already says so, and the click was refused by the gesture, so a
  // press that wandered is neither a drag nor a menu.
  if (!beginDrag) return
  dragging.value = true
  pressed.value = false
  void endDrag(beginDrag.call(props.platform))
}

async function endDrag(started: Promise<void>): Promise<void> {
  try {
    // Resolves when the operating-system drag is over, which is what upstream's `finally`
    // waited for (`:219-223`).
    await started
  } catch {
    // A drag the compositor refused leaves the ball where it was. There is nothing to undo, and
    // §7.2's position reset belongs to the host that owns the position.
  }
  dragging.value = false
  gesture.cancel()
  try {
    await props.platform?.snap?.()
  } catch {
    // A host that cannot snap keeps the ball where the user put it, which is a position they chose.
  }
}
</script>

<template>
  <div
    v-if="visible"
    class="pet-ball"
    :style="{ width: `${frameSize}px`, height: `${frameSize}px` }"
  >
    <button
      type="button"
      class="pet-ball__orb"
      :class="{ 'is-pressed': pressed, 'is-dragging': dragging, 'is-still': reduceMotion }"
      :title="hint"
      :aria-label="NAME"
      :aria-expanded="menuOpen"
      :style="{ width: `${size}px`, height: `${size}px` }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @contextmenu.prevent="emit('open-settings')"
      @keydown.enter.prevent="emit('toggle-menu')"
      @keydown.space.prevent="emit('toggle-menu')"
    >
      <PetSprite
        v-if="imageUrl && !drawingFailure"
        class="pet-ball__face"
        :image-url="imageUrl"
        :state="state"
        :width="faceSize"
        :height="faceSize"
        :clock="clock"
        :create-image="createImage"
        :on-load-error="onSpriteLoadError"
        :on-unavailable="onSpriteUnavailable"
      />
      <span
        v-else
        class="pet-ball__highlight"
        aria-hidden="true"
      />
    </button>
  </div>
</template>

<style scoped>
.pet-ball {
  display: flex;
  align-items: center;
  justify-content: center;
  /* Nothing outside the orb may catch a click: §7.2's pass-through starts with a window that
     does not claim input it is not using, and the margin exists for the shadow, not for it. */
  background: transparent;
  border: 0;
  padding: 0;
}

.pet-ball__orb {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  aspect-ratio: 1 / 1;
  border-radius: 50%;
  border: 1.5px solid var(--pet-ball-ring, rgb(255 255 255 / 32%));
  cursor: grab;
  user-select: none;
  /* Pointer events, not mouse events: the press must keep being measured while the cursor is
     over the desktop, and the browser must not claim the gesture for scrolling first. */
  touch-action: none;

  /* Upstream's orb (`styles.css:253-274`): a highlight, a shade, and the ring above it. The
     colours ride on custom properties so a host theme can restate them without a second orb. */
  background:
    radial-gradient(circle at 38% 28%, var(--pet-ball-top, rgb(255 255 255 / 18%)) 0%, transparent 42%),
    radial-gradient(circle at 50% 100%, var(--pet-ball-shade, rgb(0 0 0 / 35%)) 0%, transparent 55%),
    linear-gradient(
      165deg,
      var(--pet-ball-mid, rgb(40 36 72 / 78%)) 0%,
      var(--pet-ball-bottom, rgb(16 14 30 / 92%)) 100%
    );
  box-shadow:
    0 3px 9px rgb(0 0 0 / 45%),
    0 1px 4px rgb(0 0 0 / 35%),
    inset 0 1.5px 1.5px rgb(255 255 255 / 18%),
    inset 0 -2px 4px rgb(0 0 0 / 35%);

  /* §7.3: the states move `transform` and nothing else, so the compositor carries them. */
  transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}

.pet-ball__orb:hover {
  transform: scale(1.05);
}

.pet-ball__orb.is-pressed {
  transform: scale(0.96);
}

.pet-ball__orb.is-dragging {
  cursor: grabbing;
  transform: scale(1.01);
  filter: brightness(1.06);
  transition: transform 80ms ease;
}

.pet-ball__orb:focus-visible {
  /* The ring is the orb's own border, so the focus indicator has to sit outside it to be seen. */
  outline: 2px solid var(--pet-ball-focus, rgb(124 92 255 / 85%));
  outline-offset: 3px;
}

/* §5.2's reduce-motion, and the system's own: the states stay — they say what the button is
   doing — and the travel between them goes away. The ball may be more conservative than the
   system, never less. */
.pet-ball__orb.is-still,
.pet-ball__orb.is-still:hover,
.pet-ball__orb.is-still.is-pressed,
.pet-ball__orb.is-still.is-dragging {
  transform: none;
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .pet-ball__orb,
  .pet-ball__orb:hover,
  .pet-ball__orb.is-pressed,
  .pet-ball__orb.is-dragging {
    transform: none;
    transition: none;
  }
}

/* The character, drawn by D2's sprite. It never takes a pointer event of its own: the orb is
   the button, and a canvas that could be pressed would be a second, differently-sized target. */
.pet-ball__face {
  pointer-events: none;
}

/* No character chosen: upstream's orb, which is a plain sphere with a highlight. */
.pet-ball__highlight {
  width: 58%;
  height: 58%;
  border-radius: 50%;
  background: radial-gradient(circle at 38% 28%, rgb(255 255 255 / 22%) 0%, transparent 60%);
  pointer-events: none;
}
</style>
