import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, './components.css'), 'utf8')
const SRC_DIR = resolve(__dirname, '..')
const NEEDED = ['.btn-primary', '.btn-secondary', '.btn-ghost', '.btn-danger', '.btn-sm', '.btn-md', '.btn-icon', '.input', '.panel', '.toolbar-btn', '.save-dot', '.dialog-overlay', '.dialog', '.switch-option', ".focus-ring" ]

/** 某个共享类的规则体。共享类只声明一次，取第一个匹配即可。 */
function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) return ''
  return css.slice(start, css.indexOf('}', start))
}

function vueFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...vueFiles(full))
    else if (entry.name.endsWith('.vue')) out.push(full)
  }
  return out
}

/** 模板里 .dialog-actions 一行内的按钮 class，按 DOM 顺序。 */
function actionRow(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const start = text.indexOf('class="dialog-actions"')
  if (start === -1) return []
  const end = text.indexOf('</div>', start)
  const block = text.slice(start, end === -1 ? text.length : end)
  return [...block.matchAll(/class="(btn[^"]*)"/g)].map((m) => m[1])
}

describe('components.css', () => {
  it('defines required variant classes', () => {
    for (const c of NEEDED) expect(css).toContain(c)
  })
  it('uses tokens not hardcoded palette', () => {
    // 应引用 var(--app-*)，不直接出现旧 #e0e0e0 / #f5f5f5 等散装灰
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,6}/g) // 除 color-mix/transparent 外不得有裸 hex
    expect(css).toContain('var(--app-accent)')
  })
  it('gives every dialog the same radius rung and elevation token', () => {
    // .dialog 曾经自带 8px 圆角和一条写死的阴影（再外加一条 [data-theme=dark]
    // 覆盖），于是 RenameDialog/TemplatePicker 比走“dialog 14”一级的 AI/插件提示
    // 看起来廉价一档。圆角与投影都改由 token 决定，逐主题手写的那条必须消失，
    // 否则它会盖掉 --app-shadow-dialog 里已经备好的 dark/高对比度/调色板值。
    const dialog = ruleBody('.dialog')
    expect(dialog).toContain('border-radius: var(--app-radius-xl)')
    expect(dialog).toContain('box-shadow: var(--app-shadow-dialog)')
    expect(css).not.toContain('[data-theme="dark"] .dialog {')
    expect(css).not.toMatch(/\.dialog[a-z-]*\s*\{[^}]*box-shadow:(?!\s*var\()/)
  })
  it('pairs the primary label with the on-accent token instead of a fixed white', () => {
    // 主题色是*背景*，不是文字色：按钮文字必须读 --app-accent-contrast——那是每个
    // 主题色各自算过对比度、单独选出来的那一个前景色。写死 white 的话，只有默认的
    // ink 还能看（12.3:1），换成琥珀就掉到 2.72:1，而这恰恰是默认主题掩盖掉的 bug。
    // 配对本身由 tokens.test.ts 的对比度断言保证，这里保证按钮用的就是这个配对。
    const primary = ruleBody('.btn-primary')
    expect(primary).toContain('background: var(--app-accent)')
    expect(primary).toContain('color: var(--app-accent-contrast)')
  })
  it('aligns the shared action row to the right, so the last button is the confirm slot', () => {
    expect(ruleBody('.dialog-actions')).toContain('justify-content: flex-end')
  })
  it('keeps the confirm slot for the affirmative action in every dialog', () => {
    // 约定写在 components.css 的 .dialog-actions 上：按钮从左到右是
    // [破坏性] [取消/中性] [确认]，最右边那一格是肌肉记忆当作“确认”的位置，
    // 只能放肯定动作；会丢弃数据的动作靠左，绝不许落在那里。
    const files = vueFiles(SRC_DIR).filter((f) => readFileSync(f, 'utf8').includes('class="dialog-actions"'))
    expect(files.length, 'dialogs sharing the action-row class').toBeGreaterThanOrEqual(5)
    for (const file of files) {
      const name = file.slice(SRC_DIR.length + 1)
      const row = actionRow(file)
      expect(row.length, `${name}: non-empty action row`).toBeGreaterThan(0)
      expect(row.filter((c) => c.includes('btn-primary')), `${name}: exactly one confirm`).toHaveLength(1)
      const last = row[row.length - 1]
      expect(last, `${name}: the affirmative owns the confirm slot`).toContain('btn-primary')
      expect(last, `${name}: a destructive action must never sit in the confirm slot`).not.toContain('btn-danger')
    }
  })
})
