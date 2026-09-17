/**
 * The pet's composition root: which adapter the pet runs on, and what a menu item does.
 *
 * §9 gives this file one job — 「只装配 gateway、任务导航、设置入口；使用 `features/desktop-pet/index.ts`
 * 的公开接口」 — and §10.1 names it as the pet plan's shared assembly point. So what is here is
 * the *choice* of host connection, the entry's resolver, and the menu actions the feature
 * publishes; there is no store, no view and no editor, and nothing here reads a setting, opens a
 * window or draws anything.
 *
 * ## The environment, and why there is no memory fallback
 *
 * `agent-composition.ts` next door falls back to the ACP *double* in a browser, and this file
 * deliberately does not. A pet window with no host is not a pet that runs on a fixture — §7.1's
 * isolation clause exists because a window whose every task came from a fixture is
 * indistinguishable from a working one. In a Tauri window this returns the real adapter; anywhere
 * else it returns `null`, and the two callers below state that rather than substituting: the pet
 * window renders "This window has no host connection." and the settings section says it is
 * unwired. Both are true, and both stop being true the moment there is a host.
 *
 * ## What both windows get
 *
 * The same function serves both, because both windows need the same thing and each has its own
 * module instance: the pet window hands it to `mountDesktopPet`, and the main window's settings
 * section mounts its pages against it. The connection is created once per window and cached — not
 * because the adapter holds state (it holds none beyond a listener per subscription) but because
 * `<DesktopPetSettings :gateway>` re-rendering against a new object every frame would be a new
 * host connection per frame.
 */
import { createTauriPetConnection, type PetHostConnection } from '../platform/gateways/tauri-pet'
// The feature's public entry would carry the same cost here as it would in the entry above: this
// file is in the pet window, and `features/desktop-pet/index.ts` re-exports the care surface. The
// menu actions are one service, so they are imported where they live.
import { actOnPetMenu, type PetMenuOutcome } from '../features/desktop-pet/services/pet-menu-actions'
// `PetMenuAction` is `pet-context-menu.ts`'s declaration, and `pet-menu-actions.ts` takes it as a
// parameter without re-exporting it — so it is imported from the module that declares it. A second
// spelling of the import would be a re-export to keep in step with the first, and this window is
// the one place that cannot afford the feature's public entry (see above).
import type { PetMenuAction } from '../features/desktop-pet/services/pet-context-menu'
// The ball's drag, as the app's window controls rather than the Tauri bridge — the rule
// `platform/window.ts` states for every feature. Built below only on the host path, which is what
// keeps `getCurrentWindow()` out of a page that has no window to name.
import { createBallPlatform } from '../features/desktop-pet/services/pet-ball-platform'
import type { DesktopPetBallDependencies } from './desktop-pet-ball-entry'
import type { DesktopPetDependencies } from './desktop-pet-entry'

/** Whether this window is the app's, or a browser/test page with no host behind it. */
function hasHost(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  )
}

let cached: PetHostConnection | null = null

/**
 * The host connection, or `null` where this build has none.
 *
 * `null` is a state and not an error: the pet window says so out loud, and the settings section
 * does too. A caller that treated it as a wiring bug would be guessing.
 */
export function createDesktopPetConnection(): PetHostConnection | null {
  if (!hasHost()) return null
  if (cached === null) cached = createTauriPetConnection()
  return cached
}

/**
 * The character window's resolver, as `mountDesktopPet` takes one.
 *
 * The dependency object is built here rather than in the entry because §10.1 makes that the
 * integrator's file and because the entry is a *boot*: it decides whether this page is the pet's,
 * and this decides what the pet talks to.
 *
 * **The platform is the ball's, built the same way and for the same ask.** `createBallPlatform`
 * reads the window the page runs in and calls `startDragging` on it; nothing about it is the
 * orb's, which is why the same call serves both resolvers rather than a second adapter being
 * written here (and why the character window's drag costs one function it already had access to).
 * What differs between the two windows is only the *type* of the dependency each takes — the ball
 * gets a `PetWindowGateway`, this one the wider `PetWindowGateway` plus a lifecycle — and neither
 * of them can reach the `snap` this build does not implement.
 */
export function resolveDesktopPetDependencies(): DesktopPetDependencies | undefined {
  const connection = createDesktopPetConnection()
  return connection ? { connection, platform: createBallPlatform() } : undefined
}

/**
 * The ball window's resolver, as `mountDesktopPetBall` takes one.
 *
 * The same connection object the character window gets, built by the same function: both windows
 * ask the same host the same questions, and a second adapter here would be a second listener per
 * subscription. What differs is only what the *dependency type* lets each window reach — the ball
 * takes `PetWindowGateway`, which has no `open`, `disable` or `closeOwn` on it.
 *
 * The desktop's drag is supplied **only when there is a Tauri host behind the page**: the controls
 * it is built on are window calls, and a browser page has no window to drag. Without one the orb
 * says it cannot be moved, which is true there — the same rule as the connection above, applied to
 * the other thing this window can be without. The character window's resolver below reaches the
 * same platform through the same call, so both of the pet's surfaces are handed a drag by one
 * decision rather than two.
 */
export function resolveDesktopPetBallDependencies():
  | DesktopPetBallDependencies
  | undefined {
  const connection = createDesktopPetConnection()
  return connection ? { connection, platform: createBallPlatform() } : undefined
}

/**
 * Do what a menu item asked for.
 *
 * The dispatch itself lives in the feature (`services/pet-menu-actions.ts`) because it is the
 * pet's policy rather than the app's assembly; this is the composition's single entrance to it,
 * so a component does not have to import the feature directly to route a click.
 */
export async function actOnDesktopPetMenu(
  connection: PetHostConnection,
  action: PetMenuAction,
): Promise<PetMenuOutcome> {
  return actOnPetMenu(connection, action)
}
