<script setup lang="ts">
/**
 * The pet window's root: the whole of what that window mounts.
 *
 * §7.1's requirement here is an absence — 「入口只初始化桌宠，不挂载 AppShell、编辑器、整套索引和
 * Agent 客户端」 — so this component is deliberately the end of the graph rather than a thin wrapper
 * over something larger: a sprite, a line of text about the state of the host connection, and the
 * lifecycle that owns both. What it does *not* import is the part worth asserting, and
 * `src/app/desktop-pet-entry.test.ts` walks the entry's import graph to do it.
 *
 * Most of what it can be asked to render is nothing, and each of those states is *stated* rather
 * than drawn around, because §7.2's rule about a capability that is not there applies to the host
 * connection too: no gateway, a host that refused, a feature switched off, no character chosen and
 * a sheet that will not load each get a sentence. The alternative — an idle pet that knows nothing
 * — looks identical to a working one, and is wrong in the way that is hardest to notice.
 *
 * **The character can be dragged, which is upstream's behaviour and was missing here.** Upstream
 * moves its pet window from the sprite (`references/desktop-pet/windows/src/main.ts:555-613`), and
 * this port had the permission, the gesture and the adapter for it and used all three on the orb
 * alone — so the ball could be moved and the pet could not. The block below
 * ({@link onPetPointerDown} onward) is the port of upstream's rule, and the two consequences worth
 * knowing before reading it are that the drag handle is the sprite rather than the window, and
 * that a window with a drag handle has to take the pointer for it.
 *
 * Its few strings are literal English for now. The app's `i18n` cannot be imported here: it is
 * the whole dictionary, and §7.1's list of what this window must not carry is exactly that. §10.1
 * gives the pet's own namespace (`S/i18n/namespaces/desktop-pet.ts`, `i18n/index.ts`) to the
 * integrator, and this component is where it plugs in.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type {
  PetGateway,
  PetTaskProjection,
  PetWindowGateway,
} from '../../../platform/gateways/pet-contracts'
import type { AnimationConfig, SpriteClock } from '../rendering/animation-bindings'
import type { ImageFactory } from '../rendering/sprite-sheet'
import type { SheetPixelReader } from '../rendering/sprite-slicer'
import { usePetClickThrough } from '../composables/use-pet-click-through'
import { usePetDrawingFailure } from '../composables/use-pet-drawing-failure'
import { usePetLifecycle } from '../composables/use-pet-lifecycle'
import { usePetWindow } from '../composables/use-pet-window'
import type { PetAppearanceView } from '../services/pet-appearance'
// The ball's gesture, reused rather than restated. `pet-ball-input.ts` is where upstream's
// click-versus-drag arithmetic was ported from `floating-ball.ts`, and the character window's
// drag needs exactly that arithmetic — the same 4 px threshold, the same 280 ms click window, the
// same screen-coordinate reading (see that file's header) — so this is the *one* implementation
// both of the pet's surfaces call, and the character asks for it by the name the port gave it.
import {
  createBallGesture,
  type BallPointer,
  type PetBallPlatform,
} from '../services/pet-ball-input'
import { actOnPetMenu } from '../services/pet-menu-actions'
import type { PetMenuAction } from '../services/pet-context-menu'
import PetBubble from './PetBubble.vue'
import PetContextMenu from './PetContextMenu.vue'
import PetSprite from './PetSprite.vue'

const props = withDefaults(
  defineProps<{
    /**
     * The host connection. Absent means unwired rather than broken, and the window says which:
     * the composition that supplies it is `desktop-pet-composition.ts` (§9, the integrator's).
     */
    gateway?: PetGateway | null
    /**
     * The wider host surface this window's own wiring needs: what it draws (read, and re-read
     * when another window changes the character) and where a click on a task goes.
     *
     * A second prop rather than a wider `gateway`, because each consumer is handed the narrowest
     * contract it uses — and because the entry passes the *same* object to both. Absent means the
     * window draws the `imageUrl` prop and routes nothing, which is what the tests that mount a
     * bare gateway exercise.
     */
    connection?: PetWindowGateway | null
    /** The current character's spritesheet; null draws nothing (§7.2's character settings). */
    imageUrl?: string | null
    /** The mood row the sprite follows (D4's projection); idle until there is one. */
    mood?: string
    /** Sprite box in CSS pixels, from the character's size setting. */
    width?: number
    height?: number
    /** Animation mapping from settings; fields left out keep upstream's defaults. */
    animation?: Partial<AnimationConfig>
    /**
     * The desktop's drag, when this build has one — the same object `PetBallWindow.vue` hands the
     * orb, because it is the same ask of the same compositor.
     *
     * Absent → this window cannot move the character, and it says so rather than offering a drag
     * that does nothing (§7.2's 「不伪装已支持」): the sprite is not a drag handle, so the window
     * does not take the pointer for one (see {@link dragHandle}), and the sprite's own tooltip is
     * the one sentence this surface has room for.
     */
    platform?: PetBallPlatform | null
    /**
     * Injected for tests (§10.2): the clock a press is measured against.
     *
     * The same seam `PetFloatingBall.vue` takes under the same name, and *not* the clock the
     * bubble reads — `usePetWindow`'s `now` is the host's epoch milliseconds, and this is a
     * monotonic reading whose differences decide whether a press was short enough to be a click.
     */
    now?: (() => number) | null
    /** Injected for tests (§10.2): the sprite's frame clock and image factory. */
    clock?: SpriteClock
    createImage?: ImageFactory
    readPixels?: SheetPixelReader
  }>(),
  // `null` for the two props whose absence is a state — no gateway, no character — and upstream's
  // sprite box for the size. Everything else defaults to `undefined`, which is what "not given"
  // has to keep meaning: the sprite has its own fallback for an absent animation mapping, and a
  // value invented here would silently replace it.
  {
    gateway: null,
    connection: null,
    imageUrl: null,
    mood: 'idle',
    width: 160,
    height: 180,
    animation: undefined,
    platform: null,
    now: undefined,
    clock: undefined,
    createImage: undefined,
    readPixels: undefined,
  },
)

