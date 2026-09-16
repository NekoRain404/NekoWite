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
import type { PetGateway } from '../../../platform/gateways/pet-contracts'
import type { AnimationConfig, SpriteClock } from '../rendering/animation-bindings'
import type { ImageFactory, LoadFailure } from '../rendering/sprite-sheet'
import type { SheetPixelReader } from '../rendering/sprite-slicer'
import { usePetLifecycle } from '../composables/use-pet-lifecycle'
import PetSprite from './PetSprite.vue'

const props = withDefaults(
  defineProps<{
    /**
     * The host connection. Absent means unwired rather than broken, and the window says which:
     * the composition that supplies it is `desktop-pet-composition.ts` (§9, the integrator's).
     */
    gateway?: PetGateway | null
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

const drawing = computed(() => lifecycle?.state.value.drawing ?? false)
/** A sheet that failed to load, so the window can say so instead of looking idle for ever. */
const sheetFailure = ref<string | null>(null)

const notice = computed<string | null>(() => {
  const state = lifecycle?.state.value
  if (!state) return 'This window has no host connection.'
  if (state.error) return state.error
  if (state.connecting) return null
  if (!state.enabled) return 'The pet is switched off.'
  if (sheetFailure.value) return sheetFailure.value
  if (!props.imageUrl) return 'No character is selected.'
  return null
})

/**
 * Upstream threw from the sheet loader and left the pet frozen (§3.1's resource-failure rule,
 * D2's deviation 2). A window whose character will not load is a state, and stating it is the
 * difference between a pet that is broken and a pet that looks asleep.
 */
function onSheetFailure(failure: LoadFailure): void {
  sheetFailure.value = `The character's spritesheet did not load (${failure.phase}).`
}

onMounted(() => void lifecycle?.start())
// Not `await`ed: Vue's unmount is synchronous, and the one thing that is a promise — the host's
// unsubscribe — is issued before this returns. `usePetLifecycle` also registers its own scope
// disposal, so a future edit that drops this call still cannot leak.
onBeforeUnmount(() => void lifecycle?.dispose())

defineExpose({ lifecycle })
</script>

<template>
  <div class="pet-root">
    <!-- The sprite branch is refused once the sheet has failed, because a canvas that will never
         be painted is worse than a sentence: it looks like a pet that is standing still. -->
    <PetSprite
      v-if="drawing && imageUrl && !sheetFailure"
      :image-url="imageUrl"
      :state="mood"
      :width="width"
      :height="height"
      :animation="animation"
      :clock="clock"
      :create-image="createImage"
      :read-pixels="readPixels"
      :on-load-error="onSheetFailure"
    />
    <p
      v-else-if="notice"
      class="pet-root__notice"
    >
      {{ notice }}
    </p>
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
  display: flex;
  align-items: flex-end;
  justify-content: center;
  width: 100%;
  height: 100%;
  /* Nothing here may catch a click the pet is not under: §7.2's pass-through starts with a window
     that does not claim input it is not using. */
  background: transparent;
  user-select: none;
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
