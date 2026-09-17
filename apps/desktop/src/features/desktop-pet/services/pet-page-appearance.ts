/**
 * The pet window's page, drawn in the appearance the user chose in the app.
 *
 * **The problem this file solves, stated as the shapes it has to join.** The window is a page of
 * its own (§7.1): it may not read the app's store (`app/desktop-pet-entry.test.ts` fails on a graph
 * that reaches `stores/`), so the only thing it can know is what the host answers — and the host is
 * the app's own window, which publishes what it is drawing. What arrives is four axes and a size:
 * `theme` (`system`/`light`/`dark`), `colorScheme`, `accent`, `highContrast`, `bodyFontSize`.
 *
 * **Why they are attributes and not colours.** `palettes.css` is one table selected by attributes:
 * `data-theme` picks the light or dark baseline, `[data-color-scheme=…]` re-points the surfaces,
 * `[data-accent=…]` re-points the accent, `[data-contrast="high"]` overrides both where the user
 * asked for it — and the app's own shell puts exactly those four on its root
 * (`app/AppShell.vue:207-210`) plus `--app-body-size` as an inline property (`:195`). The pet
 * window's root is `document.documentElement`, so the same four attributes and the same property on
 * *that* element is the same drawing: the numbers do not cross the wire, the *selection* does. That
 * is also what keeps this file out of the business `features/desktop-pet-settings`'s preview had to
 * do — the preview is an element *inside* another page's root, which is why it names its theme
 * rather than omitting it (see `PetSettingsPreview.vue`).
 *
 * **Light is written, not omitted.** The theme work spelled light as the absence of the attribute,
 * because nothing re-declared the light tokens on an element and `:root` is where they live. This
 * window is a second page drawing the same table as the app's own, and the app always writes one of
 * the two names — so leaving it off would be a second spelling of one state, and it would break the
 * one selector that reads the attribute as a *value*: the light high-contrast block
 * (`[data-theme="light"][data-color-scheme][data-contrast="high"]`, `palettes.css:162`) would match
 * in the app's window and not in the pet's, for the same settings.
 *
 * **What a read that carries nothing means.** A double, a browser build, or a host from before this
 * field existed all answer without it, and the arm they take is the *app's own* defaults — the
 * values `stores/appearance-schema.ts` declares for a fresh install. Not a fourth opinion: on a
 * fresh install the app draws `system`, the `default` scheme, the `ink` accent, `normal` contrast
 * and 15px in its own window, and a pet window that drew something else for "the app has not said
 * yet" would be the one surface in this application that is not the app's appearance.
 *
 * Nothing here draws and nothing here reads: the attributes are written onto an element, the sizes
 * are numbers, and which palette a name resolves to is `palettes.css`'s answer.
 */
import type { PetBubbleTheme } from './pet-bubble-theme'

/**
 * What the app's appearance is, as this window is told it.
 *
 * `theme`'s members are the schema's three (`stores/appearance-schema.ts`'s `Theme`), which are
 * also `message.theme`'s three — see `pet-bubble-theme.ts`'s {@link PetBubbleTheme}, which this
 * reuses rather than restating: the same three words decide the same two palettes, and a second
 * type would be a second place for a fourth to appear.
 *
 * `colorScheme` and `accent` are **names** and deliberately not a table of members. The names are
 * `palettes.css`'s, both pages load that stylesheet, and a name no rule matches draws the axis's
 * own default in either of them — so the two windows agree about a member this build has never
 * heard of (one from a newer build, say) without this side carrying a second copy of the palette's
 * index. What is refused is a value that is not a name at all: see {@link petHostAppearanceOf}.
 */
export interface PetPageAppearance {
  /** The app's theme *setting*. `system` is resolved against the engine by whoever draws. */
  theme: PetBubbleTheme
  /** `palettes.css`'s colour-scheme member (`default`, `sunset`, …). */
  colorScheme: string
  /** `palettes.css`'s accent member (`ink`, `coral`, …). */
  accent: string
  /** `data-contrast="high"`, the accessibility axis, which wins over a scheme by specificity. */
  highContrast: boolean
  /** The app's body size in CSS pixels (`AppShell.vue`'s `--app-body-size`). */
  bodyFontSize: number
}

