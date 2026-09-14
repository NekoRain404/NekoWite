import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/* The two panes are one setting.
 *
 * The user reported that the source pane and the rendered pane did not look the
 * same size and could not tell whether that was a configuration difference or a
 * font-metric one. It was configuration: the source pane declared
 * `fontSize: '13.5px'` and `lineHeight: '1.7'` inside its CodeMirror theme, two
 * lines under a comment claiming every value there went through a token, while
 * the rendered pane read `--app-body-size` (15px) and `--app-line-height`. An
 * 11% gap, on screen, for as long as both panes have existed.
 *
 * Why no test caught it: the token suite checks that tokens are DEFINED and that
 * every `var()` READ resolves to one. Nothing anywhere checked that a value comes
 * from a token instead of being written out. This file is that check, for the one
 * pair of numbers the user can see side by side.
 *
 * Scope, deliberately narrow: the BASE size and leading of each pane, and the
 * CodeMirror theme that is the only thing able to silently override them from
 * JavaScript. Heading ladders, code and table sizes are per-pane decisions and
 * are not asserted here — a test that has to be exclusion-listed into
 * uselessness is worse than no test. The second half of the rendered pane's layer
 * is still read, though, and for a reason that is not about scope: a stylesheet
 * split must not be able to move the rule out from under this file while it goes
 * on reporting success against the half that is left. So the rendered pane is a
 * LIST of sheets, read joined, and the list is asserted below.
 *
 * What this cannot see: a later rule overriding these. This is a source-level
 * check and it is honest about it — it catches the literal coming back, which is
 * the regression that actually happened. Layout is the e2e suite's job. */

const SRC = resolve(__dirname, '..')
const read = (path: string): string => readFileSync(resolve(SRC, path), 'utf8')

/**
 * The rendered pane's sheets, in the order main.ts loads them.
 *
 * Reading one path was correct only while the layer was one file. The rules
 * below are `toMatch`es against the joined text, so a sheet left out of this
 * list takes its rules out of every one of them without failing anything —
 * which is precisely how a guard reports success while checking nothing.
 */
const RENDERED_SHEETS = ['styles/editor-content.css', 'styles/editor-blocks.css'] as const
const rendered = (): string => RENDERED_SHEETS.map(read).join('\n')

const SOURCE = 'features/editor/styles/sourcePane.css'
const THEME = 'services/cm-source-view.ts'

/** The body of a rule, by its selector. Fails loudly when the selector is gone
    rather than passing on an empty match — a rule that stopped matching would
    otherwise turn this whole file into a test that asserts nothing. */
function block(text: string, selector: RegExp, where: string): string {
  const found = selector.exec(text)
  expect(found, `${where}: the rule is gone, so this test can no longer see it`).not.toBeNull()
  return found![1]
}

describe('the rendered pane sheet list itself', () => {
  it('is non-empty, and every sheet in it is there with rules in it', () => {
    expect(RENDERED_SHEETS.length, 'an empty list makes every assertion below vacuous').toBeGreaterThan(0)
    for (const file of RENDERED_SHEETS) {
      expect(existsSync(resolve(SRC, file)), `${file} is listed and is not there`).toBe(true)
      expect(read(file).replace(/\/\*[\s\S]*?\*\//g, '').trim(), `${file} is listed and has no rules`).not.toBe('')
    }
  })

  it('only lists sheets that still style the rendered editor', () => {
    // A renamed, emptied or wrongly-listed sheet would otherwise be read as a
    // string that happens to contain no rules and pass every regex below.
    for (const file of RENDERED_SHEETS) {
      // Comments stripped first: the selector named in a sentence is not the
      // selector declared, and a file whose only mention of it is prose is a
      // file this list should not be reading.
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '')
      expect(
        code,
        `${file} is in this layer and styles none of it — a sheet read as a string with no rules passes every check below`,
      ).toMatch(/\.editor-container \.ProseMirror[\s,{:]/)
    }
  })

  it('is the order main.ts loads them, because that is the order the browser concatenates', () => {
    const main = read('main.ts')
    const imports = [...main.matchAll(/^import\s+'([^']+)'$/gm)].map((m) => m[1])
    const positions = RENDERED_SHEETS.map((f) => imports.indexOf(`./${f}`))
    expect(positions, 'every sheet of the rendered pane must be imported by main.ts').not.toContain(-1)
    expect(positions, `${RENDERED_SHEETS.join(' then ')}, as main.ts loads them`).toEqual(
      [...positions].sort((a, b) => a - b),
    )
  })
})

describe('the editor body scale', () => {
  it('reads the base size from --app-body-size in both panes', () => {
    for (const [pane, text] of [['rendered', rendered()], ['source', read(SOURCE)]] as const) {
      expect(text, `${pane}: a literal here is the bug the user reported`).toMatch(
        /font-size:\s*var\(--app-body-size\)/,
      )
    }
  })

  it('reads the leading from --app-line-height in both panes', () => {
    // Managed separately from the size, per the user's request: same size does
    // not mean same leading, and the two are tuned by different criteria.
    for (const [pane, text] of [['rendered', rendered()], ['source', read(SOURCE)]] as const) {
      expect(text, `${pane}: leading must be the token, not a number`).toMatch(
        /line-height:\s*var\(--app-line-height\)/,
      )
    }
  })

  it('sets the source pane base on the editor and its scroller, not in the theme', () => {
    const css = read(SOURCE)
    expect(block(css, /\.cm-editor\)\s*\{([^}]*)\}/, SOURCE)).toMatch(/var\(--app-body-size\)/)
    expect(block(css, /\.cm-scroller\)\s*\{([^}]*)\}/, SOURCE)).toMatch(/var\(--app-line-height\)/)
  })

  it('keeps the base size and leading out of the CodeMirror theme', () => {
    // This is the regression, exactly: a JS theme wins the cascade in practice
    // and is invisible to every CSS-level check, so the number can come back
    // here without any stylesheet appearing to change.
    const theme = read(THEME)
    const base = block(theme, /'&':\s*\{([^}]*)\}/, THEME)
    const scroller = block(theme, /'\.cm-scroller':\s*\{([^}]*)\}/, THEME)
    expect(base, "the editor's base size belongs to the stylesheet").not.toMatch(/fontSize/)
    expect(scroller, 'the leading belongs to the stylesheet').not.toMatch(/lineHeight/)
  })

  it('keeps the source pane monospace and the rendered pane in the body face', () => {
    // The other half of the request, and the half a careless unification would
    // take away: one SIZE across the panes, two faces. Markdown source that is
    // not monospace is not a source view.
    //
    // Stated as "the BASE face of each pane", not "the pane contains no mono":
    // the rendered pane legitimately sets --app-mono-font on inline code, pre
    // and table cells. An earlier draft of this test asserted the stronger,
    // wrong thing and failed on correct code — which is the failure mode this
    // whole programme keeps paying for, caught here by running it.
    const theme = read(THEME)
    expect(block(theme, /'\.cm-scroller':\s*\{([^}]*)\}/, THEME)).toMatch(
      /fontFamily:\s*'var\(--app-mono-font\)'/,
    )
    expect(
      block(rendered(), /\.editor-container \.ProseMirror\s*\{([^}]*)\}/, 'the rendered pane'),
      'the rendered body follows the editor face; its code is a deliberate exception',
    ).toMatch(/font-family:\s*var\(--app-editor-font\)/)
  })
})
