<script setup lang="ts">
/**
 * The pet's canvas: one spritesheet, drawn when the player says the frame changed.
 *
 * Upstream has no Vue - this replaces its DOM wiring (`document.getElementById("pet")`
 * plus `new Pet(canvas)`, `windows/src/main.ts` 76-78) and nothing else. Slicing, playback,
 * hit-testing and the state-to-animation mapping are all in `../rendering/*` and are ported
 * from `windows/src/pet.ts`; see those files' headers for the symbol and line each came
 * from. Plan §3.1.6 is the reason for the split: 可复用算法不等于可直接挂载整个 UI, so this
 * file owns the canvas and the lifecycle, not the algorithm.
 *
 * Two deliberate differences from upstream's inline wiring:
 *
 * - The backing store is sized at device resolution. Upstream kept a fixed 160x180 canvas
 *   (`index.html` 12) and scaled the CSS box (`main.ts` 116-117), so on a HiDPI display the
 *   compositor resampled the pixel art. Nothing in the player changed for this: it works in
 *   backing-store pixels, and only `viewport()` hands it a bigger canvas - which is also
 *   what makes the hit test's CSS-to-backing scaling meaningful.
 *
 * - A missing 2D context is a state, not an exception. Upstream threw "no 2d context" from
 *   the Pet constructor (154); thrown from a Vue mount it would blank the whole pet window.
 *   §3 asks for resource failure to be handled, so this reports it and draws nothing.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AnimationConfig, SpriteClock } from '../rendering/animation-bindings'
import { SpritePlayer, type FramePlacement, type Viewport } from '../rendering/sprite-player'
import type { ImageFactory, LoadFailure } from '../rendering/sprite-sheet'
import { contextAlphaReader, hitTestSprite, type PointAlphaReader } from '../rendering/sprite-hit-test'
import type { Rect, SheetPixelReader } from '../rendering/sprite-slicer'

const props = defineProps<{
  /** The current character's spritesheet; null draws nothing. */
  imageUrl?: string | null
  /** Host pet state (idle / working / waiting / ...); drives the row and the frame rate. */
  state?: string
  /** Roam override row (`Pet.setRow`); null follows the mood row. */
  overrideRow?: number | null
  /** Animation mapping from settings; fields left out keep the upstream defaults. */
  animation?: Partial<AnimationConfig>
  /** Sprite box in CSS pixels; the sheet is fit bottom-centre inside it. */
  width?: number
  /** Sprite box in CSS pixels. */
  height?: number
  /** Injected for tests (plan §10.2): the frame and idle clock. */
  clock?: SpriteClock
  /** Injected for tests: used instead of `new Image()`. */
  createImage?: ImageFactory
  /** Injected for tests: the sheet pixel reader used for slicing. */
  readPixels?: SheetPixelReader
  /** Both load attempts for a sheet failed. */
  onLoadError?: (failure: LoadFailure) => void
  /** The canvas has no 2D context, so nothing can be drawn. */
  onUnavailable?: (reason: 'no-2d-context') => void
}>()

/** Upstream's canvas size at 100% pet size (`index.html` 12, `main.ts` 116-117). */
const BASE_SIZE = { width: 160, height: 180 }

/**
 * Whatever `drawImage` accepts. Spelled as a type query rather than the global
 * `CanvasImageSource` because the lint config's `no-undef` (which this repo keeps on for
 * TypeScript) reports a global type name used inside an `as` expression.
 */
type DrawableImage = Parameters<CanvasRenderingContext2D['drawImage']>[0]

const canvas = ref<HTMLCanvasElement | null>(null)
// The player, the context and the alpha reader are held outside Vue's reactivity on
// purpose: they change per frame, and §7.3 asks for compositor-friendly work, not reactive
// churn on the render path.
let player: SpritePlayer | null = null
let unsubscribe: (() => void) | null = null
let ctx: CanvasRenderingContext2D | null = null
let readAlpha: PointAlphaReader | null = null

/**
 * The canvas in backing-store pixels: the CSS box times the device pixel ratio. Read on
 * every tick rather than cached, so moving the window to a display with a different ratio
 * needs no extra listener.
 */
function backingSize(): Viewport {
  const ratio = window.devicePixelRatio || 1
  return {
    width: Math.max(1, Math.round((props.width ?? BASE_SIZE.width) * ratio)),
    height: Math.max(1, Math.round((props.height ?? BASE_SIZE.height) * ratio)),
  }
}

function syncCanvasSize(): void {
  const el = canvas.value
  if (!el) return
  const size = backingSize()
  if (el.width !== size.width || el.height !== size.height) {
    el.width = size.width
    el.height = size.height
  }
  // A resize is not an animation frame: the frame counter has not moved, so the player has
  // to be told that what it last drew is stale at the new size.
  player?.invalidate()
}

