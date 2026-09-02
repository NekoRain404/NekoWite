import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, './components.css'), 'utf8')
const NEEDED = ['.btn-primary', '.btn-secondary', '.btn-ghost', '.btn-danger', '.btn-sm', '.btn-md', '.btn-icon', '.input', '.panel', '.toolbar-btn', '.save-dot', '.dialog-overlay', '.dialog', '.switch-option', ".focus-ring" ]

describe('components.css', () => {
  it('defines required variant classes', () => {
    for (const c of NEEDED) expect(css).toContain(c)
  })
  it('uses tokens not hardcoded palette', () => {
    // 应引用 var(--app-*)，不直接出现旧 #e0e0e0 / #f5f5f5 等散装灰
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,6}/g) // 除 color-mix/transparent 外不得有裸 hex
    expect(css).toContain('var(--app-accent)')
  })
})
