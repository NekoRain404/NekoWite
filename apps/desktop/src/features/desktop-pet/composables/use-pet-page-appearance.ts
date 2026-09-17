/**
 * The pet window's page, drawn in the appearance the user chose — and kept drawn in it.
 *
 * `pet-page-appearance.ts` decides *what* the page's root carries and how each value is read;
 * `pet-bubble-theme.ts` decides *which* palette the two theme settings come to. This is the
 * lifetime around both, and there are exactly three things in that lifetime worth naming:
 *
 *  - **It is applied to the page's root, and to the document's.** The pet window is a page of its
 *    own, so its root is `document.documentElement` — the element `:root` and every attribute
 *    selector in `palettes.css` match. The root is a parameter so a test can watch an element it
 *    owns instead of the test runner's document.
 *  - **It follows both inputs, and only listens when the engine can still move the page.** The
 *    appearance arrives from the host (the app publishes it, the host relays it, `usePetWindow`
 *    reads it) and the bubble's theme is a setting; the two together decide the palette, and the
 *    engine's own preference is the answer only while *both* of them are `system`. The listener is
 *    registered for exactly those states, because a page that has been told `dark` — by either
 *    setting — has nothing to hear.
 *  - **It is given back on the way out.** Every attribute and the property are put where they were
 *    found, so a window that unmounts leaves its page as it found it — the same rule the composables
 *    beside this one follow for the pointer region and the drawing scope, and the reason a test that
 *    mounts a window does not colour or resize the next test in the file.
 *
 * The injected `view` is §10.2's resource seam: a test cannot make an engine report a dark
 * preference, and a rule about what the *user asked for* has to be measurable apart from what the
 * *engine says*.
 */
import { onScopeDispose, ref, watch, type Ref } from 'vue'
import {
  resolvePetPageTheme,
  type PetBubbleTheme,
  type PetPageTheme,
  type PetThemeEngine,
} from '../services/pet-bubble-theme'
import {
  petPageAttributesOf,
  readPetPageAttributes,
  writePetPageAttributes,
  type PetPageAppearance,
} from '../services/pet-page-appearance'

export interface PetPageAppearanceOptions {
  /** The bubble's own theme setting (`message.theme`), which overrides the app's when it is not `system`. */
  theme: () => PetBubbleTheme
  /** The app's appearance, as the host last answered it — see `PetPageAppearance`. */
  host: () => PetPageAppearance
  /** The element the page's appearance is selected on. Defaults to the document's root element. */
  root?: () => HTMLElement | null
  /** The engine, injected for tests (§10.2). Defaults to the page's own `window`. */
  view?: PetThemeEngine | null
}

export interface PetPageAppearanceReader {
  /** The palette the page is currently drawn in, recomputed when either setting or the engine moves. */
  readonly resolved: Ref<PetPageTheme>
}

export function usePetPageAppearance(
  options: PetPageAppearanceOptions,
): PetPageAppearanceReader {
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
  // theme, an accent or a body size behind on a document it is about to stop owning.
  const found = root() ? readPetPageAttributes(root() as HTMLElement) : null
  /** True while the listener below is attached, so it is added and removed at most once each. */
  let listening = false
  let disposed = false

  const resolved = ref<PetPageTheme>('light')

  function apply(): void {
    if (disposed) return
    const host = options.host()
    // The rule first, the element second: `resolved` is the *settings'* answer — what the two
    // choices come to on this engine — and a page with no root to write it to does not change that
    // answer, it only has nowhere to draw it.
    resolved.value = resolvePetPageTheme(options.theme(), Boolean(query?.matches), host.theme)
    const element = root()
    if (element) writePetPageAttributes(element, petPageAttributesOf(host, resolved.value))
  }

  /**
   * Whether the engine can still move the page: only while neither setting has pinned a palette.
   *
   * Read from the options rather than from `resolved`, because the question is about *inputs*: a
   * page that resolves to dark today because the engine says so may still have to follow it back.
   */
  function engineDecides(): boolean {
    return options.theme() === 'system' && options.host().theme === 'system'
  }

  /**
   * The engine moved. `apply()` reads the query again rather than trusting the event's payload:
   * `matches` is the same fact the change is about, and a handler that took the event's own value
   * would be a second reading of one state.
   */
  function onEngineTheme(): void {
    if (engineDecides()) apply()
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
    () => [options.theme(), options.host()] as const,
    () => {
      listen(engineDecides())
      apply()
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    disposed = true
    listen(false)
    const element = root()
    if (!element || !found) return
    writePetPageAttributes(element, found)
  })

  return { resolved }
}
