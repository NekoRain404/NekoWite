/**
 * The bubble's theme, from `message.theme` to the one attribute `palettes.css` selects on.
 *
 * **The structure this file decides.** A theme is not a property of a subtree; it is a property of a
 * *page*, because the light palette is the baseline `palettes.css` declares on `:root`
 * (`styles/palettes.css:16-51`) and the dark one is a re-point of it on `[data-theme="dark"]`
 * (`:53-92`). `:root` **is** the html element, so both selectors match the page's own root, and
 * `data-theme` on that element is exactly the switch the table is written for — which is why the
 * app's own shell carries the same three attributes on the element it is the root of
 * (`app/AppShell.vue:207-210`).
 *
 * That is also why no second light block is needed and none is added. A `data-theme="light"` on an
 * *element inside* a dark page would indeed need a duplicate of the light table — nothing in
 * `palettes.css` re-declares the light tokens under a `[data-theme="light"]` selector, and the one
 * place that name appears (`:162`) is the high-contrast rule, which reads the attribute as "not
 * dark" rather than as a palette of its own. The pet window is not inside the app's page: it is a
 * page of its own (`desktop-pet.html`, `app/desktop-pet-entry.ts`) whose root is this element. So
 * the light theme is the palette the page already has, and the dark one is the re-point the table
 * already carries — the app's own colours, in both cases, and no colour invented here.
 *
 * **What `system` means here, and what it does not.** The two forced members are the local override
 * the ledger keeps for this key (`desktop-pet-port-ledger.md:112`, 「默认跟随宿主主题；保留明确的局部
 * 覆盖」). `system` is the default, and what a page of its own can observe for it is the *engine's*
 * own preference — the same signal the app's store resolves its own `system` theme from
 * (`stores/appearance.ts:109-116`), read from the same engine in the same process. It is therefore
 * the app's theme on a default install, whose theme setting is `system`
 * (`stores/appearance-schema.ts:66`), and it can differ from the app on one where the user pinned
 * the app to light or dark: the app's theme lives in that window's store, §7.1 forbids this page
 * from reaching it, and `app/desktop-pet-entry.test.ts` fails on a graph that does. The one channel
 * that could carry it is the host's own appearance read — this file's input — so closing that
 * difference is a change to what the *app* publishes, not to this page.
 *
 * Nothing here draws. The colours are `palettes.css`'s, the attribute is `data-theme`, and this
 * module's whole job is the two decisions between them: which member is meant, and what the third
 * one resolves to.
 */

/**
 * The theme a page is drawn in. Two members, because `palettes.css` has two.
 *
 * Deliberately not the schema's three: `system` names a *rule* for choosing between these two, and
 * a value that reached a stylesheet as `system` would be a `data-theme` attribute no selector
 * matches — the page would fall back to `:root` and call the result a setting that worked.
 */
export type PetPageTheme = 'light' | 'dark'

/**
 * What `message.theme` may hold, as the schema spells it.
 *
 * A copy of `PetSettingsValues['message']['theme']`'s members rather than an import of it: the
 * pet's window carries `pet-contracts`, and the settings schema is the *page's* vocabulary — the
 * two are deliberately different sides of §9's one-truth line, and this is the side that decides
 * what a page may be told. `pet-bubble-theme.test.ts` pins the members against the schema, so the
 * copy cannot drift.
 */
export const PET_BUBBLE_THEMES = ['system', 'light', 'dark'] as const
export type PetBubbleTheme = (typeof PET_BUBBLE_THEMES)[number]

/**
 * The engine's colour-scheme query, as this module reads it: `matches`, and the change event.
 *
 * Written out rather than taken from `lib.dom`'s `MediaQueryList` because the declaration is the
 * *contract* — a caller may hand this a page's `window` or a double, and a double is what a test
 * has. `addEventListener` is optional for the same reason: `stores/appearance.ts` reads the same
 * query's `matches` and nothing else, and a caller that can only answer that is still a caller
 * this module works with.
 */
export interface PetThemeQuery {
  readonly matches: boolean
  addEventListener?(type: 'change', handler: () => void): void
  removeEventListener?(type: 'change', handler: () => void): void
}

/** What this module needs of an engine: the one query, and nothing else. */
export interface PetThemeEngine {
  matchMedia(query: string): PetThemeQuery
}

/**
 * The theme a read carries, or the schema's default where it carries none.
 *
 * Absent and unrecognised are read the same way, for the reason `petBubbleOpacityOf` gives: the
 * host sends a member (Rust's `BubbleMessage` is on every arm), so what reaches the second arm is
 * an answer that did not come from this host — a double, or a build from before the field existed
 * — and `system` is what this build's bubble was drawn with. Reading it as `light` would pin a
 * theme the user never chose, and reading it as `dark` would invent one.
 */
export function petBubbleThemeOf(read: { theme?: unknown } | Record<string, unknown>): PetBubbleTheme {
  const raw = read.theme
  return typeof raw === 'string' && (PET_BUBBLE_THEMES as readonly string[]).includes(raw)
    ? (raw as PetBubbleTheme)
    : 'system'
}

/**
 * The palette a page is drawn in, given the setting and one reading of the engine's preference.
 *
 * `prefersDark` is a parameter rather than a `matchMedia` call inside: what the engine says is a
 * reading, and this is the rule about what the *user* asked for — the two are different questions
 * and a function that answered both would be untestable against the second.
 */
export function resolvePetPageTheme(theme: PetBubbleTheme, prefersDark: boolean): PetPageTheme {
  if (theme === 'light') return 'light'
  if (theme === 'dark') return 'dark'
  return prefersDark ? 'dark' : 'light'
}

/**
 * The attribute `palettes.css` selects a palette on, on the element that is `:root` for the page.
 *
 * `data-theme` and nothing else. `data-accent`, `data-color-scheme` and `data-contrast` are the
 * app's other three appearance axes and this window has never carried them; the bubble's theme is
 * the one of the four the user sets *for the pet*, and a page that started speaking for the other
 * three would be deciding the app's appearance from a decoration. The accent matters most of the
 * three: `--app-accent` is read by the bubble's hover and by the rows' dots, so the window draws
 * the accent `palettes.css` falls back to rather than the user's — a deviation from §1's 「跟随宿主
 * 主题与强调色」 that predates this file and is filed beside it in the port report.
 *
 * Later wins for the same element, and removing the attribute is the light arm: `:root` is where the
 * light palette is declared, so "no attribute" and "light" are the same drawing (see the header).
 */
export function applyPetPageTheme(root: HTMLElement, theme: PetPageTheme): void {
  if (theme === 'light') delete root.dataset.theme
  else root.dataset.theme = theme
}

/**
 * Whether the engine says the system prefers dark.
 *
 * Absent `matchMedia` is a real state in this project's test environment rather than a
 * hypothetical (`PetSettingsPreview.vue:93-97` reads the same call behind the same guard), and it
 * is read as "no preference stated", which is the light arm everywhere else in the app
 * (`stores/appearance.ts:114`).
 */
export function prefersDarkScheme(view: PetThemeEngine | undefined): boolean {
  if (!view || typeof view.matchMedia !== 'function') return false
  return view.matchMedia('(prefers-color-scheme: dark)').matches
}
