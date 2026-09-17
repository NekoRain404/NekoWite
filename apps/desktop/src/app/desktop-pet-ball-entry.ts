/**
 * The ball window's page entry: it mounts the orb and nothing else.
 *
 * The second light entry, and the same rule §7.1 states for the first one — 「入口只初始化桌宠，不挂
 * 载 AppShell、编辑器、整套索引和 Agent 客户端」. What it mounts is `PetBallWindow.vue`, whose own
 * graph is the orb, the sprite behind it and the appearance read; the character window's root, its
 * bubble, its task list and `usePetClickThrough` are not in it, which is the point. The ball is the
 * surface that must *not* be click-through, and the cheapest way to keep a composable out of a
 * window is for nothing in that window to import it — `desktop-pet-ball-entry.test.ts` walks every
 * import this file can reach and fails on that one by name.
 *
 * Two stylesheets, in `main.ts`'s order, for the reason `desktop-pet-entry.ts` gives: the token
 * scale and the palette, so the orb follows the host's theme (§1) without carrying the
 * application's component layers. `desktop-pet-ball.html` carries no stylesheet of its own; the
 * transparency rule is `PetBallWindow.vue`'s.
 */
import { createApp } from 'vue'
import type { PetWindowGateway } from '../platform/gateways/pet-contracts'
import type { SpriteClock } from '../features/desktop-pet/rendering/animation-bindings'
import type { ImageFactory } from '../features/desktop-pet/rendering/sprite-sheet'
import type { PetBallPlatform } from '../features/desktop-pet/services/pet-ball-input'
// By path, and deliberately not through `features/desktop-pet/index.ts`: that entry is the
// feature's public API for *other* callers (the settings page mounts `PetCarePanel` through it),
// and reaching it from here would put the care surface in this window's source graph. §7.1's
// isolation is the stronger rule for a window that draws one orb.
import PetBallWindow from '../features/desktop-pet/components/PetBallWindow.vue'
import { resolveDesktopPetBallDependencies } from './desktop-pet-composition'
import '../styles/tokens.css'
import '../styles/palettes.css'

/** The element `desktop-pet-ball.html` declares, and the only thing this file looks for. */
export const DESKTOP_PET_BALL_ROOT_ID = 'desktop-pet-ball'

/**
 * What the ball window needs from its host.
 *
 * One field, and it is the *window's* contract rather than the composition's wider object: the orb
 * reads `appearance`, listens for a settings write, and asks for the settings page on a
 * right-click. It cannot open, disable or close a window, and it holds no teardown — the entry is
 * the page, and a page that could tear the pet down would be a surface §4's rollback does not have.
 */
export interface DesktopPetBallDependencies {
  connection: PetWindowGateway
  /**
   * The desktop's drag and snap, when this build has one.
   *
   * Nothing supplies it today: the pet's capability holds no window-movement permission and there
   * is no snap command, so the orb states that it cannot be moved rather than offering a drag that
   * does nothing (§7.2). It is a parameter so that the window which gives the ball its drag passes
   * it here rather than through a second entry.
   */
  platform?: PetBallPlatform | null
  /**
   * The sprite's resources, injected (§10.2's 注入……资源 rule), exactly as the character entry
   * takes them: a test cannot decode a PNG, so the loader is a parameter, and the product passes
   * nothing so the browser's own `Image`, timers and canvas are the ones the window uses.
   */
  sprite?: {
    clock?: SpriteClock
    createImage?: ImageFactory
  }
}

export interface DesktopPetBallApp {
  /** Unmount the window's app. Synchronous, like Vue's own. */
  dispose(): void
}

/** How the composition root hands its dependencies over. */
export type ResolveDesktopPetBallDependencies = () => DesktopPetBallDependencies | undefined

/**
 * Mount the orb into a page element, with or without a host connection.
 *
 * Without one the orb draws upstream's plain ball rather than a pet: no connection means no
 * appearance to read, and `resolveDesktopPetBallDependencies` answers `undefined` in exactly one
 * case — a page with no Tauri host behind it — and deliberately does not fall back to D1's
 * in-memory double. A ball on a fixture would be indistinguishable from a ball on a desktop, which
 * is the mistake `desktop-pet-composition.ts` refuses for the character window.
 */
export function mountDesktopPetBall(
  host: Element,
  dependencies?: DesktopPetBallDependencies,
): DesktopPetBallApp {
  const connection = dependencies?.connection ?? null
  const sprite = dependencies?.sprite ?? {}
  const app = createApp(PetBallWindow, {
    connection,
    platform: dependencies?.platform ?? null,
    ...sprite,
  })
  app.mount(host)
  return {
    dispose: () => app.unmount(),
  }
}

/**
 * Boot the window if this page is the ball's.
 *
 * Guarded on the mount point rather than on a flag, the same way `bootDesktopPet` is: a module
 * that mounts whenever it is imported cannot be imported by a test.
 */
export function bootDesktopPetBall(
  resolve: ResolveDesktopPetBallDependencies = resolveDesktopPetBallDependencies,
): DesktopPetBallApp | null {
  if (typeof document === 'undefined') return null
  const host = document.getElementById(DESKTOP_PET_BALL_ROOT_ID)
  if (!host) return null
  return mountDesktopPetBall(host, resolve())
}

// The page this file is the entry for. Inert anywhere else — including under a test runner, where
// the mount point is not in the document unless a test puts it there.
bootDesktopPetBall()
