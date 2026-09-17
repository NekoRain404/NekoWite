import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { BUNDLED_FAMILIES, EDITOR_FONTS, MONO_FONTS, UI_FONTS } from '../stores/appearance-fonts'

/**
 * The contract between the picker and the renderer.
 *
 * `stores/appearance-fonts.ts` offers families; `styles/fonts.css` is the only
 * thing that makes them exist. The defect this file exists to prevent is the
 * whole reason the two are checked against each other: the table used to name
 * Inter, Nunito, Literata, Source Serif 4 and Cascadia Code while nothing in the
 * bundle declared a single `@font-face`, so five of eleven presets changed
 * nothing on a machine without those fonts installed — a control that looks
 * available and does nothing, and one that no test could see, because every
 * assertion was about the table and none was about the stylesheet.
 *
 * A `font-family` list is a REQUEST. The only thing that turns a request into a
 * guarantee is a file, at a URL the bundle actually contains.
 */

const read = (file: string): string => readFileSync(resolve(__dirname, file), 'utf8')
const filesCss = read('./fonts.css')
const tokensCss = read('./tokens.css')
const PUBLIC_FONTS = resolve(__dirname, '..', '..', 'public', 'fonts')

const unquote = (s: string): string => s.trim().replace(/^['"]|['"]$/g, '')

/** Every `@font-face` block, as its declaration text. */
const FACE_BLOCKS = [...filesCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1])

/** Every family `fonts.css` declares. */
const DECLARED = new Set(
  FACE_BLOCKS.map((block) => block.match(/font-family:\s*([^;]+);/)?.[1])
    .filter((f): f is string => typeof f === 'string')
    .map(unquote),
)

/**
 * The generic families: the keywords CSS itself defines, which every engine
 * resolves against the platform. Naming one is not a promise about which font
 * it is, and that is exactly why they are allowed in a stack while a specific
 * platform font is not.
 */
const GENERIC = new Set([
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded',
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'fantasy',
  'math',
  'emoji',
  'fangsong',
])

/** The two stacks `tokens.css` declares for a window with no shell mounted (the
 *  pet's), read as the values the `var()` presets below resolve to. */
function tokenValue(name: string): string {
  const value = tokensCss.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]
  return (value ?? '').trim()
}
const TOKEN_STACKS: Record<string, string> = {
  '--app-font': tokenValue('--app-font'),
  '--app-mono-font': tokenValue('--app-mono-font'),
}