/**
 * The range the app's own body-size control holds the setting to, and the fallback for a value
 * outside it.
 *
 * `stores/appearance.ts`'s `setBodyFontSize` is the control's rule (`Math.min(20, Math.max(12, …))`)
 * and this is the same range, kept in step by a test that drives the real setter rather than by a
 * comment. A window that drew text at a size the app could not have stored would be the second
 * answer §5.3 forbids, in the one dimension nobody would think to check a decoration for.
 */
export const PET_PAGE_BODY_SIZE = { min: 12, max: 20, fallback: 15 } as const

/**
 * The appearance of an app that has not published one: the schema's own defaults.
 *
 * Written out rather than imported for the reason {@link PetHostTheme} gives, and pinned against
 * `APPEARANCE_DEFAULTS` by the test beside this file — so a default that moved in the store and not
 * here fails rather than silently drawing the pet in last year's appearance.
 */
export const PET_PAGE_APPEARANCE_DEFAULTS: PetPageAppearance = {
  theme: 'system',
  colorScheme: 'default',
  accent: 'ink',
  highContrast: false,
  bodyFontSize: PET_PAGE_BODY_SIZE.fallback,
}

/**
 * The app's appearance a read carries, or the app's defaults where it carries none.
 *
 * Field by field, and each field's own rule:
 *
 *  - **`theme`** is one of the three members or the default. A word nothing recognises is not a
 *    theme — `system` is the rule for choosing between the two palettes, and a fourth word would
 *    reach `data-theme` as a name no selector matches, which draws the light baseline and calls it a
 *    setting that worked.
 *  - **`colorScheme` and `accent`** are read as names: a string that is not empty is one, whatever
 *    it says, because the stylesheet is what decides whether a name means anything. Not a string at
 *    all is the default, which is also the honest reading of a value that never came from the app's
 *    own store.
 *  - **`highContrast`** is a switch: only an explicit `true` turns it on, and everything else is the
 *    off state the schema declares. Reading an unrecognised value as *on* would invent an
 *    accessibility override, which is the one direction that must never be guessed.
 *  - **`bodyFontSize`** goes through {@link PET_PAGE_BODY_SIZE}, like every other number that
 *    crosses a wire in this feature (`petBubbleOpacityOf`, `petBallSizeOf`).
 *
 * Absent and unrecognised are read the same way throughout, for the reason those two readers give:
 * the host sends a member on every arm, so what reaches the second arm is an answer that did not
 * come from this host.
 */
export function petHostAppearanceOf(read: {
  theme?: unknown
  colorScheme?: unknown
  accent?: unknown
  highContrast?: unknown
  bodyFontSize?: unknown
}): PetPageAppearance {
  const theme = read.theme
  return {
    theme:
      theme === 'light' || theme === 'dark' || theme === 'system'
        ? theme
        : PET_PAGE_APPEARANCE_DEFAULTS.theme,
    colorScheme: petPaletteName(read.colorScheme, PET_PAGE_APPEARANCE_DEFAULTS.colorScheme),
    accent: petPaletteName(read.accent, PET_PAGE_APPEARANCE_DEFAULTS.accent),
    highContrast: read.highContrast === true,
    bodyFontSize: petBodySizeOf(read.bodyFontSize),
  }
}

/**
 * The body size a read carries, held to the app's own range.
 *
 * `PET_PAGE_BODY_SIZE` is the rule and this is where it is applied once, so the window cannot draw
 * a size the app's control could not have produced: out of range is clamped the way the setter
 * clamps it, and anything that is not a finite number is the schema's default rather than a guess.
 * A fraction is kept — the app's font sizes are the user's and a stylesheet may hold one — which is
 * the one difference from `petBubbleFontSizeOf`, whose three buttons are whole numbers.
 */
