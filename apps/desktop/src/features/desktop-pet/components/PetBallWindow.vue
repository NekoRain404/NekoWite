<script setup lang="ts">
/**
 * The ball window's root: the orb, what it wears, and where its two gestures go.
 *
 * `PetFloatingBall` is the surface — the orb, the three gestures, what a broken character draws
 * instead — and this is the window around it. That is the same division `DesktopPetRoot.vue` has
 * with the sprite, the bubble and the menu: what the *host* says is a fact about the window, and
 * the orb owns what can be seen and pressed.
 *
 * Three decisions, each with the rule it comes from:
 *
 * - **It reads the appearance, and re-reads it when another window changes it.** This is what
 *   makes the ball wear the character instead of upstream's plain orb, and `desktop_pet_appearance`
 *   is in the pet capability for exactly this read. The `character` domain is the only settings
 *   fact the orb draws from, so a character chosen in the main window's settings reaches a ball
 *   that is already on the desktop — the rule `use-pet-window.ts` states for the character window.
 * - **Right-click is upstream's 「right = Settings」** (`lib.rs:306-309`) and lands on `general`,
 *   which is where §5.1's 常规与交互 (启用、窗口行为、点击动作、悬浮球) lives. The left click is
 *   *not* wired: upstream opens its quick-bubble menu by growing this window to 300x420
 *   (`floating-ball.ts:117`, `:161`), which needs a window-resize permission the pet's capability
 *   deliberately does not hold, and what the left click does is `ap_left_click_action` — a setting
 *   this build has not built (`desktop-pet-port-ledger.md:114`). A click that opened something
 *   invented would be worse than one that opens nothing, and the orb already reports the gesture,
 *   so wiring it later is one function here.
 * - **Nothing here makes the window click-through.** §7.2's 鼠标穿透 belongs to the character
 *   window, which has nothing for the pointer most of the time; the ball is the opposite surface —
 *   a stable click target that exists to be clicked — so `usePetClickThrough` is not mounted, and
 *   the host would refuse it anyway (the ball is not a character instance: `window_host.rs`).
 */
import { onMounted, onScopeDispose, ref } from 'vue'
import { isPetAppearance } from '../../../platform/gateways/pet-contracts'
import type {
  PetSettingsChange,
  PetWindowGateway,
} from '../../../platform/gateways/pet-contracts'
import type { SpriteClock } from '../rendering/animation-bindings'
import type { ImageFactory } from '../rendering/sprite-sheet'
import type { PetBallPlatform } from '../services/pet-ball-input'
import { petAppearanceView } from '../services/pet-appearance'
import PetFloatingBall from './PetFloatingBall.vue'

const props = withDefaults(
  defineProps<{
    /**
     * The host connection. Absent means unwired rather than broken — the state
     * `DesktopPetRoot.vue` renders for too, and the composition supplies it.
     */
    connection?: PetWindowGateway | null
    /**
     * The desktop's drag and snap, when this build has one. Absent is the honest state today: the
     * pet's capability holds no window-movement permission and there is no snap command, so the
     * orb says 「This desktop cannot move it」 rather than offering a drag that does nothing.
     */
    platform?: PetBallPlatform | null
    /** Injected for tests (§10.2): passed to the orb, and through it to the sprite. */
    clock?: SpriteClock
    /** Injected for tests: passed to the orb, and through it to the sprite. */
    createImage?: ImageFactory
  }>(),
  {
    connection: null,
    platform: null,
    clock: undefined,
    createImage: undefined,
  },
)

/**
 * What the orb wears, or null for upstream's own plain orb.
 *
 * `unset` — nobody has chosen a character — is the ordinary state of a fresh install and not a
 * failure: upstream's ball drew an orb with no character either. A character that cannot be
 * produced, a refused read and a host that answers something that is not an appearance all leave
 * the same plain orb, and what tells them apart is a sentence for a window with room: the pet
 * window draws it at 260x320 and the settings character page lists what it cannot draw. Here it
 * rides as the orb's tooltip — see {@link notice} — because this window is an 80 px box with a
 * 56 px orb in it.
 */
const imageUrl = ref<string | null>(null)
/** The host's own words when it had none to draw, or when the read was refused. */
const notice = ref<string | null>(null)

let unsubscribe: (() => void) | null = null
let disposed = false

/** One read of what to draw. */
async function readAppearance(): Promise<void> {
  if (!props.connection) return
  try {
    const read = await props.connection.appearance()
    if (disposed) return
    if (!isPetAppearance(read)) {
      // An answer that is not an appearance is not one: a build whose stub answers `undefined`
      // must not be read as "no character is selected", which would be a claim this window cannot
      // make about the user's choice.
      imageUrl.value = null
      notice.value = 'the host answered something that is not a character to draw'
      return
    }
    const view = petAppearanceView(read)
    imageUrl.value = view.imageUrl
    notice.value = view.notice
  } catch (cause) {
    if (disposed) return
    imageUrl.value = null
    notice.value = cause instanceof Error ? cause.message : String(cause)
  }
}

/** Another window wrote a setting: only the `character` domain changes what this one draws. */
function onSettingsChanged(change: PetSettingsChange): void {
  if (change.domain !== 'character') return
  void readAppearance()
}

/** Read once now, then listen for another window's change. */
async function start(): Promise<void> {
  if (disposed) return
  // The read first, then the subscription — the ordering `use-pet-window.ts` uses, for its reason:
  // a change that lands in between is delivered twice rather than lost.
  await readAppearance()
  if (!props.connection) return
  try {
    const off = await props.connection.subscribeSettings(onSettingsChanged)
    if (disposed) off()
    else unsubscribe = off
  } catch (cause) {
    // A host that cannot deliver the channel still has a working `appearance` read, so this is a
    // statement rather than a state: the ball keeps drawing what it has.
    notice.value ??= cause instanceof Error ? cause.message : String(cause)
  }
}

/** Right-click: upstream's 「right = Settings」. */
function openSettings(): void {
  void props.connection?.openSettings('general').catch(() => undefined)
}

/** The left click, which opens nothing in this window — see this file's header. */
function onToggleMenu(): void {
  // Deliberately empty: there is no menu to open, and inventing one here would be a surface the
  // window cannot hold. The orb reports the gesture; the day the menu lands it is one function.
}

function dispose(): void {
  if (disposed) return
  disposed = true
  unsubscribe?.()
  unsubscribe = null
}

onMounted(() => void start())
// A window that unmounts without disposing is the leak D3's composable exists to prevent.
onScopeDispose(dispose)
</script>

<template>
  <PetFloatingBall
    :image-url="imageUrl"
    :platform="platform"
    :clock="clock"
    :create-image="createImage"
    :title="notice ?? undefined"
    @open-settings="openSettings"
    @toggle-menu="onToggleMenu"
  />
</template>

<!--
  Unscoped on purpose, and the same rule `DesktopPetRoot.vue` states for its own page: the window
  is frameless and unbacked (§7.2), so the page has to be transparent and must not scroll — neither
  of which a scoped rule can reach. `desktop-pet-ball.html` therefore carries no stylesheet of its
  own.
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