/** A preset's stack, with anything that is not a family name removed. */
function familiesOf(stack: string, depth = 0): string[] {
  const out: string[] = []
  for (const part of stack.split(',')) {
    const name = unquote(part)
    if (name.length === 0) continue
    const variable = name.match(/^var\((--app-[a-z-]+)/)?.[1]
    if (variable) {
      // A preset that defers to a token is not exempt from the rule, it is one
      // hop away from it: the token's own value is checked in its place.
      expect(TOKEN_STACKS[variable], `tokens.css declares ${variable}`).toBeTruthy()
      if (depth < 2) out.push(...familiesOf(TOKEN_STACKS[variable], depth + 1))
      continue
    }
    out.push(name)
  }
  return out
}

const PRESETS: Array<[string, string]> = [
  ...Object.entries(UI_FONTS).map(([id, s]): [string, string] => [`uiFont.${id}`, s]),
  ...Object.entries(EDITOR_FONTS).map(([id, s]): [string, string] => [`editorFont.${id}`, s]),
  ...Object.entries(MONO_FONTS).map(([id, s]): [string, string] => [`monoFont.${id}`, s]),
]

const CJK_FAMILIES = BUNDLED_FAMILIES.filter((f) => f.startsWith('Noto '))

describe('the fonts the picker offers are the fonts the app loads', () => {
  it('declares a @font-face for every bundled family, and nothing else', () => {
    // Both directions on purpose. A family in the list with no rule is an
    // option that resolves to the platform's substitute — the original defect.
    // A rule for a family the list does not have is a file nothing can reach,
    // which is the same defect with the halves swapped.
    expect([...DECLARED].sort()).toEqual([...BUNDLED_FAMILIES].sort())
    expect(DECLARED.size).toBe(BUNDLED_FAMILIES.length)
  })

  it('leads every preset with a family it bundles, and only falls back after one', () => {
    // Positional, and that is the whole of the rule. A name the bundle does not
    // carry is only reachable when the bundled file before it is unavailable —
    // which is exactly what a fallback is for, and is not the same claim as a
    // preset that LEADS with a font the machine may not have. The presets that
    // were broken led with one: `"Literata"`, `"Nunito"`, `"Cascadia Code"`,
    // `Georgia` and `"Inter"` were all first, and none of them was loaded, so
    // the option resolved to whatever fontconfig substituted and nothing failed.
    for (const [preset, stack] of PRESETS) {
      const named = familiesOf(stack).filter((f) => !GENERIC.has(f))
      expect(named.length, `${preset} names no family at all`).toBeGreaterThan(0)
      expect(BUNDLED_FAMILIES, `${preset} leads with "${named[0]}"`).toContain(named[0])
      const firstBundled = named.findIndex((f) => BUNDLED_FAMILIES.includes(f))
      for (const [i, family] of named.entries()) {
        if (BUNDLED_FAMILIES.includes(family)) continue
        expect(
          i > firstBundled,
          `${preset} names "${family}" before any family the bundle carries`,
        ).toBe(true)
      }
    }
  })

  it('reaches a bundled Chinese face from every preset', () => {
    // Every preset, not just the ones that look Chinese: the app is
    // Chinese-facing, so a preset that resolves CJK to whatever the platform
    // happens to have is a preset that renders a Windows font on Linux.
    for (const [preset, stack] of PRESETS) {
      const families = familiesOf(stack)
      expect(
        families.some((f) => CJK_FAMILIES.includes(f)),
        `${preset} reaches no bundled Chinese face`,
      ).toBe(true)
    }
  })

  it('points every url() at a file that exists in the bundle', () => {
    // The binary half of the same rule. `public/fonts/` is copied into the
    // build verbatim, so a URL here and a file there are the same claim.
    const urls = [...filesCss.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1])
    expect(urls.length, 'fonts.css loads no files at all').toBeGreaterThan(0)
    for (const url of urls) {
      expect(url.startsWith('/fonts/'), `${url} is not served from /fonts/`).toBe(true)
      const file = resolve(PUBLIC_FONTS, url.replace('/fonts/', ''))
      expect(existsSync(file), `${url} has no file at ${file}`).toBe(true)
    }
  })

  it('gives the Chinese faces a unicode-range that covers the ideograph block', () => {
    // The range is what makes the faces affordable — a page with no CJK never
    // fetches them. It is also the one declaration whose absence is silent in
    // the other direction: a range that missed U+4E00-9FFF would drop every
    // hanzi out of the font and back onto the platform, with nothing failing.
    for (const block of FACE_BLOCKS) {
      const family = unquote(block.match(/font-family:\s*([^;]+);/)?.[1] ?? '')
      if (!CJK_FAMILIES.includes(family)) continue
      const range = block.match(/unicode-range:\s*([^;]+);/)?.[1]
      expect(range, `${family} declares no unicode-range`).toBeTruthy()
      const spans: Array<[number, number]> = [...(range as string).matchAll(/U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?/g)].map(
        (m) => [parseInt(m[1], 16), m[2] ? parseInt(m[2], 16) : parseInt(m[1], 16)],
      )
      const covers = (cp: number): boolean => spans.some(([a, b]) => a <= cp && cp <= b)
      expect(covers(0x4e00), `${family} does not cover U+4E00`).toBe(true)
      expect(covers(0x9fff), `${family} does not cover U+9FFF`).toBe(true)
      expect(covers(0x3002), `${family} does not cover U+3002 (。)`).toBe(true)
    }
  })

  it('gives the Chinese faces a weight axis, since none of them ships an italic', () => {
    // `font-synthesis: none` (tokens.css) means the engine will not fake a
    // weight. A Chinese face with no `wght` range would render every heading at
    // body weight, and one declared `font-style: italic` would have nothing
    // behind it.
    for (const block of FACE_BLOCKS) {
      const family = unquote(block.match(/font-family:\s*([^;]+);/)?.[1] ?? '')
      if (!CJK_FAMILIES.includes(family)) continue
      const weight = block.match(/font-weight:\s*([^;]+);/)?.[1]?.trim() ?? ''
      const [min, max] = weight.split(/\s+/)
      expect(weight, `${family} declares no font-weight`).not.toBe('')
      expect(weight.split(/\s+/).length, `${family}'s font-weight is not a range`).toBe(2)
      expect(Number(min)).toBeLessThanOrEqual(400)
      expect(Number(max)).toBeGreaterThanOrEqual(700)
      expect(block).toContain('font-style: normal')
    }
  })

  it('keeps the tokens.css defaults equal to the presets they stand for', () => {
    // `--app-font` is the value a window has before AppShell mounts and the
    // only value the pet's window ever gets. A second, drifting opinion about
    // the default would show up as the text changing on mount — and in the pet
    // window, as text that never changes at all.
    expect(tokenValue('--app-font')).toBe(UI_FONTS.system)
    expect(tokenValue('--app-mono-font')).toBe(MONO_FONTS.mono)
  })
})
