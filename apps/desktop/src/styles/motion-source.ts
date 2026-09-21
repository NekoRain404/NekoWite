import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MOTION_SHEETS } from './motion-sheets'

/**
 * The motion layer's source text, as the guards read it.
 *
 * This module exists because the motion guards are no longer one file: they
 * were split by behaviour domain, and every one of them reads the same text the
 * same way — a stylesheet, or a `.vue` file with its script and markup comments
 * removed so an assertion sees declarations only. `motion-sheets.ts` next door
 * holds the sheet list for the same reason: a list two readers keep in step by
 * hand is a list that drifts, and a reader that drifts is a guard that has
 * stopped looking at a file while still reporting success.
 *
 * These reads are deliberately not defensive. A path that has become a shim, or
 * a file that has moved, has to fail at collection time rather than hand a
 * guard an empty string to pass over.
 */

export const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8')

/**
 * The motion layer's sheets, read as one text.
 *
 * Reading a single path was a real hazard and not a hypothetical one: several
 * guards in the suite are *negative* — `declarations(motion)` must not hold a
 * `.dialog :nth-child` rule, and a stagger scan asserts the absence of
 * something — and a negative assertion run against a sheet that no longer
 * contains the selector passes while checking nothing. When the layer was split
 * into `surface-motion.css` (how a surface arrives, leaves and is nudged) and
 * `motion.css` (the press and the switch), a `read('./motion.css')` would have
 * gone on reporting success for guards about `.dialog`, `.arrives` and the
 * arrival keyframes while looking at none of them.
 *
 * It lives in `motion-sheets.ts`, because this module is not its only reader.
 */
export const motion = MOTION_SHEETS.map((sheet) => read(sheet)).join('\n')

/** The app entry, whose import order decides which layer the sweep governs. */
export const main = read('../main.ts')

/**
 * A file with its prose removed, so an assertion can read declarations only.
 *
 * `//` is a comment in a `<script>` and not in CSS, so a .vue file is stripped
 * by region rather than as one text: block comments and line comments inside
 * `<script>`, HTML comments in the template, block comments in the stylesheet.
 * A `//` in a stylesheet is not a comment either — stripping it there would eat
 * the rest of the declaration — so the stylesheet half is left to its own
 * syntax.
 *
 * The stylesheet is located in the *raw* text, which is not a detail. A
 * comment opener that is not one — the `accept="image/*"` of a file input —
 * begins a "comment" that runs to the next terminator, and in one component
 * that terminator is a stylesheet comment *past* its `<style>` tag: the
 * stylesheet sat inside the body of that phantom comment, so the whole file
 * read as an empty string to every guard and every one of them passed.
 * Finding the tag before any stripping is what keeps a guard from reading a
 * file that is not there — the same failure as a listed path that has become a
 * shim, one level up.
 *
 * This is prose handling and not a relaxation. A script comment cannot reach an
 * element any more than a stylesheet comment can, and the check exists to stop
 * a raw duration *rendering* — a script comment that quotes the ladder to
 * explain itself is documentation, exactly like the ones in the stylesheets.
 * Code is untouched either way: a literal in a template string is still a
 * literal.
 */
export const declarations = (source: string, file = ''): string => {
  const blocks = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '')
  if (!file.endsWith('.vue')) return blocks(source)
  /** The half above the stylesheet: script comments and markup comments. */
  const prose = (text: string) =>
    text
      .replace(/<script[\s\S]*?<\/script>/g, (script) =>
        blocks(script).replace(/\/\/[^\n]*/g, ''),
      )
      .replace(/<!--[\s\S]*?-->/g, '')
  const styleAt = source.indexOf('<style')
  if (styleAt === -1) return prose(source)
  return prose(source.slice(0, styleAt)) + blocks(source.slice(styleAt))
}