/**
 * One lifecycle for the window, not one per render.
 *
 * The gateway is read once because a pet window's host connection does not change while it exists:
 * a different connection would be a different window, and §7.1 makes creating one the host's job.
 */
const lifecycle = props.gateway ? usePetLifecycle({ gateway: props.gateway }) : null

/**
 * The window's own wiring, when the host gave it a surface to read.
 *
 * Declared *after* the lifecycle because it registers its timer as a drawing hold — §7.1's
 * 「隐藏时停止动画绘制」 — so hiding the pet stops the mood's clock with everything else the
 * window was doing.
 */
const window_ = props.connection
  ? usePetWindow({
      connection: props.connection,
      tasks: () => lifecycle?.state.value.tasks ?? [],
      ...(lifecycle ? { hold: lifecycle.hold } : {}),
    })
  : null

const drawing = computed(() => lifecycle?.state.value.drawing ?? false)
/** The task list, folded out on request (the menu's "Show tasks"). */
const listOpen = ref(false)
/** Where the right-click was, in window coordinates, and whether the menu is up. */
const menuAt = ref<{ x: number; y: number } | null>(null)

/** The bubble, for the one thing only it can answer: whether it is showing anything (§7.2). */
const bubble = ref<InstanceType<typeof PetBubble> | null>(null)

/**
 * What to draw: the host's read when there is one, the caller's props otherwise.
 *
 * `appearance.motion` (§5.2's 动效) is deliberately not read here. This window's surface has no
 * CSS animation or transition to turn off — the sprite is a canvas whose frames *are* the pet, and
 * the one animation upstream's reduce-motion removes from this window (`#pet.bob`,
 * `references/desktop-pet/windows/src/styles.css:1280-1287`) has no counterpart in this port. The
 * orb is the surface that moves, so `PetBallWindow.vue` is where the policy is applied; a
 * `reduce-motion` rule added here without a surface to apply it to would be a class nothing could
 * see. **The drag did not change that**: its two states are a shade and a cursor rather than a
 * travel, and neither declares a `transition`, so they hold under the reduced policy and this
 * window still has nothing for the setting to remove.
 *
 * `appearance.bubbleOpacity` *is* read here, and it is the same test in the other direction: the
 * bubble is in this window, so §5.2's 气泡与消息 opacity has something to change on this surface —
 * and without this line the control on that page would write a value nothing draws.
 */
const appearance = computed<PetAppearanceView | null>(() => window_?.appearance.value ?? null)
const imageUrl = computed(() => appearance.value?.imageUrl ?? props.imageUrl)
const spriteWidth = computed(() => appearance.value?.width ?? props.width)
const spriteHeight = computed(() => appearance.value?.height ?? props.height)
const animation = computed(() => appearance.value?.animation ?? props.animation)
const mood = computed(() => window_?.mood.value ?? props.mood)
const tasks = computed<readonly PetTaskProjection[]>(() => lifecycle?.state.value.tasks ?? [])

