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
 * What it does import is two stylesheets and no runtime: the token scale and the palette, in
 * `main.ts`'s order, so the pet follows the host's theme and accent (§1) without carrying the
 * application's component layers. A stylesheet is not an application — the thing §7.1 forbids is
 * the *machinery*, and the graph test draws that line at the module it can see.
 */
import { createApp } from 'vue'
import DesktopPetRoot from '../features/desktop-pet/components/DesktopPetRoot.vue'
import type { PetGateway } from '../platform/gateways/pet-contracts'
import '../styles/tokens.css'
import '../styles/palettes.css'

/** The element `desktop-pet.html` declares, and the only thing this file looks for in the page. */
export const DESKTOP_PET_ROOT_ID = 'desktop-pet'

/**
 * What the pet window needs from its host.
 *
 * One field today, and a whole object rather than a bare gateway because §9 gives the pet a
 * composition of its own: `desktop-pet-composition.ts` is where the gateway, the task navigation
 * and the settings entry are assembled from `features/desktop-pet/index.ts`'s public surface, and
 * it is the integrator's file (§10.1). This is the seam it hands its work across.
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
 * is the same rule §7.2 applies to a capability — an absence is stated — and it is what makes
 * "the composition has not landed yet" visible instead of indistinguishable from a working pet.
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

/**
 * The pet's host connection, from the composition root this task stops at.
 *
 * §10.1 makes `S/app/desktop-pet-composition.ts` the integrator's, and the honest form of "not
 * wired yet" is not a gateway backed by something that is not the host: it is no gateway, which
 * the root renders as a stated absence. A `createMemoryPetGateway()` here would make the window
 * look finished while every task in it came from a fixture, which is the failure mode §7.1's
 * isolation clause exists to prevent.
 *
 * Landing the composition is one line — `return { gateway: createDesktopPetGateway() }` — and
 * `desktop-pet-entry.test.ts` asserts that this function's answer is still "no gateway", so the
 * day it lands the test fails and has to be rewritten to say which gateway arrived and from
 * where. That is deliberate: the assertion is about the absence, and an absence that stops being
 * true should be loud rather than discovered later in a window that quietly started talking to
 * something else.
 */
function resolveDesktopPetDependencies(): DesktopPetDependencies | undefined {
  return undefined
}

// The page this file is the entry for. Inert anywhere else — including under a test runner, where
// the mount point is not in the document unless a test puts it there.
bootDesktopPet()
