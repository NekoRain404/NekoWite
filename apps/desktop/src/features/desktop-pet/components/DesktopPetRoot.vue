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
import { usePetDrawingFailure } from '../composables/use-pet-drawing-failure'
import { usePetLifecycle } from '../composables/use-pet-lifecycle'
import { usePetWindow } from '../composables/use-pet-window'
import type { PetAppearanceView } from '../services/pet-appearance'
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

/** What to draw: the host's read when there is one, the caller's props otherwise. */
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
      class="pet-root__bubble"
      :tasks="tasks"
      :now="window_?.now.value ?? 0"
      :force-list="listOpen"
      @select="selectTask"
      @menu="openMenu"
    />
    <!-- The sprite branch is refused whenever the window has a failure to state about it, because a
         canvas that will never be painted is worse than a sentence: it looks like a pet that is
         standing still. That covers the sheet that will not load and the canvas with no 2D context,
         and for the second it is also what makes the sentence reachable at all — the sentence is
         drawn in `notice`'s own element, which this branch otherwise wins. -->
    <PetSprite
      v-if="drawing && imageUrl && !drawingFailure"
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
  background: transparent;
  overflow: hidden;
}
</style>

<style scoped>
.pet-root {
  position: relative;
  display: flex;
  /* A column, so the bubble sits above the character rather than beside it: the window is the
     character's box (§7.1's CHARACTER_WINDOW_SIZE), and the reminder has to fit inside it. */
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  width: 100%;
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