/**
 * The two states `PetSprite` reports when it cannot draw, and when they stop being true. Declared
 * after `imageUrl` and `drawing` because those are what its invalidation is *about*: a failure
 * belongs to one attempt, and it is cleared when that attempt's subject is replaced.
 *
 * Taken apart rather than kept as one object: the notice is a ref, and a ref nested in a plain
 * object is not unwrapped in a template — `!drawingFailure.notice` is the truthiness of a ref.
 */
const {
  notice: drawingFailure,
  onLoadError: onSheetFailure,
  onUnavailable: onSpriteUnavailable,
} = usePetDrawingFailure({ imageUrl, drawing })

/**
 * The character's drag: the ball's rule, on the surface the user actually grabs.
 *
 * **Upstream drags its pet window, and this port did not.** `references/desktop-pet/windows/src/
 * main.ts:555-613` binds the gesture to the sprite canvas and to the bubble, and its comment says
 * why the drag is measured by hand rather than handed to `data-tauri-drag-region`. Two lines of it
 * are the whole of what this block ports:
 *
 *   - `:588-590` a press that does not land on the sprite does not start a drag —
 *     `pet.spriteRect && !pet.hitTest(...)` returns early, 「so clicks on the empty area around the
 *     pet don't drag the window」. {@link onPetPointerDown} is that line, and `PetSprite`'s
 *     `hitTest` and `geometry` — exposed by D2 for a shell that did not exist until now — are
 *     finally its callers.
 *   - `:594` a press that moves more than 4 px is a drag, and `:600-603` a press released without
 *     moving is a click. That arithmetic is `pet-ball-input.ts`'s, where upstream's
 *     `floating-ball.ts` was ported from, so this component calls {@link createBallGesture} rather
 *     than restating it: the two surfaces are asked to behave alike, and a second threshold
 *     written here is the defect the sharing prevents.
 *
 * Three things this block decides that the orb's does not have to:
 *
 *   - **The drag handle is the character, and only the character.** A press on the transparent
 *     part of the canvas's box reaches this window and starts nothing. The *window* still takes
 *     the press — see {@link needsInput} on what that costs — but the drag never begins from it.
 *   - **A sprite that has not drawn a frame yet is still grabbable.** Upstream allowed the press
 *     through while the sheet was loading, 「so the pet is never untouchable」 (`:588-589`), and
 *     that case is reachable here for the same reason: `hitTest` answers false when there is no
 *     sprite rect to test against. So the *rect* is what refuses a press, never the miss — a
 *     drawn sprite that was missed is refused, a sprite that has not drawn yet is not.
 *   - **The click lands nowhere — and that is upstream's own default, not a gap left here.**
 *     Upstream's `onPetClick` (`:570-580`) reads `ap_left_click_action` and returns immediately
 *     when it is `none`, which is what that key reads as when it has never been written. So a
 *     fresh upstream install and this build do the same thing with a press that did not wander:
 *     nothing. What is left is the gesture's other half read as the refusal it is — a press that
 *     does not wander is *not* a drag, which is the whole reason the arithmetic exists. It is not
 *     an emit either: this component's only consumer is the entry that mounts it, and an event
 *     nobody hears is a promise of a bubble that this build has not designed
 *     (`desktop-pet-port-ledger.md:114`).
 */
const gesture = createBallGesture()
const pressed = ref(false)
const dragging = ref(false)
/** The sprite, for the two things only it can answer: where it drew, and whether a point hit it. */
const sprite = ref<InstanceType<typeof PetSprite> | null>(null)

/** Whether this desktop can move the character at all: the one thing the sprite's tooltip is about. */
const movable = computed(() => typeof props.platform?.startDrag === 'function')

/**
 * Whether what is on screen is something the pointer can act on by dragging it.
 *
 * The sprite branch's own three terms plus the capability — exactly the condition the template
 * uses for the canvas — so the window can never take the pointer for a character it is not
 * drawing, and never stays click-through while drawing one it could move.
 */
const dragHandle = computed(
  () => movable.value && drawing.value && Boolean(imageUrl.value) && !drawingFailure.value,
)

/**
 * What the sprite's tooltip says, in the orb's own words — one sentence for one state, so the two
 * surfaces cannot describe the same machine differently (§5.2's 「不能用的控件要说出来」).
 *
 * A `title` on a canvas that is `aria-hidden` is a pointer's affordance rather than an
 * announcement, and that is the honest reach here: a window drag is a compositor gesture with no
 * keyboard equivalent, so this surface has no key to answer and no role worth claiming.
 */
