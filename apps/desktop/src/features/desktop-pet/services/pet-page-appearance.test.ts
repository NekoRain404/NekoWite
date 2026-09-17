/**
 * The pet window's page, drawn in the appearance the *user* chose in the app.
 *
 * The window is a page of its own (§7.1), so nothing it draws may be read out of the app window's
 * store — that is what `app/desktop-pet-entry.test.ts` refuses — and the whole of what it can know
 * arrives as the host's own answer. This file pins the two halves of the hop that answer travels:
 *
 *   1. **the reading** — what a read means, including the read that carries nothing, which is the
 *      state every double and every build from before the field existed is in;
 *   2. **the spelling** — the four attributes and one property that go on the element that is the
 *      page's `:root`, which is the same spelling the app's own shell puts on its own root
 *      (`app/AppShell.vue:207-210`, `:195`).
 *
 * The second is the load-bearing one. `palettes.css` selects a palette on `data-theme`, a scheme on
 * `data-color-scheme`, an accent on `data-accent` and high contrast on `data-contrast`, and the
 * accent and the scheme blocks are *separate* declarations rather than one table per combination —
 * so "which attributes" is the whole of what decides which colours a page draws. A window that
 * spelled one of them differently, or left one off, would draw a palette nobody else in this app
 * draws, and the numbers would differ from the settings page's preview for no visible reason.
 */
import { describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAppearanceStore } from '../../../stores/appearance'
import { APPEARANCE_DEFAULTS } from '../../../stores/appearance-schema'
import {
  PET_PAGE_APPEARANCE_DEFAULTS,
  PET_PAGE_BODY_SIZE,
  petHostAppearanceOf,
  petPageAttributesOf,
  readPetPageAttributes,
  writePetPageAttributes,
} from './pet-page-appearance'

describe('the app’s appearance, as the pet window reads it', () => {
  it('is the four axes and the body size, from the members the app publishes', () => {
    const read = petHostAppearanceOf({
      theme: 'dark',
      colorScheme: 'sunset',
      accent: 'coral',
      highContrast: true,
      bodyFontSize: 17,
    })
    expect(read).toEqual({
      theme: 'dark',
      colorScheme: 'sunset',
      accent: 'coral',
      highContrast: true,
      bodyFontSize: 17,
    })
  })

  it('is the app’s own defaults for a read that carries nothing', () => {
    // The state every double and every host older than this field is in. It is deliberately the
    // *app's* defaults rather than a fourth opinion: on a fresh install the app draws `system` in
    // its own window, at 15px, with the `default` scheme and the `ink` accent, and a pet window
    // that drew something else for "the app has not said" would be the one surface in the app that
    // is not the app's appearance.
    expect(petHostAppearanceOf({})).toEqual(PET_PAGE_APPEARANCE_DEFAULTS)
    expect(PET_PAGE_APPEARANCE_DEFAULTS).toEqual({
      theme: APPEARANCE_DEFAULTS.theme,
      colorScheme: APPEARANCE_DEFAULTS.colorScheme,
      accent: APPEARANCE_DEFAULTS.accent,
      highContrast: APPEARANCE_DEFAULTS.highContrast,
      bodyFontSize: APPEARANCE_DEFAULTS.bodyFontSize,
    })
  })

  it('reads a value it cannot act on as the default rather than as a member nothing has', () => {
    // A member this build does not know is not a theme: `system` is the rule for choosing between
    // the two palettes, and a word that is not one of the three would reach `data-theme` as a name
    // no selector matches — a page drawn light that reports a setting which worked.
    expect(petHostAppearanceOf({ theme: 'solarized' }).theme).toBe('system')
    expect(petHostAppearanceOf({ theme: 3 }).theme).toBe('system')
    // The two names are `palettes.css`'s and this module does not carry a second table of them: a
    // name no rule matches draws the axis's own default in *this* page, which is the same thing the
    // app's own window draws for it, because it is the same stylesheet. What is refused is a value
    // that is not a name at all.
    expect(petHostAppearanceOf({ accent: '' }).accent).toBe(APPEARANCE_DEFAULTS.accent)
    expect(petHostAppearanceOf({ colorScheme: 7 }).colorScheme).toBe(APPEARANCE_DEFAULTS.colorScheme)
    expect(petHostAppearanceOf({ accent: 'whatever-a-newer-build-added' }).accent).toBe(
      'whatever-a-newer-build-added',
    )
    expect(petHostAppearanceOf({ highContrast: 'yes' }).highContrast).toBe(false)
  })

  it('holds the body size to the range the app’s own setter holds it to', () => {
    // §5.3's 「界面和后端使用同一规则」, with the store itself as the other side of the rule rather
    // than a number copied into this file: the clamp below is exercised against the real setter, so
    // widening the app's range and not this one fails here.
    setActivePinia(createPinia())
    localStorage.clear()
    const store = useAppearanceStore()
    store.setBodyFontSize(PET_PAGE_BODY_SIZE.min - 100)
    expect(store.bodyFontSize).toBe(PET_PAGE_BODY_SIZE.min)
    store.setBodyFontSize(PET_PAGE_BODY_SIZE.max + 100)
    expect(store.bodyFontSize).toBe(PET_PAGE_BODY_SIZE.max)

    expect(petHostAppearanceOf({ bodyFontSize: 1 }).bodyFontSize).toBe(PET_PAGE_BODY_SIZE.min)
    expect(petHostAppearanceOf({ bodyFontSize: 999 }).bodyFontSize).toBe(PET_PAGE_BODY_SIZE.max)
    expect(petHostAppearanceOf({ bodyFontSize: Number.NaN }).bodyFontSize).toBe(
      APPEARANCE_DEFAULTS.bodyFontSize,
    )
    expect(petHostAppearanceOf({ bodyFontSize: '17' }).bodyFontSize).toBe(
      APPEARANCE_DEFAULTS.bodyFontSize,
    )
  })
})

