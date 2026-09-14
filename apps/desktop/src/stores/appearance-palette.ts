/**
 * The appearance palette: every colour the app can be told to use, and the pure
 * derivations over them.
 *
 * Nothing here reads a ref, a store or the DOM. The palette is a fixed
 * vocabulary of theme variables, so the swatch tables, the scheme preview
 * metadata and the nearest-colour search are plain functions - a test drives
 * them without Pinia, and `stores/appearance.ts` owns the state that picks
 * between them.
 */

/** An opaque 8-bit RGB triple, as the backend reports the OS accent. */
export interface Rgb {
  r: number
  g: number
  b: number
}

export type Accent =
  | 'ink'
  | 'coral'
  | 'blue'
  | 'green'
  | 'gold'
  | 'violet'
  | 'slate'
  | 'teal'
  | 'lime'
  | 'rose'
  | 'amber'
  | 'orange'
  | 'pink'
  | 'cyan'
  | 'cocoa'

/** Every accent the app can apply, in palette order. Exported because the
 *  settings panel renders one swatch per entry and the system-accent mapping
 *  below measures its distances against exactly this list. */
export const ACCENTS: Accent[] = ['ink', 'coral', 'blue', 'green', 'gold', 'violet', 'slate', 'teal', 'lime', 'rose', 'amber', 'orange', 'pink', 'cyan', 'cocoa']

/** The colour behind each swatch. This is the single source of truth for both
 *  the settings palette and the system-accent mapping, so following the system
 *  accent can only ever select a colour the app already has - it never invents
 *  an accent out of whatever value the OS happens to report. */
export const ACCENT_COLORS: Record<Accent, string> = {
  ink: '#343532',
  coral: '#d65f4d',
  blue: '#3f7edb',
  green: '#3e9b73',
  gold: '#b98b09',
  violet: '#8a65d1',
  slate: '#607287',
  teal: '#2e9e8f',
  lime: '#7aa816',
  rose: '#e05c76',
  amber: '#d98c1f',
  orange: '#e9782e',
  pink: '#e85c9e',
  cyan: '#1e9cc4',
  cocoa: '#8c5a3c',
}

/** CIE L*a*b*: a space where the plain Euclidean distance between two colours
 *  is a decent stand-in for how different they look to a person, which is what
 *  "the closest palette colour" has to mean. */
interface Lab {
  l: number
  a: number
  b: number
}

/** `#rgb`/`#rrggbb` -> rgb, or `null` for anything else. The table above is
 *  ours, so this guards a typo, not hostile input. */
function parseHexColor(hex: string): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  const digits = match?.[1]
  if (!digits) return null
  const full = digits.length === 3 ? digits.replace(/./g, (c) => c + c) : digits
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  }
}

/** sRGB channel (0..255) -> linear light, the transfer function Lab expects. */
function linearize(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** sRGB (D65) -> CIE L*a*b*. */
function srgbToLab({ r, g, b }: Rgb): Lab {
  const lr = linearize(r)
  const lg = linearize(g)
  const lb = linearize(b)
  const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047
  const y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.072175
  const z = (lr * 0.0193339 + lg * 0.119192 + lb * 0.9503041) / 1.08883
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29)
  const fx = f(x)
  const fy = f(y)
  const fz = f(z)
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

/** ΔE*ab (CIE76) between two Lab colours. */
function colourDistance(a: Lab, b: Lab): number {
  return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b)
}

const ACCENT_LAB = (() => {
  const table = {} as Record<Accent, Lab>
  for (const accent of ACCENTS) {
    const rgb = parseHexColor(ACCENT_COLORS[accent])
    // A malformed swatch would be a typo in the table above; treating it as
    // black keeps the mapping working instead of throwing at module load.
    table[accent] = rgb ? srgbToLab(rgb) : { l: 0, a: 0, b: 0 }
  }
  return table
})()

