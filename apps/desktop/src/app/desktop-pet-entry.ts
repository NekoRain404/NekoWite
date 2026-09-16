/**
 * The pet window's page entry: it starts the pet and nothing else (§7.1).
 *
 * §7.1's requirement is stated as an absence — 「入口只初始化桌宠，不挂载 AppShell、编辑器、整套索引
 * 和 Agent 客户端」 — and an absence is the kind of requirement that fails silently: an entry that
 * imported the app's bootstrap would still look and behave correctly, and would show up as a
 * second vault watcher, a second search index and a second AI client running in a window the user
 * thinks is a decoration. So the graph is asserted rather than intended, in
 * `desktop-pet-entry.test.ts`, which walks every import this file can reach and compares the
 * result with a list somebody chose. That test is what makes "the pet window is not a second
 * application" a fact about the build rather than a claim about the source.
 *
 * What it does import is the pet's own public entry, the composition that decides what the pet
 * talks to, and two stylesheets: the token scale and the palette, in `main.ts`'s order, so the pet
 * follows the host's theme and accent (§1) without carrying the application's component layers. A
 * stylesheet is not an application — the thing §7.1 forbids is the *machinery*, and the graph test
 * draws that line at the module it can see. The composition's own reach is one adapter
 * (`platform/gateways/tauri-pet.ts`, which is `invoke` and `listen`) and the feature's menu
 * actions, and the test lists both with the reason each is there.
 */
import { createApp } from 'vue'
// By path, and deliberately not through `features/desktop-pet/index.ts`: that entry is the
// feature's public API *for other callers* — the settings page mounts `PetCarePanel` through it —
// and reaching it from here would put the whole of it in this window's source graph, the care
// panel and D1's contract values included. §7.1's isolation is the stronger rule for this one
// page, and `DesktopPetRoot.vue` plus the two services below are the whole of what it draws.
import DesktopPetRoot from '../features/desktop-pet/components/DesktopPetRoot.vue'
import type { PetGateway } from '../platform/gateways/pet-contracts'
import { resolveDesktopPetDependencies } from './desktop-pet-composition'
import '../styles/tokens.css'
import '../styles/palettes.css'

/** The element `desktop-pet.html` declares, and the only thing this file looks for in the page. */
export const DESKTOP_PET_ROOT_ID = 'desktop-pet'

/**
 * What the pet window needs from its host.
 *
 * One field today, and a whole object rather than a bare gateway because §9 gives the pet a
 * composition of its own: `desktop-pet-composition.ts` builds it from the feature's public entry
 * and is where the task navigation and the settings entry are assembled (§10.1). This is the seam
 * it hands its work across.
 *
 * It stays optional at the mount site because "no host" is a renderable state rather than a
 * wiring error — see {@link resolveDesktopPetDependencies} below.
 */
export interface DesktopPetDependencies {
  gateway: PetGateway
}

export interface DesktopPetApp {
  /**
   * Unmount the window's app. Synchronous, like Vue's own: the lifecycle releases everything it
   * holds as it goes, and the one thing that is a promise — the host's unsubscribe — is issued
   * before this returns rather than left for a caller to wait on.
   */
  dispose(): void
}

/** How the composition root hands its dependencies over. See {@link resolveDesktopPetDependencies}. */
export type ResolveDesktopPetDependencies = () => DesktopPetDependencies | undefined

/**
 * Mount the pet into a page element, with or without a host connection.
 *
 * Without one the window renders its own state rather than a pet: see `DesktopPetRoot.vue`. That
 * is the same rule §7.2 applies to a capability — an absence is stated — and it is the difference
 * between a window that says "no host" and one that draws a pet whose every task came from a
 * fixture. `resolveDesktopPetDependencies` answers `undefined` in exactly one case — a page with
 * no Tauri host behind it — and deliberately does not fall back to D1's in-memory double.
 */
export function mountDesktopPet(
  host: Element,
  dependencies?: DesktopPetDependencies,
): DesktopPetApp {
  const app = createApp(DesktopPetRoot, { gateway: dependencies?.gateway ?? null })
  app.mount(host)
  return {
    dispose: () => app.unmount(),
  }
}

/**
 * Boot the window if this page is the pet's.
 *
 * Guarded on the mount point rather than on a flag: a module that mounts whenever it is imported
 * cannot be imported by a test, and the guard is also what keeps this file honest about being an
 * entry — the page it is the entry *for* is the thing that decides whether it runs.
 */
export function bootDesktopPet(
  resolve: ResolveDesktopPetDependencies = resolveDesktopPetDependencies,
): DesktopPetApp | null {
  if (typeof document === 'undefined') return null
  const host = document.getElementById(DESKTOP_PET_ROOT_ID)
  if (!host) return null
  return mountDesktopPet(host, resolve())
}

// The page this file is the entry for. Inert anywhere else — including under a test runner, where
// the mount point is not in the document unless a test puts it there.
bootDesktopPet()
