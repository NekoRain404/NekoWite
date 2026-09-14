/**
 * The palette's pure derivations, driven directly.
 *
 * No Pinia, no localStorage and no matchMedia: the swatch tables and the
 * nearest-colour search are what `stores/appearance.ts` picks between, so they
 * are tested here rather than through a store that has nothing to add to them.
 */

import { describe, expect, it } from 'vitest'
import {
  ACCENTS,
  ACCENT_COLORS,
  COLOR_SCHEMES,
  COLOR_SCHEME_PREVIEW,
  accentFromSystemColor,
} from './appearance-palette'

describe('appearance palette metadata', () => {
  it('exports a complete palette metadata for every color scheme', () => {
    expect(COLOR_SCHEMES).toEqual(['default', 'sunset', 'forest', 'ocean', 'sakura', 'mist', 'graphite', 'midnight', 'lavender', 'desert', 'mint', 'coffee', 'plum', 'dusk', 'crimson'])
    for (const scheme of COLOR_SCHEMES) {
      const preview = COLOR_SCHEME_PREVIEW[scheme]
      expect(preview, scheme).toBeTruthy()
      expect(preview.light).toBeTruthy()
      expect(preview.dark).toBeTruthy()
      expect(preview.light.canvas).toMatch(/^#[0-9a-f]{6}$/i)
      expect(preview.light.panel).toMatch(/^#[0-9a-f]{6}$/i)
      expect(preview.light.elevated).toMatch(/^#[0-9a-f]{6}$/i)
      expect(preview.light.text).toMatch(/^#[0-9a-f]{6}$/i)
      expect(preview.light.muted).toMatch(/^#[0-9a-f]{6}$/i)
      expect(preview.dark.canvas).toMatch(/^#[0-9a-f]{6}$/i)
      expect(preview.dark.panel).toMatch(/^#[0-9a-f]{6}$/i)
      expect(preview.dark.elevated).toMatch(/^#[0-9a-f]{6}$/i)
      expect(preview.dark.text).toMatch(/^#[0-9a-f]{6}$/i)
      expect(preview.dark.muted).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})

describe('accentFromSystemColor (nearest palette colour in Lab)', () => {
  function rgbOf(hex: string): { r: number; g: number; b: number } {
    return {
      r: Number.parseInt(hex.slice(1, 3), 16),
      g: Number.parseInt(hex.slice(3, 5), 16),
      b: Number.parseInt(hex.slice(5, 7), 16),
    }
  }

  it('keeps a colour that is exactly a palette swatch', () => {
    // The whole promise of the feature is "the closest colour the app
    // already has"; a distance of zero has to win over every neighbour.
    for (const accent of ACCENTS) {
      expect(accentFromSystemColor(rgbOf(ACCENT_COLORS[accent])), accent).toBe(accent)
    }
  })

  it('maps the default Windows blue onto the palette blue', () => {
    // #0078d4 is what a stock Windows 11 install reports (and what this
    // machine reports from HKCU\\...\\DWM\\ColorizationColor).
    expect(accentFromSystemColor({ r: 0x00, g: 0x78, b: 0xd4 })).toBe('blue')
  })

  it('maps the Windows accent palette onto the matching swatches', () => {
    expect(accentFromSystemColor({ r: 0xd1, g: 0x34, b: 0x38 }), 'red').toBe('coral')
    expect(accentFromSystemColor({ r: 0x8e, g: 0x44, b: 0xad }), 'purple').toBe('violet')
    expect(accentFromSystemColor({ r: 0x00, g: 0xb7, b: 0xc3 }), 'teal').toBe('teal')
    expect(accentFromSystemColor({ r: 0xe3, g: 0x00, b: 0x8c }), 'magenta').toBe('pink')
    expect(accentFromSystemColor({ r: 0xff, g: 0x8c, b: 0x00 }), 'orange').toBe('orange')
    // Windows' vivid green has no vivid green to land on: the palette's
    // `green` is a muted sea green, so the nearest colour is `lime`. Pinned
    // here so that adding a truer green to the palette shows up as a diff.
    expect(accentFromSystemColor({ r: 0x10, g: 0x7c, b: 0x10 }), 'green').toBe('lime')
  })

  it('maps greyscale accents onto the palette neutrals', () => {
    // Windows lets the user pick black and grey accents; the palette has two
    // near-neutrals, so dark goes to `ink` and mid grey to `slate`.
    expect(accentFromSystemColor({ r: 0x00, g: 0x00, b: 0x00 })).toBe('ink')
    expect(accentFromSystemColor({ r: 0x4c, g: 0x4a, b: 0x48 })).toBe('ink')
    expect(accentFromSystemColor({ r: 0x76, g: 0x76, b: 0x76 })).toBe('slate')
  })

  it('never answers with a colour outside the palette', () => {
    for (let value = 0; value <= 0xff; value += 17) {
      const answer = accentFromSystemColor({ r: value, g: 0xff - value, b: (value * 7) % 256 })
      expect(ACCENTS, `rgb(${value}, ${0xff - value}, ${(value * 7) % 256})`).toContain(answer)
    }
  })
})
