import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
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
 * uselessness is worse than no test.
 *
 * What this cannot see: a later rule overriding these. This is a source-level
 * check and it is honest about it — it catches the literal coming back, which is
 * the regression that actually happened. Layout is the e2e suite's job. */

const SRC = resolve(__dirname, '..')
const read = (path: string): string => readFileSync(resolve(SRC, path), 'utf8')

const RENDERED = 'styles/editor-content.css'
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

describe('the editor body scale', () => {
  it('reads the base size from --app-body-size in both panes', () => {
    for (const [pane, file] of [['rendered', RENDERED], ['source', SOURCE]] as const) {
      expect(read(file), `${pane}: a literal here is the bug the user reported`).toMatch(
        /font-size:\s*var\(--app-body-size\)/,
      )
    }
  })

  it('reads the leading from --app-line-height in both panes', () => {
    // Managed separately from the size, per the user's request: same size does
    // not mean same leading, and the two are tuned by different criteria.
    for (const [pane, file] of [['rendered', RENDERED], ['source', SOURCE]] as const) {
      expect(read(file), `${pane}: leading must be the token, not a number`).toMatch(
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
      block(read(RENDERED), /\.editor-container \.ProseMirror\s*\{([^}]*)\}/, RENDERED),
      'the rendered body follows the editor face; its code is a deliberate exception',
    ).toMatch(/font-family:\s*var\(--app-editor-font\)/)
  })
})
