import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, './tokens.css'), 'utf8')

const REQUIRED = ['--app-canvas', '--app-panel', '--app-elevated', '--app-border', '--app-text', '--app-muted', '--app-accent', '--app-accent-soft', '--app-accent-contrast', '--app-danger', '--app-danger-contrast', '--app-ease', '--app-radius']

// 只取主 dark 块（[data-theme="dark"] 后紧跟 { 的那个），避免
// [data-theme="dark"][data-accent="ink"] 等 accent 子块造成假阳性。
const DARK_BLOCK = css.match(/\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] ?? ''
const LIGHT_BLOCK = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? ''

describe('tokens.css', () => {
  it('defines all semantic tokens in light (:root) and dark ([data-theme=dark])', () => {
    for (const t of REQUIRED) {
      expect(LIGHT_BLOCK, `${t} in light`).toContain(`${t}:`)
      expect(DARK_BLOCK, `${t} in dark`).toContain(`${t}:`)
    }
  })
  it('defines all 7 accent variations', () => {
    for (const a of ['ink', 'coral', 'blue', 'green', 'gold', 'violet', 'slate']) {
      expect(css).toContain(`[data-accent="${a}"]`)
    }
  })
  it('sets color-scheme per theme so native controls follow', () => {
    expect(LIGHT_BLOCK).toContain('color-scheme: light')
    expect(DARK_BLOCK).toContain('color-scheme: dark')
  })
  it('does not rely on a dead html[data-theme] selector', () => {
    const styles = readFileSync(resolve(__dirname, '../style.css'), 'utf8')
    expect(styles).not.toMatch(/html\[data-theme/);
  })
})
