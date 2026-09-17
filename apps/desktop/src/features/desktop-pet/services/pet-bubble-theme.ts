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
 * A theme *can* be selected on an element inside a page, and that is what the light block's second
 * selector is for: `:root, [data-theme="light"]` declares the same table twice, once for the page
 * and once for a subtree that has to draw a palette the page around it is not drawing. The settings
 * page's preview is that subtree — an element inside the app's own root, showing the bubble in a
 * theme the app may not be in (`features/desktop-pet-settings/components/PetSettingsPreview.vue`) —
 * and it carries the four attributes exactly as this window's root does, which is what makes the
 * two draw the same numbers rather than two tables that happen to agree today.
 *
 * **What `system` means here.** The two forced members are the local override the ledger keeps for
 * this key (`desktop-pet-port-ledger.md:112`, 「默认跟随宿主主题；保留明确的局部覆盖」), and `system`
 * is 「跟随宿主主题」 — the *host's* theme, which is now an answer this window is given rather than
 * one it infers. The app publishes its own appearance (`app/pet-host-appearance-link.ts`,
 * `desktop_pet::host_appearance`), the page reads it (`pet-page-appearance.ts`), and this function
 * is the rule that puts the two settings together: the bubble's member wins when the user pinned
 * one, the app's decides otherwise, and the engine's own preference is the answer only when both are
 * following it — the same `matchMedia` the app's store resolves its own `system` from
 * (`stores/appearance.ts:109-116`). Nothing here reaches the app's store: §7.1 forbids it,
 * `app/desktop-pet-entry.test.ts` fails on a graph that does, and this is the channel that carries
 * the answer instead.
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
 * What `message.theme` may hold, as the schema spells it — and what the app's own theme holds too.
 *
 * One type for two settings, because the two are one decision: the app's `appearance.theme` and the
 * pet's `message.theme` are the same three members of the same `theme` vocabulary
 * (`stores/appearance-schema.ts` declares the app's), and the rule below resolves one against the
 * other. A second three-member type would be a second place for a fourth to appear, and the two
 * would then disagree about a value that means the same thing on both sides of the window boundary.
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
 * The palette a page is drawn in, given the setting, one reading of the engine's preference, and
 * the theme the *app* is drawing in.
 *
 * Three inputs and one rule, because the setting's third member is a rule about whose choice wins:
 *
 *  - the bubble's own member, when the user pinned one for the pet — §5.2's 「保留明确的局部覆盖」;
 *  - otherwise **the app's theme**, which is what 「默认跟随宿主主题」 is short for. It is a
 *    setting with the same three members, so it decides before the engine does: an app the user
 *    pinned to light is an app the pet follows into light, whatever the desktop prefers;
 *  - and the engine's own preference only when *both* are following it, which is the signal
 *    `stores/appearance.ts:109-116` resolves the app's own `system` from — read from the same
 *    engine, in the same process, so the two windows agree about what the desktop prefers.
 *
 * `prefersDark` and `hostTheme` are parameters rather than a `matchMedia` call and a read inside:
 * what the engine says is a reading and what the app chose is an answer from another window, and
 * this is the rule about what the *user* asked for — a function that answered all three questions
 * would be untestable against any two of them.
 */
export function resolvePetPageTheme(
  theme: PetBubbleTheme,
  prefersDark: boolean,
  hostTheme: PetBubbleTheme,
): PetPageTheme {
  if (theme === 'light') return 'light'
  if (theme === 'dark') return 'dark'
  if (hostTheme === 'light') return 'light'
  if (hostTheme === 'dark') return 'dark'
  return prefersDark ? 'dark' : 'light'
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
