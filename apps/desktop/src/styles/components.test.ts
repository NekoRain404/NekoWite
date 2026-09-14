import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 组件层的全部样式表，按 main.ts 的导入顺序。
 *
 * 这里原先是 `readFileSync` 一个路径，下面每条断言都读那一个字符串。这只在
 * 该层确实是一个文件时成立：把一层拆成两个表之后，**反向**断言（"不得出现裸
 * hex"、"不得有按主题写死的 .dialog 覆盖"）对着已经不含有那个选择器的那一半
 * 跑，会在什么都没检查的情况下通过。所以这层有一个列表，所有断言读它的拼接，
 * 而列表本身在下面被断言：非空、每个表都在磁盘上且非空、以及顺序与 main.ts 的
 * 导入顺序一致——浏览器就是按那个顺序拼接的。
 */
const SHEETS = ['./components.css', './surfaces.css'] as const

/** 把缺失的表读成空串，正是一条断言静默失效的方式，所以这里直接抛。 */
function sheet(file: string): string {
  const path = resolve(__dirname, file)
  if (!existsSync(path)) throw new Error(`${file} 列在组件层里，但文件不在`)
  return readFileSync(path, 'utf8')
}

/** 去掉注释再断言。`.dialog-overlay` 在 z-index 那段说明里被提到过，按原样读
    的话，把这个类整个改名之后断言仍然通过——类名出现在一句注释里，和它真的
    被声明过是两件事。tokens.test.ts 的同一条规则出于同样的原因也先剥注释。 */
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '')

const css = SHEETS.map((file) => strip(sheet(file))).join('\n')
const SRC_DIR = resolve(__dirname, '..')
const NEEDED = ['.btn-primary', '.btn-secondary', '.btn-ghost', '.btn-danger', '.btn-sm', '.btn-md', '.btn-icon', '.input', '.panel', '.toolbar-btn', '.save-dot', '.dialog-overlay', '.dialog', '.switch-option', ".focus-ring" ]

/**
 * 这个类至少作为**一个完整的类名**出现过，而不是恰好是别的类名的前缀。
 *
 * `css.includes('.panel')` 对 `.panelX { … }` 一样为真，于是把 `.panel {` 整个
 * 改名成别的、或者把这一块删掉，断言照样通过——一条比它的名字弱的断言。后面
 * 必须跟一个类名不能包含的字符，`.panel` 才算真的被声明过，`.panel` 与
 * `.panel-header` 也才分得清。 */
const declares = (text: string, name: string): boolean =>
  new RegExp(`${name.replace(/[.[\]\\]/g, '\\$&')}(?![\\w-])`).test(text)

/** 某个共享类的规则体。共享类只声明一次，取第一个匹配即可。
    找不到要抛而不是返回空串：返回空串会让每一条读它的断言对着空字符串通过。 */
function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`${selector} 在 ${SHEETS.join(' + ')} 里都没有声明`)
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

describe('组件层的样式表列表本身', () => {
  it('非空，且列出的每个表都真实存在、真的有规则', () => {
    // 空列表会让下面每一条断言都空转；一个被改名或清空的表会让读它的断言
    // 对着空串通过。列表本身必须先被检查，否则它只是一句没人核对的话。
    expect(SHEETS.length, 'a list with nothing in it makes every guard below vacuous').toBeGreaterThan(0)
    for (const file of SHEETS) {
      expect(sheet(file).replace(/\/\*[\s\S]*?\*\//g, '').trim(), `${file} 列在组件层里，却没有规则`).not.toBe('')
    }
  })

  it('每个表都真的承担了这个文件要检查的共享类', () => {
    // 这一条挡的是"拆完之后忘了把新表加进列表"——那个表的规则不在拼接里，
    // 而对它们的检查会全部变成 no-op。谁拥有哪个类是拆分的事；每个表都拥有
    // 至少一个是这个列表的事。
    for (const file of SHEETS) {
      const text = strip(sheet(file))
      const owned = NEEDED.filter((c) => declares(text, c))
      expect(owned, `${file} 在这个文件检查的全部共享类里一个都不承担`).not.toEqual([])
    }
  })

  it('顺序就是 main.ts 的导入顺序，因为浏览器就是按那个顺序拼接的', () => {
    // ruleBody 取第一个匹配、反向断言要覆盖全部拼接文本，两者都只在顺序与
    // 浏览器一致时才成立。main.ts 是顺序的唯一来源，所以对着它断言，而不是
    // 在两处各写一句注释——注释会和它自己走散，这个不会。
    const main = readFileSync(resolve(__dirname, '../main.ts'), 'utf8')
    const imports = [...main.matchAll(/^import\s+'([^']+)'$/gm)].map((m) => m[1])
    const positions = SHEETS.map((f) => imports.indexOf(`./styles/${f.replace('./', '')}`))
    expect(positions, '组件层的每个表都必须被 main.ts 导入').not.toContain(-1)
    expect(positions, `${SHEETS.join(' then ')}, as main.ts loads them`).toEqual(
      [...positions].sort((a, b) => a - b),
    )
  })
})

describe('components.css', () => {
  it('defines required variant classes', () => {
    // 按完整类名匹配：`.panelX` 不能算 `.panel` 声明过。
    const missing = NEEDED.filter((c) => !declares(css, c))
    expect(missing, '共享类名消失了，或者被改成了以它开头的另一个类名').toEqual([])
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
    // 下面两条是反向断言，所以先要求 .dialog 真的还在：ruleBody 会抛。
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
    // 约定写在组件层的 .dialog-actions 上：按钮从左到右是
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
