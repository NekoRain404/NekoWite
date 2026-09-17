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
 * (`use-pet-drag.ts`) is the port of upstream's rule, and the two consequences worth knowing
 * before reading it are that the drag handle is the sprite rather than the window, and that a
 * window with a drag handle has to take the pointer for it.
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
import { usePetDrag } from '../composables/use-pet-drag'
import { usePetDrawingFailure } from '../composables/use-pet-drawing-failure'
import { usePetLifecycle } from '../composables/use-pet-lifecycle'
import { usePetPageTheme } from '../composables/use-pet-page-theme'
import { usePetWindow } from '../composables/use-pet-window'
import {
  PET_BUBBLE_VIEW_DEFAULTS,
  type PetAppearanceView,
  type PetBubbleView,
} from '../services/pet-appearance'
// The ball's gesture, reused rather than restated. `pet-ball-input.ts` is where upstream's
// click-versus-drag arithmetic was ported from `floating-ball.ts`, and the character window's
// drag needs exactly that arithmetic — the same 4 px threshold, the same 280 ms click window, the
// same screen-coordinate reading (see that file's header) — so this is the *one* implementation
// both of the pet's surfaces call, and the character asks for it by the name the port gave it.
import type { PetBallPlatform } from '../services/pet-ball-input'
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
 * The bubble's content model and the line it says (§5.2's 气泡与消息 and 自定义词句).
 *
 * **These three props are what makes a whole settings page reach a surface.** `PetBubble` has taken
 * a `layout` and a `phrases` prop since it was written, and nothing in the product passed either:
 * the page at `features/desktop-pet-settings/components/PetBubbleSettings.vue` stored a layout mode,
 * a row cap, a grouping, a filter, a separator and a row-field list, and this window drew a bubble
 * from its own compiled-in defaults. That is this project's signature defect — a surface built,
 * tested in isolation and mounted nowhere — and worse here than usual, because the window *did*
 * draw a bubble: a user who wrote a phrase saw a bubble and not their words.
 *
 * A window with no host connection (`window_` is null) draws the renderer's own defaults, which is
 * the layout this build's bubble has always had, so the no-host state is unchanged.
 */
const bubbleModel = computed<PetBubbleView>(
  () => window_?.bubble.value ?? PET_BUBBLE_VIEW_DEFAULTS,
)
const line = computed(() => window_?.line.value ?? null)

/**
 * The page's palette, from `message.theme` — the one setting on 气泡与消息 that is not drawn on a
 * surface inside this window but **on the window itself**.
 *
 * The bubble's theme is a choice between the app's two palettes, and the app's palettes are selected
 * on a page's root: `:root` is the light one and `[data-theme="dark"]` re-points it
 * (`styles/palettes.css:16-92`). This window is its own page, so its root is the html element, and
 * the attribute goes there. `pet-bubble-theme.ts` carries the whole argument, including why the
 * light arm needs no second table and what the third member of the setting can observe.
 *
 * Declared here rather than in `desktop-pet-entry.ts` because the value is not the entry's: it
 * arrives on the appearance read, which `usePetWindow` owns, and the entry mounts before any read
 * has happened. A window with no host draws `PET_BUBBLE_VIEW_DEFAULTS` — `system`, which is what
 * the bubble was drawn with before the setting reached this window.
 */
usePetPageTheme({ theme: () => bubbleModel.value.theme })

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
 * The character's drag — the gesture, the states it reports and the capability it needs.
 *
 * A composable rather than a block here: what this window *draws* and what a pointer can *do to it*
 * are two subjects, and `use-pet-drag.ts` owns the second one whole, with the port's own rules and
 * upstream's line references in its header. What stays here is the wiring the template needs.
 *
 * The sprite ref is this component's, because the template's `ref` attribute is what fills it; the
 * composable is handed a getter over it so a re-render that replaces the instance is seen.
 */
const sprite = ref<InstanceType<typeof PetSprite> | null>(null)
const drag = usePetDrag({
  platform: () => props.platform,
  drawing: () => drawing.value,
  sheet: () => imageUrl.value,
  failed: () => Boolean(drawingFailure.value),
  surface: () => sprite.value,
  now: props.now,
})
const { pressed, dragging, movable, hint: spriteHint } = drag
/** Whether the character is what the pointer can act on — read by `needsInput` below. */
const dragHandle = drag.handle

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
      :font-size="bubbleModel.fontSize"
      :dot="bubbleModel.dot"
      :layout="bubbleModel.layout"
      :line="line"
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
         `use-pet-drag.ts`'s `onPointerDown` is what refuses to start anything from it. -->
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
      @pointerdown="drag.onPointerDown"
      @pointermove="drag.onPointerMove"
      @pointerup="drag.onPointerUp"
      @pointercancel="drag.onPointerCancel"
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

/* The bubble grows to its cap and no further, and is centred on the same axis as the character;
   its own box is what gives the height back. */
.pet-root__bubble {
  flex: 0 1 auto;
  min-height: 0;
  /* **No `align-self: stretch`, and that is the fix for a measured deviation.** Stretching the item
     on the cross axis *replaces* the column's `align-items: center`, and a stretched item that
     cannot reach its stretched size — this one is capped at `PET_BUBBLE_MAX_WIDTH` — is placed at
     the **start** edge instead of being centred. So on both engines the bubble sat against the left
     edge of the window however wide the window was: measured in Chromium (Playwright, the product's
     own root in the page's own mount point) at a 320px character in the 420px window the host builds
     for it, the surface came out at `x=0…260` — a left gap of 0 and a right gap of 160 — while the
     sprite it belongs to was centred at `50…370`. At the default 160px character the window is
     260px wide and there is no slack, so the two readings are identical there; the deviation needed
     a window with room in it to show, which is why the case sweeps both sizes.

     Upstream's column has no such rule (`references/desktop-pet/windows/src/styles.css:20-28`,
     `.bubble` at `:38-58` carries only a `max-width`), so this was a porting deviation rather than a
     decision: the bubble is centred by the container and lines up with the character under it.
     The width still comes from `PetBubble.vue`'s own `width: 100%` clamped by that cap, so removing
     this line does not let the surface take the whole window: a percentage width resolves against
     the parent's content box and `max-width` caps it, which is what the containment half of the
     same case asserts. `flex: 0 1 auto` above is the *main* axis and is what gives the height back,
     so the two rules cannot be confused for one another. */
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
