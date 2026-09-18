/**
 * The dialog's size is declared in one place, and it is not the stylesheet.
 *
 * **The defect this file exists for.** `.settings-dialog` carried
 * `width: min(720px, 100%); height: min(520px, 100%)`, which was one answer in one place and
 * correct for as long as nobody could change it. A drag makes the size *state*, and a size that is
 * state and also a stylesheet constant is the two-answers defect this repository spent two days
 * removing: the first drag writes an inline `width: 1040px`, this `min()` still caps the render at
 * 720, and the corner grip then sits 160px inside the corner it is supposed to be on. Nothing about
 * that failure is visible in a rendered tree or in jsdom — both sides of it are declarations — so
 * the reading is of the component's own source.
 *
 * **It is a file of its own so that it can be verified the way this programme verifies a fix.**
 * `verify-red-green.sh` copies the named test files into a worktree at the pre-fix commit and
 * asserts they fail there; a guard that shares a file with cases importing a module that did not
 * exist yet fails on *collection* instead, which is not red and proves nothing. On its own, this
 * file reddens against the commit before the drag for the right reason: `width: min(720px, 100%)`
 * is back in the rule, and the second case finds a `transition` that names a size.
 *
 * **Both cases are negative**, which is the other reason the reading is careful: a negative
 * assertion run against a file read as empty passes while checking nothing, so the read throws
 * rather than defaulting, and every scan runs against the source with its comments stripped — the
 * comment above the rule quotes the very declaration this file refuses, and a guard that counted it
 * would be indicted by its own explanation. `styles/components.test.ts` was written for that
 * identical hazard.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const path = resolve(__dirname, 'SettingsPanel.vue')
if (!existsSync(path)) throw new Error('SettingsPanel.vue is not where this guard looks for it')
const SOURCE = readFileSync(path, 'utf8')
/** The same text with its comments removed — see this file's header. */
const DECLARATIONS = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')

/** The `.settings-dialog` rule's own body, so the assertions are about this box and not a neighbour. */
function dialogRule(): string {
  expect(DECLARATIONS).toContain('.settings-dialog {')
  const from = DECLARATIONS.slice(DECLARATIONS.indexOf('.settings-dialog {'))
  return from.slice(0, from.indexOf('}'))
}

describe('the settings dialog declares its size once', () => {
  it('leaves the value to the model and keeps only the bound in the stylesheet', () => {
    const body = dialogRule()
    // The bound stays and is the same bound the drag clamps against: the overlay's content box.
    expect(body).toContain('max-width: 100%')
    expect(body).toContain('max-height: 100%')
    // The value does not. Both spellings a size could arrive in — the longhand and the shorthand.
    expect(body).not.toMatch(/(^|[;\s])width:/)
    expect(body).not.toMatch(/(^|[;\s])height:/)
    expect(body).not.toMatch(/(^|[;\s])inset:/)
    // And no pixel constant for this box anywhere in the file: 720 and 520 are the model's numbers
    // now, and a second copy here is the defect this case is for.
    expect(DECLARATIONS).not.toMatch(/min\(720px/)
    expect(DECLARATIONS).not.toMatch(/min\(520px/)
  })

  it('puts no transition on the dialog’s size, in either style block', () => {
    // Every `transition` the component declares, wherever it is: none of them may name a size or
    // the shorthand that would cover one. §7.3's 正文稳定 is strongest at a resize — an interpolated
    // one re-flows every line of text in the dialog for the length of the curve — and a `width` or
    // an `all` here is how that would arrive.
    const transitions = [...DECLARATIONS.matchAll(/transition:[^;]*;/g)].map((m) => m[0])
    expect(transitions.length).toBeGreaterThan(0)
    for (const rule of transitions) {
      expect(rule).not.toMatch(/\bwidth\b/)
      expect(rule).not.toMatch(/\bheight\b/)
      expect(rule).not.toMatch(/\ball\b/)
    }
  })
})