export function petBodySizeOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return PET_PAGE_BODY_SIZE.fallback
  }
  return Math.min(PET_PAGE_BODY_SIZE.max, Math.max(PET_PAGE_BODY_SIZE.min, value))
}

/** A palette member as a name, or the default where the read carries nothing a name can be made of. */
function petPaletteName(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/**
 * The attributes and the one property the page root carries, as `AppShell.vue` spells them.
 *
 * `theme` and `contrast` are always one of their two names and never omitted — see this file's
 * header for the light half of that. The record's `null` arms exist for *restoring*: what the
 * element carried before this window wrote to it, which for a page that never carried a theme is
 * nothing at all.
 */
export interface PetPageAttributes {
  /** `data-theme`: `light` or `dark`, the resolved palette and never the word `system`. */
  theme: string | null
  /** `data-color-scheme`: the scheme's member name. */
  colorScheme: string | null
  /** `data-accent`: the accent's member name. */
  accent: string | null
  /** `data-contrast`: `high` or `normal`, which is how the shell spells the same switch. */
  contrast: string | null
  /** The inline `--app-body-size`, as a CSS length. */
  bodySize: string | null
}

/**
 * The attributes for one appearance and one resolved palette.
 *
 * `theme` is a parameter rather than a field of the appearance because it is *not* the app's alone:
 * `message.theme` overrides it (`system` follows the app, the other two members pin a palette), and
 * that resolution is `pet-bubble-theme.ts`'s `resolvePetPageTheme` — the one place the three-member
 * setting becomes one of the two palettes. This function's whole job is the spelling.
 */
export function petPageAttributesOf(
  appearance: PetPageAppearance,
  theme: 'light' | 'dark',
): PetPageAttributes {
  return {
    theme,
    colorScheme: appearance.colorScheme,
    accent: appearance.accent,
    contrast: appearance.highContrast ? 'high' : 'normal',
    bodySize: `${appearance.bodyFontSize}px`,
  }
}

/**
 * What the element carries now, in the shape {@link writePetPageAttributes} writes.
 *
 * The pair is the lifetime: a window saves this before it draws and puts it back on the way out, so
 * a page that already had an appearance is left with the one it had rather than with a blank. Read
 * through `dataset` and the inline style, because those are the two places the attributes and the
 * property live — an attribute written on the element itself, and a property that has to win over
 * `tokens.css`'s declaration (`:191`), which is exactly why the shell sets it inline too.
 */
export function readPetPageAttributes(root: HTMLElement): PetPageAttributes {
  return {
    theme: root.dataset.theme ?? null,
    colorScheme: root.dataset.colorScheme ?? null,
    accent: root.dataset.accent ?? null,
    contrast: root.dataset.contrast ?? null,
    bodySize: root.style.getPropertyValue('--app-body-size') || null,
  }
}

/**
 * Write the record onto the element, or take back what it says is absent.
 *
 * A `null` removes: the attribute is deleted and the property is removed, so a record read from a
 * bare page puts a bare page back rather than writing `undefined` into an attribute (which would
 * leave `data-theme="undefined"` — a name no selector matches, on a page that looks like it has a
 * theme).
 */
export function writePetPageAttributes(root: HTMLElement, attributes: PetPageAttributes): void {
  writeDataset(root, 'theme', attributes.theme)
  writeDataset(root, 'colorScheme', attributes.colorScheme)
  writeDataset(root, 'accent', attributes.accent)
  writeDataset(root, 'contrast', attributes.contrast)
  if (attributes.bodySize === null) root.style.removeProperty('--app-body-size')
  else root.style.setProperty('--app-body-size', attributes.bodySize)
}

/** One attribute: written when it has a value, removed when the record says the page has none. */
function writeDataset(root: HTMLElement, key: keyof DOMStringMap, value: string | null): void {
  if (value === null) delete root.dataset[key]
  else root.dataset[key] = value
}
