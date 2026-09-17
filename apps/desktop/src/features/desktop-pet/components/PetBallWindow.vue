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
 *   is in the pet capability for exactly this read. The two domains the orb draws from are the
 *   `character` one and `general` — its motion policy (§5.2's 动效) and the orb's own diameter
 *   (§5.1's 悬浮球) — so a character, a motion policy or a size chosen in the main window's
 *   settings reaches a ball that is already on the desktop, the rule `use-pet-window.ts` states
 *   for the character window.
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
import { computed, onMounted, onScopeDispose, ref } from 'vue'
import {
  isPetAppearance,
  PET_MOTION_DEFAULT,
  PET_SETTINGS_DEFAULTS,
} from '../../../platform/gateways/pet-contracts'
import type {
  PetMotion,
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
     * The desktop's drag and snap, when this build has one.
     *
     * The composition supplies it wherever the page has a Tauri window behind it
     * (`resolveDesktopPetBallDependencies`), and `capabilities/desktop-pet.json` grants the
     * `pet-*` windows the one permission the drag calls — so it is present in the product, and the
     * orb's tooltip reads 「Drag to move」 there. Absent stays a state rather than a gap: a browser
     * page, or a caller that passes none, is a desktop that cannot move the orb, and it says so
     * instead of offering a drag that does nothing (§7.2).
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
 * 56 px orb in it at the schema's default size, and the rule's own ceiling leaves it no room for a
 * sentence either.
 */
const imageUrl = ref<string | null>(null)
/** The host's own words when it had none to draw, or when the read was refused. */
const notice = ref<string | null>(null)

/**
 * What the windows are allowed to do, from the same read (`general.motion`).
 *
 * **This is the one surface §5.2's reduce-motion clause is about today.** The orb scales under the
 * pointer, and that travel is motion: with the app's setting on `reduced` it stops, which is the
 * behaviour upstream implements by toggling a `reduce-motion` class on its ball window
 * (`references/desktop-pet/windows/src/floating-ball.ts:265-269`, and
 * `windows/src/styles.css:1280-1287` for the list it turns off). The *system's* own
 * `prefers-reduced-motion` is answered by the orb's own stylesheet and does not need to be folded
 * in here — the two are independent ways into the same state, and reading the app's setting as
 * "the system said so" would make the two indistinguishable.
 *
 * It starts at the schema's default rather than at nothing, so the first frame is drawn under the
 * policy this build was built with: [`PET_MOTION_DEFAULT`], which the read replaces as soon as the
 * host answers.
 */
const motion = ref<PetMotion>(PET_MOTION_DEFAULT)
const reduceMotion = computed(() => motion.value === 'reduced')

/**
 * How large the orb is drawn, from the same read (`general.ballSize`, §5.1's 悬浮球).
 *
 * **The one stored number behind both the orb and the window around it.** The host sizes this
 * window from it (`ball.rs`: the stored diameter plus `2 * BALL_MARGIN`), and `PetFloatingBall.vue`
 * adds the same margin to what it is handed here, so a page that drew the orb at anything else
 * would draw it outside the box the host gave it — §9's second answer, stated as arithmetic. The
 * value arrives already inside its rule (`petBallSizeOf`), which is the same rule the settings
 * control writes against.
 *
 * Read on every answer, including the two that draw nothing: upstream's plain orb is still an orb
 * of some size, and a fresh install with no character chosen can still want a bigger one.
 *
 * It starts at the schema's default rather than at nothing, for {@link motion}'s reason: the first
 * frame is drawn at the size this build was built with, and the read replaces it as soon as the
 * host answers.
 */
const ballSize = ref<number>(PET_SETTINGS_DEFAULTS.general.ballSize)

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
    // Set on every answer, including the two that draw nothing: a policy is not a property of the
    // character, and a write that turns it off has to reach a ball that is already on screen. The
    // size rides the same answer for the same reason — the orb is drawn in all three arms, and a
    // slider moved in the main window has to resize a ball that is already on the desktop.
    motion.value = view.motion
    ballSize.value = view.ballSize
  } catch (cause) {
    if (disposed) return
    imageUrl.value = null
    notice.value = cause instanceof Error ? cause.message : String(cause)
  }
}

/**
 * Another window wrote a setting. Two domains reach this window, and both arrive on this one read:
 * `character` decides what it wears and `general` decides how far it may move (`general.motion`,
 * which `desktop_pet_appearance` carries). Every other domain is ignored — a write to `care` or
 * `notification` costs one comparison.
 */
function onSettingsChanged(change: PetSettingsChange): void {
  if (change.domain !== 'character' && change.domain !== 'general') return
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
    :size="ballSize"
    :platform="platform"
    :clock="clock"
    :create-image="createImage"
    :title="notice ?? undefined"
    :reduce-motion="reduceMotion"
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
