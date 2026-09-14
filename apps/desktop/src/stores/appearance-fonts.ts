/**
 * Typography: the font families the app offers and the plain lookups that turn
 * a stored font id into the CSS `font-family` value.
 *
 * The three id lists are exported because the stored blob is validated against
 * them (`appearance-schema.ts`): an id written by a newer build - or a typo in
 * localStorage - has to fall back to the preset instead of producing a family
 * string of `undefined`. Nothing here reads a ref or a store.
 */

export type UiFontId = 'system' | 'inter' | 'serif' | 'rounded'
export type EditorFontId = 'system' | 'serif' | 'sans' | 'reading'
export type MonoFontId = 'mono' | 'cascadia' | 'jetbrains'

export const UI_FONTS: Record<UiFontId, string> = {
  system: 'Inter, "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  inter: '"Inter", "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'Georgia, "Songti SC", "Noto Serif SC", "Source Han Serif SC", "Times New Roman", serif',
  rounded: '"Nunito", ui-rounded, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
}

export const EDITOR_FONTS: Record<EditorFontId, string> = {
  system: 'var(--app-font)',
  serif: 'Georgia, "Songti SC", "Noto Serif SC", "Source Han Serif SC", "Times New Roman", serif',
  sans: 'Inter, "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif',
  reading: '"Literata", "Source Serif 4", Georgia, "Songti SC", serif',
}

export const MONO_FONTS: Record<MonoFontId, string> = {
  mono: '"SFMono-Regular", "Cascadia Code", "Roboto Mono", Menlo, Monaco, Consolas, "PingFang SC", "Microsoft YaHei", ui-monospace, monospace',
  cascadia: '"Cascadia Code", "Cascadia Mono", "SFMono-Regular", Consolas, "PingFang SC", ui-monospace, monospace',
  jetbrains: '"JetBrains Mono", "Cascadia Code", "SFMono-Regular", Menlo, Monaco, Consolas, ui-monospace, monospace',
}

export const UI_FONT_IDS: UiFontId[] = ['system', 'inter', 'serif', 'rounded']
export const EDITOR_FONT_IDS: EditorFontId[] = ['system', 'serif', 'sans', 'reading']
export const MONO_FONT_IDS: MonoFontId[] = ['mono', 'cascadia', 'jetbrains']

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