/** The palette accent closest to a colour the OS reported.
 *
 *  "Follow the system accent" cannot mean "apply the system colour": the app's
 *  accents are a fixed palette of theme variables, and that palette is not ours
 *  to repaint. It means "select the swatch that looks closest to the colour the
 *  user chose in Windows", which is a nearest-neighbour search in Lab - a
 *  saturated blue accent lands on `blue`, a greyscale one on `slate` or `ink`
 *  depending on how dark it is. Every palette colour is closest to itself, so a
 *  colour that happens to be a swatch keeps that swatch. */
export function accentFromSystemColor(rgb: Rgb): Accent {
  const source = srgbToLab(rgb)
  let best: Accent = 'ink'
  let bestDistance = Number.POSITIVE_INFINITY
  for (const accent of ACCENTS) {
    const distance = colourDistance(source, ACCENT_LAB[accent])
    if (distance < bestDistance) {
      bestDistance = distance
      best = accent
    }
  }
  return best
}

/** The accent applied while following the system accent but with no colour to
 *  follow: the accent tracks the effective light/dark theme instead - the
 *  behaviour from before the OS read existed, and what the settings note
 *  explains to the user. */
export function themeFallbackAccent(effective: 'light' | 'dark'): Accent {
  return effective === 'dark' ? 'violet' : 'coral'
}

export type ColorScheme = 'default' | 'sunset' | 'forest' | 'ocean' | 'sakura' | 'mist' | 'graphite' | 'midnight' | 'lavender' | 'desert' | 'mint' | 'coffee' | 'plum' | 'dusk' | 'crimson'

export const COLOR_SCHEMES: ColorScheme[] = ['default', 'sunset', 'forest', 'ocean', 'sakura', 'mist', 'graphite', 'midnight', 'lavender', 'desert', 'mint', 'coffee', 'plum', 'dusk', 'crimson']

export interface ColorSchemePreview {
  light: { canvas: string; panel: string; elevated: string; border: string; text: string; muted: string }
  dark: { canvas: string; panel: string; elevated: string; border: string; text: string; muted: string }
}