const spriteHint = computed(() =>
  movable.value ? 'Drag to move' : 'This desktop cannot move it',
)

/** The cursor reading a gesture is measured from: screen coordinates, and the caller's clock. */
function pointerOf(event: PointerEvent): BallPointer {
  return {
    screenX: event.screenX,
    screenY: event.screenY,
    at: props.now ? props.now() : performance.now(),
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

function onPetPointerDown(event: PointerEvent): void {
  // Only the primary button, as the orb does and as upstream did (`:583`): a right-click belongs
  // to whatever the window opens for it, and arming a press here would let it become a drag.
  if (event.button !== 0) return
  if (!dragHandle.value) return
  const surface = sprite.value
  const rect = surface?.geometry().spriteRect ?? null
  const point = spritePoint(event)
  if (rect && !surface?.hitTest(point.x, point.y)) return
  capture(event, true)
  if (gesture.down(pointerOf(event)) === 'pressed') pressed.value = true
}

function onPetPointerMove(event: PointerEvent): void {
  if (gesture.move(pointerOf(event)) === 'drag-start') startDrag()
}

function onPetPointerUp(event: PointerEvent): void {
  capture(event, false)
  pressed.value = false
  // The outcome is not read: `up` is called for what it forgets — a press must not outlive its
  // release — and a click has nowhere to go here (see this block's header).
  gesture.up(pointerOf(event))
}

/** The compositor owns the pointer from here, which arrives as a cancel rather than a release. */
function onPetPointerCancel(): void {
  pressed.value = false
  gesture.cancel()
}

function startDrag(): void {
  const beginDrag = props.platform?.startDrag
  // Nothing to move: the tooltip already says so, and `dragHandle` refused the press.
  if (!beginDrag) return
  dragging.value = true
  pressed.value = false
  void endDrag(beginDrag.call(props.platform))
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
    await props.platform?.snap?.()
  } catch {
    // A host that cannot snap keeps the character where the user put it, which is a place they chose.
  }
}

/**
 * What this window has for the pointer to act on, which is what decides whether it takes the
 * pointer at all — the whole of `usePetClickThrough`'s rule.
 *
 * Three things, and they are the whole list: the bubble, whose rows open a task and whose
 * right-click opens the menu; the menu itself; and the character, now that it is a drag handle.
 *
 * **The third entry is the trade-off this rule used to defer, and it is paid rather than avoided.**
 * `usePetClickThrough`'s header states why the compositor's switch is per window and not per
 * pixel, so "the character can be grabbed" and "the empty part of the 260x320 box passes clicks
 * through" cannot both hold: a click-through window is sent no pointer events at all, which is
 * what makes the choice one-way. The character is what is chosen — and only where it can actually
 * be grabbed, because {@link dragHandle} is false without the capability, so a desktop whose
 * compositor cannot do it keeps the pass-through it had.
 *
 * Declared after the drawing states rather than beside the bubble, and that is a runtime
 * constraint rather than a preference: a watcher evaluates its getter as it is set up
 * (`usePetClickThrough` watches this one), so a `needsInput` naming a binding declared below it
 * would throw on mount rather than on the first change.
 */
const needsInput = computed(
  () => Boolean(bubble.value?.visible) || menuAt.value !== null || dragHandle.value,
)

/**
 * The window's own input region (§7.2's 鼠标穿透), asked for the first time below and re-asked
 * whenever `needsInput` moves.
 *
 * Absent when the window has no host connection, which is a state this component already renders:
 * a window with no host is a window that never has anything to click, and the compositor's default
 * — take the clicks — is what it keeps.
 */
const clickThrough = props.connection
  ? usePetClickThrough({
      setClickThrough: (ignore) => props.connection!.setClickThrough(ignore),
      needsInput: () => needsInput.value,
    })
  : null

const notice = computed<string | null>(() => {
  const state = lifecycle?.state.value
  if (!state) return 'This window has no host connection.'
  if (state.error) return state.error
  if (state.connecting) return null
  if (!state.enabled) return 'The pet is switched off.'
  if (drawingFailure.value) return drawingFailure.value
  // The host could not answer at all, which is not the same state as a host that answered
  // "nothing is chosen": the two look identical on screen unless they are kept apart here.
  if (window_?.appearanceError.value) return window_?.appearanceError.value ?? null
  if (appearance.value?.notice) return appearance.value.notice
  if (!imageUrl.value) return 'No character is selected.'
  return null
})

/**
 * A row was clicked: back to the session it belongs to, through the host (§6.2's 点击返回任务).
 *
 * The row's own key travels and nothing else — this window cannot name a window, a URL or a
 * command, so there is nothing here it could get wrong. A refusal is *not* turned into a state:
 * the click's outcome belongs to the window it asked, and this one has nothing to draw for it.
 */
function selectTask(task: PetTaskProjection): void {
  void window_?.select(task)
}

function openMenu(position: { x: number; y: number }): void {
  menuAt.value = position
}

/** What the three menu items do (§4's actions and no more). */
async function onMenuSelect(action: PetMenuAction): Promise<void> {
  if (!props.connection) return
  const outcome = await actOnPetMenu(props.connection, action)
  // `window` means the action was this window's own surface, which here is the task list.
  if (outcome === 'window') listOpen.value = true
  menuAt.value = null
}

onMounted(() => {
  void lifecycle?.start()
  // Read unconditionally, and *not* gated on `state.enabled`: that value starts false and is
  // filled in by `start()`, so a guard here would skip the read in exactly the case the window
  // exists for — a pet that is switched on. A disabled window pays one call and draws the "off"
  // sentence anyway, which is the cheaper mistake of the two.
  void window_?.start()
  // The first ask, and the one this window exists in the plan for: a pet that is showing a
  // character and nothing else has nothing for the pointer to act on, so it stops being a
  // 260x320 hole in the desktop from the moment it appears. Every later ask comes from the
  // watcher on `needsInput` (§7.2's 菜单打开/关闭 included: an open menu is input the window needs).
  void clickThrough?.sync()
})
// Not `await`ed: Vue's unmount is synchronous, and the one thing that is a promise — the host's
// unsubscribe — is issued before this returns. `usePetLifecycle` also registers its own scope
// disposal, so a future edit that drops this call still cannot leak.
onBeforeUnmount(() => void lifecycle?.dispose())

defineExpose({ lifecycle })
</script>

<template>
  <div class="pet-root">
    <!-- The bubble is the reminder's surface: the tasks when there are any, a line when there are
         not, and the right-click that opens the menu. It renders nothing at all when the pet is
         off or has no host, so a window that cannot hear about work does not look like one that
         has none. -->
    <PetBubble
      v-if="drawing"
      ref="bubble"
      class="pet-root__bubble"
      :tasks="tasks"
      :now="window_?.now.value ?? 0"
      :force-list="listOpen"
      :bubble-opacity="appearance?.bubbleOpacity"
      @select="selectTask"
      @menu="openMenu"
    />
    <!-- The sprite branch is refused whenever the window has a failure to state about it, because a
         canvas that will never be painted is worse than a sentence: it looks like a pet that is
         standing still. That covers the sheet that will not load and the canvas with no 2D context,
         and for the second it is also what makes the sentence reachable at all — the sentence is
         drawn in `notice`'s own element, which this branch otherwise wins. -->
    <!-- The sprite is the drag handle, so the four pointer listeners and the three state classes
         are on it rather than on the window: they fall through to `PetSprite`'s own canvas, which
         is the element upstream bound them to too (`main.ts:582`). A press on the transparent part
         of the canvas's box still reaches the window — the compositor's switch has no shape — and
         `onPetPointerDown` is what refuses to start anything from it. -->
    <PetSprite
      v-if="drawing && imageUrl && !drawingFailure"
      ref="sprite"
      class="pet-root__sprite"
      :class="{ 'is-movable': movable, 'is-pressed': pressed, 'is-dragging': dragging }"
      :title="spriteHint"
      :image-url="imageUrl"
      :state="mood"
      :width="spriteWidth"
      :height="spriteHeight"
      :animation="animation"
      :clock="clock"
      :create-image="createImage"
      :read-pixels="readPixels"
      :on-load-error="onSheetFailure"
      :on-unavailable="onSpriteUnavailable"
      @pointerdown="onPetPointerDown"
      @pointermove="onPetPointerMove"
      @pointerup="onPetPointerUp"
      @pointercancel="onPetPointerCancel"
    />
    <p
      v-else-if="notice"
      class="pet-root__notice"
    >
      {{ notice }}
    </p>
    <PetContextMenu
      :open="menuAt !== null"
      :anchor="menuAt ?? { x: 0, y: 0 }"
      :capabilities="{ taskCount: tasks.length }"
      @select="onMenuSelect"
      @close="menuAt = null"
    />
  </div>
</template>

<!--
  Unscoped on purpose: the window is frameless and unbacked (§7.2), so the page itself has to be
  transparent and the scrollbars have to be gone — neither of which a scoped rule can reach. This
  is the only place the pet window's page declares anything, and the reason `desktop-pet.html`
  carries no stylesheet of its own.
-->
<style>
html,
body {
  margin: 0;
  padding: 0;
  /* The height the window's own layout is built on, and the chain is the rule: `.pet-root` is
     `height: 100%`, a percentage resolves against its containing block, and a box whose parent has
     no height is `auto` — so without these two lines the root is exactly as tall as its content and
     `justify-content: flex-end` has no free space to put the character on the bottom edge with.
     That is what the window did before this rule: at 160px the sprite stood at 0..180 of a 320px
     window, with 140px of empty window under it, and a bubble at its own ceiling pushed the sprite
     to 349 — 28.5px past the bottom of a window that does not scroll. */
  height: 100%;
  background: transparent;
  overflow: hidden;
}

/* The element `desktop-pet.html` declares and `desktop-pet-entry.ts` mounts into
   (`DESKTOP_PET_ROOT_ID`). It is named here because a percentage needs a parent with a height and
   this is that parent — a third mention of the id, which is why `desktop-pet-entry.test.ts` reads
   this selector and the entry's constant together and fails if either moves. */
#desktop-pet {
  height: 100%;
}
</style>