describe('what the page root carries', () => {
  it('spells every axis the way the app’s own shell spells it', () => {
    // The shell writes `:data-theme="theme"`, `:data-color-scheme=`, `:data-accent=` and
    // `:data-contrast="appearance.highContrast ? 'high' : 'normal'"` — all four, always. The pet
    // window is a second page drawing the same table, so it says the same four things; what it must
    // never do is leave one off "because it is the default", which is how the light high-contrast
    // block (a `[data-theme="light"][data-color-scheme][data-contrast="high"]` selector) would stop
    // matching in one window and not the other.
    const appearance = petHostAppearanceOf({
      theme: 'system',
      colorScheme: 'forest',
      accent: 'teal',
      highContrast: false,
      bodyFontSize: 16,
    })
    expect(petPageAttributesOf(appearance, 'dark')).toEqual({
      theme: 'dark',
      colorScheme: 'forest',
      accent: 'teal',
      contrast: 'normal',
      bodySize: '16px',
    })
    expect(petPageAttributesOf(appearance, 'light')).toEqual({
      theme: 'light',
      colorScheme: 'forest',
      accent: 'teal',
      contrast: 'normal',
      bodySize: '16px',
    })
    expect(petPageAttributesOf(appearance, 'light').contrast).toBe('normal')
    expect(
      petPageAttributesOf({ ...appearance, highContrast: true }, 'light').contrast,
    ).toBe('high')
  })

  it('is written onto the element that is `:root`, and given back as it was found', () => {
    // The lifetime half, asserted on a real element: a window that unmounts must not leave a theme,
    // an accent or a body size behind on a document it is about to stop owning — the same rule the
    // composables beside this one follow for the pointer region and the drawing scope.
    const root = document.createElement('html')
    const found = readPetPageAttributes(root)
    expect(found).toEqual({
      theme: null,
      colorScheme: null,
      accent: null,
      contrast: null,
      bodySize: null,
    })

    writePetPageAttributes(root, {
      theme: 'dark',
      colorScheme: 'forest',
      accent: 'teal',
      contrast: 'high',
      bodySize: '16px',
    })
    expect(root.dataset.theme).toBe('dark')
    expect(root.dataset.colorScheme).toBe('forest')
    expect(root.dataset.accent).toBe('teal')
    expect(root.dataset.contrast).toBe('high')
    expect(root.style.getPropertyValue('--app-body-size')).toBe('16px')
    expect(readPetPageAttributes(root)).toEqual({
      theme: 'dark',
      colorScheme: 'forest',
      accent: 'teal',
      contrast: 'high',
      bodySize: '16px',
    })

    writePetPageAttributes(root, found)
    expect(root.dataset.theme).toBeUndefined()
    expect(root.dataset.colorScheme).toBeUndefined()
    expect(root.dataset.accent).toBeUndefined()
    expect(root.dataset.contrast).toBeUndefined()
    expect(root.style.getPropertyValue('--app-body-size')).toBe('')
  })

  it('puts back the attributes that were already there rather than the ones it wrote', () => {
    // A window mounted into a page that already carries an appearance — which is what a second
    // window on the same document is — must restore *that* one, not a blank.
    const root = document.createElement('html')
    root.dataset.theme = 'dark'
    root.style.setProperty('--app-body-size', '13px')
    const found = readPetPageAttributes(root)

    writePetPageAttributes(root, {
      theme: 'light',
      colorScheme: 'ocean',
      accent: 'rose',
      contrast: 'normal',
      bodySize: '18px',
    })
    writePetPageAttributes(root, found)

    expect(root.dataset.theme).toBe('dark')
    expect(root.dataset.colorScheme).toBeUndefined()
    expect(root.style.getPropertyValue('--app-body-size')).toBe('13px')
  })
})
