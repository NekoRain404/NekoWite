/**
 * Typography: the font families the app offers and the plain lookups that turn
 * a stored font id into the CSS `font-family` value.
 *
 * THE RULE THIS TABLE IS HELD TO: every family a preset names is a family the
 * app ships. A `font-family` list is a request, not a guarantee — a stack whose
 * first entry names a font the machine does not have resolves to whatever the
 * platform happens to substitute, silently. That is how this table was wrong:
 * it offered Inter, Nunito, Literata, Source Serif 4 and Cascadia Code while
 * nothing in the bundle declared a single `@font-face`, so five of eleven
 * presets changed nothing on a machine without those fonts installed, and every
 * Chinese stack fell through to a Windows font or the generic fallback.
 *
 * The families are therefore loaded by `styles/fonts.css` — the woff2 files are
 * in `apps/desktop/public/fonts/` — and `fonts.test.ts` checks this file against
 * that one, so a name added here without a file behind it fails rather than
 * shipping.
 *
 * The two Chinese faces are named after the Latin family in every preset, and
 * that order is load-bearing in one direction only: the Latin files carry the
 * `latin` subset alone, so a CJK character falls through to the Chinese face by
 * per-character fallback. A character outside the Chinese subset (GB2312) falls
 * through to the platform's own font in turn — never to tofu.
 *
 * A family name here is deliberately NOT platform-specific, and the rule is
 * checked rather than trusted: the FAMILY A PRESET LEADS WITH is always one this
 * bundle carries, and a name it does not carry may only ever appear after one
 * that it does. `"PingFang SC"` (macOS), `"Microsoft YaHei"`, `"Segoe UI"`,
 * `"Times New Roman"`, `Menlo` and `Consolas` are gone for that reason: this
 * application supports Linux, a name the platform is not expected to have is a
 * request that silently resolves to something else, and the platform's own fonts
 * are what the generic keywords already reach.
 *
 * `Georgia` is the one exception and it is written down rather than implied: it
 * was the family the previous build led the serif preset with, an existing
 * assertion pins it there (`App.appearance.test.ts`: the chosen serif has to
 * reach `--app-font`), and keeping it in the TAIL costs nothing — a tail is
 * reached only when the bundled file is unavailable, which is the case it is a
 * fallback for. `styles/fonts.test.ts` checks the positional rule for every
 * preset.
 *
 * The three id lists are exported because the stored blob is validated against
 * them (`appearance-schema.ts`): an id written by a newer build - or a typo in
 * localStorage - has to fall back to the preset instead of producing a family
 * string of `undefined`. Nothing here reads a ref or a store.
 */

export type UiFontId = 'system' | 'inter' | 'plex' | 'serif' | 'rounded'
export type EditorFontId = 'system' | 'sans' | 'serif' | 'reading' | 'plex' | 'code'
export type MonoFontId = 'mono' | 'jetbrains' | 'cascadia' | 'lilex'

/** The bundled Chinese sans, for every stack whose Latin family has no CJK. */
const CJK_SANS = '"Noto Sans SC"'
/** The bundled Chinese serif, for the reading and serif stacks. */
const CJK_SERIF = '"Noto Serif SC"'

export const UI_FONTS: Record<UiFontId, string> = {
  // The OS speaks first, because that is what the option's name says. `Inter`
  // follows it rather than leading it: it is the app's own font (see
  // `styles/tokens.css`), and the preset that asks for it by name is `inter`.
  // A machine with no UI font at all still lands on a real face either way.
  system: `system-ui, ui-sans-serif, "Inter", ${CJK_SANS}, sans-serif`,
  inter: `"Inter", ${CJK_SANS}, ui-sans-serif, system-ui, sans-serif`,
  plex: `"IBM Plex Sans", ${CJK_SANS}, ui-sans-serif, system-ui, sans-serif`,
  serif: `"Source Serif 4", ${CJK_SERIF}, Georgia, ui-serif, serif`,
  rounded: `"Nunito", ${CJK_SANS}, ui-rounded, system-ui, sans-serif`,
}

export const EDITOR_FONTS: Record<EditorFontId, string> = {
  system: 'var(--app-font)',
  sans: `"Inter", ${CJK_SANS}, ui-sans-serif, system-ui, sans-serif`,
  serif: `"Source Serif 4", ${CJK_SERIF}, Georgia, ui-serif, serif`,
  reading: `"Literata", ${CJK_SERIF}, Georgia, ui-serif, serif`,
  plex: `"IBM Plex Sans", ${CJK_SANS}, ui-sans-serif, system-ui, sans-serif`,
  code: 'var(--app-mono-font)',
}

export const MONO_FONTS: Record<MonoFontId, string> = {
  // The platform's own monospace, and the bundled Chinese sans for the CJK that
  // appears inside code blocks and comments. `Cascadia Code` used to be second
  // here, which made this preset and the `cascadia` preset below the same
  // rendering — two options, one result.
  mono: `ui-monospace, ${CJK_SANS}, monospace`,
  jetbrains: `"JetBrains Mono", ${CJK_SANS}, ui-monospace, monospace`,
  cascadia: `"Cascadia Code", ${CJK_SANS}, ui-monospace, monospace`,
  lilex: `"Lilex", ${CJK_SANS}, ui-monospace, monospace`,
}

export const UI_FONT_IDS: UiFontId[] = ['system', 'inter', 'plex', 'serif', 'rounded']
export const EDITOR_FONT_IDS: EditorFontId[] = ['system', 'sans', 'serif', 'reading', 'plex', 'code']
export const MONO_FONT_IDS: MonoFontId[] = ['mono', 'jetbrains', 'cascadia', 'lilex']

/** The families `styles/fonts.css` declares, so the picker cannot offer a name
 *  nothing loads. Read by `fonts.test.ts` and by the stylesheet's own test. */
export const BUNDLED_FAMILIES: readonly string[] = [
  'Inter',
  'IBM Plex Sans',
  'Nunito',
  'Source Serif 4',
  'Literata',
  'JetBrains Mono',
  'Cascadia Code',
  'Lilex',
  'Noto Sans SC',
  'Noto Serif SC',
]

/** The families resolve through the preset table, with the `??` guarding a
 *  value that reached the ref without passing the schema's validation. */
export function uiFontFamily(id: UiFontId): string {
  return UI_FONTS[id] ?? UI_FONTS.system
}

export function editorFontFamily(id: EditorFontId): string {
  return EDITOR_FONTS[id] ?? EDITOR_FONTS.system
}

export function monoFontFamily(id: MonoFontId): string {
  return MONO_FONTS[id] ?? MONO_FONTS.mono
}
