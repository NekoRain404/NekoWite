/**
 * The desktop, as the ball's gestures reach it — the real end of {@link PetBallPlatform}.
 *
 * Three decisions, each with the rule behind it:
 *
 * - **It is built on `platform/window.ts`, not on `@tauri-apps/api`.** That module states the rule
 *   for the whole app — "UI code calls these narrow controls instead of importing
 *   `@tauri-apps/api/window` directly, so the business/feature layers stay free of the Tauri
 *   bridge" — and this file is a feature service, so it takes the adapter rather than the bridge.
 *   `tauri-pet.ts`'s "only file in the pet that imports a Tauri API" stays true: what is imported
 *   here is the app's own control surface.
 * - **`snap` is absent, and that is the honest state rather than an unfinished one.** The port
 *   declares it optional precisely so a desktop that cannot do it says so by not implementing it
 *   (`pet-ball-input.ts`), and the orb already reads that absence: it keeps the ball where the user
 *   dropped it. Snapping needs the window's position and the monitor's geometry (three more
 *   permissions in `capabilities/desktop-pet-ball.json`) and a place to *remember* the dropped
 *   position — without which the ball snaps to an edge and is back in its corner on the next
 *   launch, which is tidiness rather than the feature the reference has. Absent is what the port
 *   has a slot for; a method that resolved without moving anything is what it does not.
 * - **One `startDragging`, per gesture.** The compositor owns the pointer from the moment it
 *   starts (`PetFloatingBall.vue`'s `pointercancel` arm), so a drag costs one IPC call and a
 *   resolve, and the window moves without this process being involved at all — `§7.3`'s ban on
 *   per-frame IPC is satisfied by the design rather than by discipline.
 */
import { getWindowControls, type WindowControls } from '../../../platform/window'
import type { PetBallPlatform } from './pet-ball-input'

/**
 * The ball's window, as the drag needs it, over the app's window controls.
 *
 * `controls` is a parameter so the behaviour can be exercised without a Tauri host — the same
 * injection `pet-ball-input.ts` asks for with the platform itself, one level down. The product
 * passes nothing.
 *
 * **The window is looked up on the first drag, not here.** `getWindowControls()` reads the label of
 * the window the page runs in, and that is a question about the *call*, not about the object: the
 * resolver that builds this runs in every window that has a host, including the ones whose host is
 * only a marker (the composition's own tests among them), and a page whose `__TAURI_INTERNALS__` is
 * not a real window has nothing to look up. A gesture that cannot find its window throws into
 * `endDrag`'s own catch, which is the same place a compositor's refusal lands.
 */
export function createBallPlatform(controls?: WindowControls): PetBallPlatform {
  let resolved: WindowControls | null = controls ?? null
  return {
    // Resolves when the operating-system drag is over, which is what the orb's `endDrag` waits for
    // before it clears the dragging state (upstream's `finally`, `floating-ball.ts:219-223`).
    startDrag: () => {
      resolved ??= getWindowControls()
      return resolved.startDragging()
    },
  }
}