/** Empty the canvas; used when there is no character to draw at all. */
function clearCanvas(): void {
  const el = canvas.value
  if (!el || !ctx) return
  ctx.clearRect(0, 0, el.width, el.height)
}

function draw(frame: FramePlacement): void {
  const el = canvas.value
  const image = player?.currentImage
  if (!el || !ctx || !image) return
  ctx.clearRect(0, 0, el.width, el.height)
  // The loader's image interface is structural so a test can hand in a fake; the only
  // element a browser can produce through it is an `HTMLImageElement`.
  ctx.drawImage(
    image as unknown as DrawableImage,
    frame.source.x,
    frame.source.y,
    frame.source.w,
    frame.source.h,
    frame.dest.x,
    frame.dest.y,
    frame.dest.w,
    frame.dest.h,
  )
}

/**
 * Is this CSS-pixel point on the character? The shell uses it to tell a drag on the pet
 * from a click on the gap beside it (§7.2) - it is not OS-level click-through.
 */
function hitTest(x: number, y: number): boolean {
  const el = canvas.value
  if (!el || !readAlpha) return false
  return hitTestSprite(
    { x, y },
    {
      spriteRect: player?.spriteRect ?? null,
      surface: {
        width: el.width,
        height: el.height,
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
      },
      readAlpha,
    },
  )
}

/** What the shell needs to place the bubble and the click-through rect (backing-store px). */
function geometry(): { spriteRect: Rect | null; headroom: number } {
  return { spriteRect: player?.spriteRect ?? null, headroom: player?.headroom ?? 0 }
}

onMounted(() => {
  const el = canvas.value
  if (!el) return
  const context = el.getContext('2d')
  if (context) {
    // Upstream 156: pixel art must not be smoothed.
    context.imageSmoothingEnabled = false
    ctx = context
    readAlpha = contextAlphaReader(context)
  } else {
    props.onUnavailable?.('no-2d-context')
  }
  syncCanvasSize()

  const created = new SpritePlayer({
    clock: props.clock,
    viewport: backingSize,
    config: props.animation,
    createImage: props.createImage,
    readPixels: props.readPixels,
    onLoadError: props.onLoadError,
  })
  player = created
  unsubscribe = created.onFrame(draw)
  created.setState(props.state ?? 'idle')
  created.setOverrideRow(props.overrideRow ?? null)
  if (props.imageUrl) created.load(props.imageUrl)
  // A window resize can change both the CSS box and the device pixel ratio; §7.3's warning
  // is against reading layout per frame, and this reads it per resize.
  window.addEventListener('resize', syncCanvasSize)
})

onBeforeUnmount(() => {
  // §7.1/§10.2: the unmount is the destruction path - no timer, image, URL or listener is
  // left behind, and after this no frame callback can arrive.
  window.removeEventListener('resize', syncCanvasSize)
  unsubscribe?.()
  unsubscribe = null
  player?.destroy()
  player = null
  ctx = null
  readAlpha = null
})

watch(
  () => props.imageUrl,
  (url) => {
    if (!player) return
    if (url) {
      player.load(url)
    } else {
      // No character: the player stops drawing, so the last sprite would otherwise stay
      // painted on the canvas forever.
      player.unload()
      clearCanvas()
    }
  },
)

watch(
  () => props.state,
  (state) => player?.setState(state ?? 'idle'),
)

watch(
  () => props.overrideRow,
  (row) => player?.setOverrideRow(row ?? null),
)

// Deep: a settings object can be mutated in place, and the animation mapping is a nested
// record either way.
watch(
  () => props.animation,
  (animation) => player?.setConfig(animation ?? {}),
  { deep: true },
)

watch(() => [props.width, props.height], syncCanvasSize)

defineExpose({ hitTest, geometry })
</script>

<template>
  <!-- The sprite is the pet's visual layer only. What the pet is doing (working, waiting
       for approval, done) is announced by the bubble and the task list, which own the i18n
       strings; this layer has none of its own, so it stays out of the accessibility tree. -->
  <canvas
    ref="canvas"
    class="pet-sprite"
    aria-hidden="true"
    :style="{
      width: `${props.width ?? BASE_SIZE.width}px`,
      height: `${props.height ?? BASE_SIZE.height}px`,
    }"
  />
</template>

<style scoped>
.pet-sprite {
  display: block;
  /* Matches `imageSmoothingEnabled = false` on the context: if the CSS box and the backing
     store ever disagree, the sheet is still scaled without blur. */
  image-rendering: pixelated;
  background: transparent;
}
</style>
