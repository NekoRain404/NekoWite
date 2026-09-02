import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, './tokens.css'), 'utf8')

const REQUIRED = ['--app-canvas', '--app-panel', '--app-elevated', '--app-border', '--app-text', '--app-muted', '--app-accent', '--app-accent-soft', '--app-accent-contrast', '--app-danger', '--app-ease', '--app-radius']

describe('tokens.css', () => {
  it('defines all semantic tokens in light (:root) and dark ([data-theme=dark])', () => {
    for (const t of REQUIRED) {
      expect(css, `${t} in light`).toMatch(new RegExp(`:root[^{]*\\{[^}]*${t}:`))
      expect(css, `${t} in dark`).toMatch(new RegExp(`\\[data-theme="dark"\\][^{]*\\{[^}]*${t}:`))
    }
  })
  it('defines all 7 accent variations', () => {
    for (const a of ['ink', 'coral', 'blue', 'green', 'gold', 'violet', 'slate']) {
      expect(css).toContain(`[data-accent="${a}"]`)
    }
  })
})
