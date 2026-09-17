/**
 * The bubble's theme, from `message.theme` to the attribute `palettes.css` selects the palette on.
 *
 * What this file pins is the *structure* the defect turned on. The light palette is declared on
 * `:root` and the dark one re-points it on `[data-theme="dark"]`, so a page's own root is the
 * element both selectors match — and the theme has to be resolved to **one of those two** before it
 * reaches the element. A name that crossed as `system` would be a `data-theme` no selector matches,
 * which draws the light palette and reports a setting that worked.
 *
 * The other half is what a value the wire cannot be trusted for means. `system` is the schema's
 * default and an unrecognised member is read as it, for the reason `petBubbleOpacityOf` gives: the
 * host sends a member on every arm, so what reaches that arm is an answer from something that is
 * not this host, and reading it as `light` would pin a theme the user never chose while reading it
 * as `dark` would invent one.
 */
import { describe, expect, it } from 'vitest'
import { PET_SETTINGS_DEFAULTS } from '../../../platform/gateways/pet-contracts'
import {
  PET_BUBBLE_THEMES,
  petBubbleThemeOf,
  prefersDarkScheme,
  resolvePetPageTheme,
} from './pet-bubble-theme'

describe('the bubble theme a read carries', () => {
  it('is the schema’s own three members, copied and still in step with it', () => {
    // A copy rather than an import: `PetSettingsValues` is the settings page's vocabulary and this
    // is the window's, and the two sides of that boundary are §9's one-truth line. The assertion is
    // what keeps the copy honest — a member added to the schema and not here fails, and so does one
    // removed.
    expect([...PET_BUBBLE_THEMES]).toEqual(['system', 'light', 'dark'])
    expect(PET_BUBBLE_THEMES).toContain(PET_SETTINGS_DEFAULTS.message.theme)
  })

  it('reads every member the schema declares', () => {
    expect(petBubbleThemeOf({ theme: 'light' })).toBe('light')
    expect(petBubbleThemeOf({ theme: 'dark' })).toBe('dark')
    expect(petBubbleThemeOf({ theme: 'system' })).toBe('system')
  })

  it('is the schema’s default for a value that is absent, or is not a member', () => {
    expect(petBubbleThemeOf({})).toBe('system')
    expect(petBubbleThemeOf({ theme: undefined })).toBe('system')
    expect(petBubbleThemeOf({ theme: 7 })).toBe('system')
    expect(petBubbleThemeOf({ theme: null })).toBe('system')
    // Not a member: a host that spelled its own word, or a store from a build with a fourth theme.
    expect(petBubbleThemeOf({ theme: 'solarized' })).toBe('system')
  })
})

describe('what reaches the page', () => {
  it('is one of the two palettes the stylesheet declares, never a third name', () => {
    // `system` is a *rule* for choosing between the two, and a page drawn in it would be a page
    // whose `data-theme` says a word no selector matches. Swept over every pair of settings rather
    // than over the bubble's members alone, because `system` now has two rules to stand on.
    for (const member of PET_BUBBLE_THEMES) {
      for (const host of PET_BUBBLE_THEMES) {
        expect(['light', 'dark']).toContain(resolvePetPageTheme(member, false, host))
        expect(['light', 'dark']).toContain(resolvePetPageTheme(member, true, host))
      }
    }
  })

  it('forces the two members whichever way the engine leans, and whatever the app says', () => {
    for (const host of PET_BUBBLE_THEMES) {
      expect(resolvePetPageTheme('light', false, host)).toBe('light')
      expect(resolvePetPageTheme('light', true, host)).toBe('light')
      expect(resolvePetPageTheme('dark', false, host)).toBe('dark')
      expect(resolvePetPageTheme('dark', true, host)).toBe('dark')
    }
  })

  it('follows the app when the bubble’s setting is `system`, which is what `system` is short for', () => {
    // §5.2's 「默认跟随宿主主题」: the third member is not "whatever the engine says", it is
    // "whatever the *app* is drawing". The app's own theme is a setting with the same three
    // members, so it decides before the engine does.
    expect(resolvePetPageTheme('system', false, 'dark')).toBe('dark')
    expect(resolvePetPageTheme('system', true, 'light')).toBe('light')
    // And when the app is following the engine too, the engine's preference is the answer — which
    // is the same signal `stores/appearance.ts` resolves the app's own `system` from, read from the
    // same engine in the same process.
    expect(resolvePetPageTheme('system', true, 'system')).toBe('dark')
    expect(resolvePetPageTheme('system', false, 'system')).toBe('light')
  })
})

describe('the engine’s own preference, as a page reads it', () => {
  it('is read from the media query, not inferred', () => {
    expect(prefersDarkScheme({ matchMedia: (query) => ({ matches: true, media: query }) })).toBe(true)
    expect(prefersDarkScheme({ matchMedia: (query) => ({ matches: false, media: query }) })).toBe(false)
  })

  it('is “no preference stated” where the engine has no matchMedia at all', () => {
    // A real state in this project's test environment rather than a hypothetical:
    // `PetSettingsPreview.vue` reads the same call behind the same guard, and the app's own store
    // answers `light` for the same absence (`stores/appearance.ts:114`).
    expect(prefersDarkScheme(undefined)).toBe(false)
    expect(prefersDarkScheme({ matchMedia: undefined as never })).toBe(false)
  })
})
