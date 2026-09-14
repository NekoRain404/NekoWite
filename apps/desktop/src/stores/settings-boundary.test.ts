import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const APP = resolve(__dirname, '../..')
/** The one file allowed to hold a factory: the store that runs them. */
const OWNER = resolve(__dirname, './settings.ts')
const ROOTS = [join(APP, 'src'), join(APP, 'e2e')].filter(existsSync)

/**
 * The slice factories, by name.
 *
 * The scan is over the bare name rather than over import statements on
 * purpose. A named import is the likely shape, but
 * `import * as settings from …` reaches the same function one property access
 * later and an import-shaped pattern would not see it.
 */
const FACTORY = /\bcreate[A-Za-z]*Settings\b/g

/** The slice that declares one. `export function createAiSettings()` is the
 *  definition, not a reach for it. */
const DECLARATION = /\bfunction\s+$/

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.(ts|vue)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Comments are dropped for the same reason `i18n.test.ts` drops them: a name
 *  in prose is not a call. Both patterns are anchored to the start of a line —
 *  an unanchored opener would swallow the code up to the next closer, which is
 *  the trap that file's own note describes. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('the settings store boundary', () => {
  it('only stores/settings.ts holds a slice factory', () => {
    // The barrel re-exports the four factories, so they are reachable —
    // `export *` re-exports everything a slice exports, and hand-enumerating
    // fifteen re-exports instead would need re-editing for every new constant.
    // What must not happen is a second *holder*: each factory builds its own
    // refs and its own watchers, so a caller outside the store gets a second
    // set of them writing the same localStorage keys, and the two silently
    // disagree the moment either is written. The barrel's header says so; this
    // is the half that enforces it.
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        if (resolve(file) === OWNER) continue
        const code = codeOf(file)
        for (const m of code.matchAll(FACTORY)) {
          if (DECLARATION.test(code.slice(0, m.index ?? 0))) continue
          offenders.push(`${relative(APP, file)}: ${m[0]}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