<style scoped>
.pet-root {
  position: relative;
  display: flex;
  /* A column, so the bubble sits above the character rather than beside it: the window is the
     character's box plus the slack `window_host::character_window_size` leaves for this reminder,
     and the bubble has to fit inside it. */
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  width: 100%;
  /* The window's whole height, which is a fact about the page rather than about this rule: the
     chain is `html`/`body`/`#desktop-pet` in the unscoped block below. This is also what the two
     children are measured against — `flex-end` puts the character on the bottom edge when there is
     room to spare, and the bubble is what gives the room back when there is not. */
  height: 100%;
  /* Nothing here may catch a click the pet is not under: §7.2's pass-through starts with a window
     that does not claim input it is not using. */
  background: transparent;
  user-select: none;
}

/* The bubble grows to its cap and no further; the sprite keeps its own box under it. */
.pet-root__bubble {
  flex: 0 1 auto;
  min-height: 0;
  align-self: stretch;
}

/* The character keeps the box the size setting gave it, whatever the window turns out to be.
   Without this it is a flex item like any other — `flex: 0 1 auto` — and the automatic minimum
   size that saves it here (a canvas cannot shrink below its own content) is a property of the
   element rather than a decision this file made. Stated, the rule means what the measurement in
   `e2e/desktop-pet-window-fit.spec.ts` asserts: the canvas is drawn at `character.size`, never
   squeezed to make a bubble fit. */