export const COLOR_SCHEME_PREVIEW: Record<ColorScheme, ColorSchemePreview> = {
  default: {
    light: { canvas: '#fbfaf6', panel: '#f5f3ee', elevated: '#fffefb', border: '#e7e3db', text: '#292a27', muted: '#8c8982' },
    dark: { canvas: '#171714', panel: '#1d1d1a', elevated: '#24241f', border: '#37362f', text: '#f0eee8', muted: '#a5a198' },
  },
  sunset: {
    light: { canvas: '#fff7f0', panel: '#fbece1', elevated: '#fffdf8', border: '#edd7c4', text: '#3a261d', muted: '#9a7b68' },
    dark: { canvas: '#231713', panel: '#2c1d17', elevated: '#38251d', border: '#55392b', text: '#f6e4d6', muted: '#c09178' },
  },
  forest: {
    light: { canvas: '#f4f8f1', panel: '#e8f0e2', elevated: '#fdfefa', border: '#d6e2ca', text: '#22301f', muted: '#708366' },
    dark: { canvas: '#131b12', panel: '#1a2418', elevated: '#243020', border: '#3b4d36', text: '#e8f3e2', muted: '#a6bb9b' },
  },
  ocean: {
    light: { canvas: '#f2f8fc', panel: '#e5f0f7', elevated: '#fbfeff', border: '#cfe0ec', text: '#1c2e3d', muted: '#668094' },
    dark: { canvas: '#0f1a22', panel: '#16232d', elevated: '#1e303c', border: '#355366', text: '#e4f2fa', muted: '#9fb9c9' },
  },
  sakura: {
    light: { canvas: '#fdf3f5', panel: '#f8e8eb', elevated: '#fffafa', border: '#ecd2d8', text: '#3a232a', muted: '#9d7b83' },
    dark: { canvas: '#1f1417', panel: '#281a1e', elevated: '#352128', border: '#5b3842', text: '#f8e8ec', muted: '#c494a0' },
  },
  mist: {
    light: { canvas: '#f7f8fa', panel: '#eef0f4', elevated: '#fefeff', border: '#dfe3ea', text: '#2b303a', muted: '#8b95a3' },
    dark: { canvas: '#15171c', panel: '#1b1e25', elevated: '#242831', border: '#3c4350', text: '#eef1f6', muted: '#a7b0be' },
  },
  graphite: {
    light: { canvas: '#ececec', panel: '#e0e0e0', elevated: '#f6f6f6', border: '#c7c7c7', text: '#202020', muted: '#757575' },
    dark: { canvas: '#0d0d0d', panel: '#131313', elevated: '#1c1c1c', border: '#333333', text: '#f2f2f2', muted: '#9e9e9e' },
  },
  midnight: {
    light: { canvas: '#0f1220', panel: '#151a2c', elevated: '#1e2438', border: '#323c58', text: '#eef1fa', muted: '#a2acc5' },
    dark: { canvas: '#0a0c14', panel: '#10131f', elevated: '#181c2c', border: '#2c3450', text: '#f0f3fc', muted: '#a9b2c8' },
  },
  lavender: {
    light: { canvas: '#f7f4fb', panel: '#ece5f5', elevated: '#fefdff', border: '#d9cdea', text: '#2e253d', muted: '#897c9f' },
    dark: { canvas: '#16111f', panel: '#1e172a', elevated: '#2a2138', border: '#44375b', text: '#efeaf7', muted: '#b2a4c6' },
  },
  desert: {
    light: { canvas: '#fbf4e8', panel: '#f4e8d4', elevated: '#fffdf7', border: '#e6d3b6', text: '#3e2f1d', muted: '#9a8260' },
    dark: { canvas: '#1d1710', panel: '#282017', elevated: '#352b1f', border: '#594a34', text: '#f4ead8', muted: '#c0a987' },
  },
  mint: {
    light: { canvas: '#eef9f5', panel: '#e0f2ea', elevated: '#fcfffd', border: '#c8e6d9', text: '#1d3330', muted: '#6c9a8e' },
    dark: { canvas: '#0e1a17', panel: '#142521', elevated: '#1d332e', border: '#31554c', text: '#e3f5ef', muted: '#96c3b5' },
  },
  coffee: {
    light: { canvas: '#f5eeea', panel: '#ebe0d8', elevated: '#fffaf7', border: '#dcc8bc', text: '#33221a', muted: '#8b7063' },
    dark: { canvas: '#17110e', panel: '#201713', elevated: '#2e211b', border: '#4f3b30', text: '#f2e7df', muted: '#b79584' },
  },
  plum: {
    light: { canvas: '#f9f1f5', panel: '#f0e1ea', elevated: '#fffafd', border: '#e2c8d7', text: '#35202d', muted: '#976e87' },
    dark: { canvas: '#180e16', panel: '#221420', elevated: '#311c2b', border: '#533348', text: '#f6e6f1', muted: '#c18fa9' },
  },
  dusk: {
    light: { canvas: '#f0f2fa', panel: '#e4e7f5', elevated: '#fbfcff', border: '#ced4ea', text: '#252941', muted: '#7581a6' },
    dark: { canvas: '#101223', panel: '#171a31', elevated: '#222647', border: '#374069', text: '#e9ecfa', muted: '#9ba6ca' },
  },
  crimson: {
    light: { canvas: '#fbf1f2', panel: '#f4e0e2', elevated: '#fffafb', border: '#e8c7ca', text: '#3a2024', muted: '#99747a' },
    dark: { canvas: '#1a1012', panel: '#25161a', elevated: '#341e23', border: '#5a363e', text: '#f7e6e8', muted: '#c2939b' },
  },
}
