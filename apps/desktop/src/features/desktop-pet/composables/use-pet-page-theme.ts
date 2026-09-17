/**
 * The pet window's page, told which palette to draw in — and kept told.
 *
 * `pet-bubble-theme.ts` decides *which* theme and *how* it is spelled on the element; this is the
 * lifetime around it, and there are exactly three things in that lifetime worth naming:
 *
 *  - **It is applied to the page's root, and to the document's.** The pet window is a page of its
 *    own, so its root is `document.documentElement` — the element `:root` and `[data-theme="dark"]`
 *    both match (`styles/palettes.css`), and the reason a theme can be switched at all without a
 *    second palette table. The root is a parameter so a test can watch an element it owns instead
 *    of the test runner's document.
 *  - **A `system` theme keeps being read.** The engine's preference is not a constant: a user who
 *    flips their desktop theme expects the windows on it to follow, and the app's own store
 *    re-reads the same media query for the same reason (`app/app-lifecycle.ts:259-263`). The
 *    listener is registered only while the setting is `system`, because a page that has been told
 *    `light` has nothing to hear.
 *  - **It is given back on the way out.** The attribute is put where it was found, so a window that
 *    unmounts leaves its page as it found it — the same rule the composables beside this one follow
 *    for the pointer region and the drawing scope, and the reason a test that mounts a window does
 *    not colour the next test in the file.
 *
 * The injected `view` is §10.2's resource seam: a test cannot make an engine report a dark
 * preference, and a rule about what the *user asked for* has to be measurable apart from what the
 * *engine says*.
 */
import { onScopeDispose, ref, watch, type Ref } from 'vue'
import {
  applyPetPageTheme,
  resolvePetPageTheme,
  type PetBubbleTheme,
  type PetPageTheme,
  type PetThemeEngine,
} from '../services/pet-bubble-theme'

export interface PetPageThemeOptions {
  /** The setting, as the window last read the host's answer. */
  theme: () => PetBubbleTheme
  /** The element the page's palette is selected on. Defaults to the document's root element. */
  root?: () => HTMLElement | null
  /** The engine, injected for tests (§10.2). Defaults to the page's own `window`. */
  view?: PetThemeEngine | null
}

export interface PetPageThemeReader {
  /** The palette the page is currently drawn in, recomputed when the setting or the engine moves. */
  readonly resolved: Ref<PetPageTheme>
}

export function usePetPageTheme(options: PetPageThemeOptions): PetPageThemeReader {
  const root =
    options.root ?? (() => (typeof document === 'undefined' ? null : document.documentElement))
  const view =
    options.view === undefined
      ? typeof window === 'undefined'
        ? null
        : (window as PetThemeEngine)
      : options.view
  const query =
    view && typeof view.matchMedia === 'function'
      ? view.matchMedia('(prefers-color-scheme: dark)')
      : null

  // Kept so the page can be given back exactly as it was: a window that unmounts must not leave a
  // theme behind on a document it is about to stop owning.
  const found = root()?.dataset.theme
  /** True while the listener below is attached, so it is added and removed at most once each. */
  let listening = false
  let disposed = false

  const resolved = ref<PetPageTheme>('light')

  function apply(): void {
    if (disposed) return
    // The rule first, the element second: `resolved` is the *setting's* answer — what the user's
    // choice comes to on this engine — and a page with no root to write it to does not change that
    // answer, it only has nowhere to draw it.
    resolved.value = resolvePetPageTheme(options.theme(), Boolean(query?.matches))
    const element = root()
    if (element) applyPetPageTheme(element, resolved.value)
  }

  /**
   * The engine moved. `apply()` reads the query again rather than trusting the event's payload:
   * `matches` is the same fact the change is about, and a handler that took the event's own value
   * would be a second reading of one state.
   */
  function onEngineTheme(): void {
    if (options.theme() === 'system') apply()
  }

  function listen(wanted: boolean): void {
    if (!query || wanted === listening) return
    listening = wanted
    // `addEventListener` on a `MediaQueryList` is the modern half of the API
    // (`stores/appearance.ts` reads `matches`; `app/app-lifecycle.ts:259` registers the change). A
    // test double that carries `matches` and no listener still gets the rule right — it simply
    // never hears a change it cannot have.
    if (wanted) query.addEventListener?.('change', onEngineTheme)
    else query.removeEventListener?.('change', onEngineTheme)
  }

  watch(
    () => options.theme(),
    (theme) => {
      listen(theme === 'system')
      apply()
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    disposed = true
    listen(false)
    const element = root()
    if (!element) return
    if (found === undefined) delete element.dataset.theme
    else element.dataset.theme = found
  })

  return { resolved }
}
