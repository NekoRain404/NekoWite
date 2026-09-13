import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, './tokens.css'), 'utf8')

const REQUIRED = ['--app-canvas', '--app-panel', '--app-elevated', '--app-border', '--app-text', '--app-muted', '--app-accent', '--app-accent-soft', '--app-accent-contrast', '--app-danger', '--app-danger-contrast', '--app-ease', '--app-radius', '--app-radius-md']

// 只取主 dark 块（[data-theme="dark"] 后紧跟 { 的那个），避免
// [data-theme="dark"][data-accent="ink"] 等 accent 子块造成假阳性。
const DARK_BLOCK = css.match(/\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] ?? ''
const LIGHT_BLOCK = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? ''

const SRC_DIR = resolve(__dirname, '..')

/** 能承载样式的源文件：.vue 的 <style> 块、.css、以及拼 CSS 字符串的 .ts
 *  （编辑器装饰、导出 HTML）。排除测试文件——它们把 token 名当字符串引用，
 *  并不随应用发布，混进来会让“已定义”集合出现假阳性。 */
function styleSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...styleSources(full))
    else if (/\.(vue|css|ts)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

/** 一个块里某个 token 的原始值（可能是 var() 别名）。 */
function rawToken(block: string, token: string): string | undefined {
  return new RegExp(`${token}:\\s*([^;]+);`).exec(block)?.[1]?.trim()
}

/** 解析一层 var() 别名后的像素值：`--app-radius-md: var(--app-radius)` 也算数。 */
function pxIn(block: string, token: string): number {
  const raw = rawToken(block, token)
  if (raw === undefined) throw new Error(`${token} is not declared in this block`)
  const alias = /^var\((--app-[a-z0-9-]+)\)$/.exec(raw)
  const value = alias ? rawToken(block, alias[1]) ?? '' : raw
  return Number(value.replace('px', ''))
}

const ACCENTS = ['ink', 'coral', 'blue', 'green', 'gold', 'violet', 'slate', 'teal', 'lime', 'rose', 'amber', 'orange', 'pink', 'cyan', 'cocoa']

const COLOR_SCHEMES = ['default', 'sunset', 'forest', 'ocean', 'sakura', 'mist', 'graphite', 'midnight', 'lavender', 'desert', 'mint', 'coffee', 'plum', 'dusk', 'crimson']

describe('tokens.css', () => {
  it('defines all semantic tokens in light (:root) and dark ([data-theme=dark])', () => {
    for (const t of REQUIRED) {
      expect(LIGHT_BLOCK, `${t} in light`).toContain(`${t}:`)
      expect(DARK_BLOCK, `${t} in dark`).toContain(`${t}:`)
    }
  })
  it('defines every accent variation', () => {
    for (const a of ACCENTS) {
      expect(css).toContain(`[data-accent="${a}"]`)
    }
  })
  it('resolves the dark mode for ink and every derived accent', () => {
    // ink gets its own dark block; the rest derive via the combined rule.
    expect(css).toContain('[data-theme="dark"][data-accent="ink"]')
    expect(css).toContain('[data-theme="dark"][data-accent]:not([data-accent="ink"])')
    expect(css).toMatch(/color-mix\(in srgb, var\(--app-accent\) 25%, var\(--app-panel\)\)/)
  })
  it('declares the motion scale once, outside every theme block', () => {
    // Motion is not a theme. A dark-mode user, or one who swaps the accent or
    // the colour scheme, must get exactly the same rhythm — so the ladder lives
    // in :root and no theme block may restate it. The scale itself is pinned in
    // motion.test.ts; this only guards where it is allowed to be declared.
    const ladder = ['--app-motion-micro', '--app-motion-fast', '--app-motion', '--app-motion-slow']
    for (const t of ladder) {
      expect(LIGHT_BLOCK, `${t} in :root`).toContain(`${t}:`)
    }
    for (const block of css.matchAll(/\[data-theme="dark"\]\s*\{([^}]*)\}/g)) {
      expect(block[1], 'dark mode must not redefine the motion ladder').not.toMatch(
        /--app-motion[\w-]*:/,
      )
    }
    for (const s of COLOR_SCHEMES) {
      const block = css.match(new RegExp(`\\[data-color-scheme="${s}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? ''
      expect(block, `${s} palette must not redefine motion`).not.toMatch(/--app-motion[\w-]*:/)
    }
  })
  it('defines every --app-* token the app reads, so no var() silently resolves to nothing', () => {
    // 一个读不到定义的 var() 不会报错，它只是让整条声明失效：写在
    // border-radius 上就变成 0（圆角应用里冒出直角），写在 color 上就整条被
    // 丢掉。--app-radius-md 和 --app-text-muted 都这样悄悄失效过，所以这里
    // 逐个检查全仓（组件 <style>、样式表、拼 CSS 的 .ts）的读取点：只有带
    // 兜底值的 var(--app-x, …) 才允许没有定义。
    const defined = new Set<string>()
    const reads: { token: string; file: string }[] = []
    for (const file of [resolve(__dirname, './tokens.css'), ...styleSources(SRC_DIR)]) {
      const text = readFileSync(file, 'utf8')
      // 定义可能写成 CSS 声明，也可能写成 AppShell 那种内联样式对象的键。
      for (const m of text.matchAll(/(--app-[a-z0-9-]+)['"]?\s*:/g)) defined.add(m[1])
      for (const m of text.matchAll(/var\(\s*(--app-[a-z0-9-]+)\s*([,)])/g)) {
        if (m[2] === ',') continue
        reads.push({ token: m[1], file: file.slice(SRC_DIR.length + 1) })
      }
    }
    const unresolved = reads
      .filter((r) => !defined.has(r.token))
      .map((r) => `${r.token} — ${r.file}`)
    expect(unresolved, 'tokens read with neither a definition nor a fallback').toEqual([])
  })
  it('keeps --app-radius-md as the middle rung of the radius ladder', () => {
    // 阶梯见 tokens.css 的注释：window 16 > dialog 14 > menu/card 10 >
    // button/input 8 > segmented 6 > inline-code 5。md 就是其中的 8，浮层读它
    // 却一直没有这一级，于是拿到 0。
    for (const [name, block] of [['light', LIGHT_BLOCK], ['dark', DARK_BLOCK]] as const) {
      expect(block, `${name} theme must declare --app-radius-md`).toContain('--app-radius-md:')
      const sm = pxIn(block, '--app-radius-sm')
      const md = pxIn(block, '--app-radius-md')
      const lg = pxIn(block, '--app-radius-lg')
      expect(md, `${name}: --app-radius-md sits between sm and lg`).toBeGreaterThan(sm)
      expect(md, `${name}: --app-radius-md sits between sm and lg`).toBeLessThan(lg)
    }
  })
  it('re-points the --app-text-muted alias wherever a theme re-points --app-muted', () => {
    // 自定义属性里的 var() 在“声明它的那个元素”上求值，然后按求值结果继承下去，
    // 所以把别名放在 :root 会冻住浅色值，dark/配色/高对比度下的重指向全部失效。
    // 别名因此必须和主题属性同处一个元素——AppShell 的壳根，也是每一套调色板
    // 重指向 --app-muted 的地方。
    const aliases = [...css.matchAll(/([^{}]+)\{([^{}]*--app-text-muted\s*:[^{}]*)\}/g)]
    expect(aliases, '--app-text-muted is declared exactly once').toHaveLength(1)
    expect(aliases[0][1], 'the alias lives on the theme scope, not in :root').toContain('[data-theme')
    expect(aliases[0][2]).toMatch(/--app-text-muted:\s*var\(--app-muted\)/)
    expect(LIGHT_BLOCK, ':root would freeze the alias to the light value').not.toContain('--app-text-muted')
    expect(DARK_BLOCK, 'the dark block would freeze it again').not.toContain('--app-text-muted')
  })
  it('sets color-scheme per theme so native controls follow', () => {
    expect(LIGHT_BLOCK).toContain('color-scheme: light')
    expect(DARK_BLOCK).toContain('color-scheme: dark')
  })
  it('does not rely on a dead html[data-theme] selector', () => {
    const styles = readFileSync(resolve(__dirname, '../style.css'), 'utf8')
    expect(styles).not.toMatch(/html\[data-theme/);
  })
  it('defines complete color-scheme palettes', () => {
    const paletteTokens = [
      '--app-canvas:',
      '--app-panel:',
      '--app-elevated:',
      '--app-border:',
      '--app-text:',
      '--app-muted:',
      '--app-code-keyword:',
      '--app-code-string:',
      '--app-code-number:',
      '--app-code-fn:',
      '--app-code-type:',
      '--app-code-prop:',
      '--app-danger:',
      '--app-danger-contrast:',
      '--app-success:',
      '--app-shadow-menu:',
      '--app-shadow-dialog:',
      '--app-shadow-card:',
    ]
    for (const s of COLOR_SCHEMES) {
      const block = css.match(new RegExp(`\\[data-color-scheme="${s}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? ''
      for (const token of paletteTokens) {
        expect(block, `${s} palette ${token}`).toContain(token)
      }
    }
  })
})