.pet-root__sprite {
  flex: none;
}

/* The character is the drag handle, so the canvas is the element that says so. `grab` only where
   there is a drag to make — §5.2's 「不能用的控件要说出来」, and the same rule the orb's hint follows:
   a cursor promising movement on a desktop that cannot move the window is the lie the tooltip
   beside it is there to avoid. */
.pet-root__sprite.is-movable {
  cursor: grab;
  /* Pointer events, not mouse events: the press must keep being measured while the cursor is over
     the desktop, and the browser must not claim the gesture first. The orb's line, for its reason. */
  touch-action: none;
}

/* The orb's two states, translated to a surface that may not be scaled. The orb presses to
   `scale(0.96)` and drags at `scale(1.01)`; a pixel-art sprite scaled by 0.96 lands between its
   pixels and is drawn as a smear, so the same two states are a shade here. Neither declares a
   `transition`, which is what keeps the paragraph above `appearance` true: this window still has
   no CSS animation or transition for §5.2's 动效 to turn off, so a reduce-motion rule added here
   would be a class nothing could see — and the states stay, because they say what the pointer is
   doing rather than decorating it. */
.pet-root__sprite.is-pressed {
  filter: brightness(0.92);
}

.pet-root__sprite.is-dragging {
  cursor: grabbing;
  filter: brightness(1.06);
}

.pet-root__notice {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--app-radius, 8px);
  background: var(--app-elevated, rgb(0 0 0 / 60%));
  color: var(--app-text, #fff);
  font-size: 12px;
  line-height: 1.4;
  text-align: center;
}
</style>
