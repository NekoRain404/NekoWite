import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, './tokens.css'), 'utf8')

const REQUIRED = ['--app-canvas', '--app-panel', '--app-elevated', '--app-border', '--app-text', '--app-muted', '--app-accent', '--app-accent-soft', '--app-accent-contrast', '--app-danger', '--app-danger-contrast', '--app-warn', '--app-ease', '--app-radius', '--app-radius-md']

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

/** 这次对比度修复没有授权的文件：两个分栏滚动文件和一个拼 CSS 字符串的 service。
   它们里面的 muted 淡化仍然低于 AA（浅色下 2.78-3.87:1），作为已知例外记录在案，
   而不是被当成正确——名单写死在这里，想加一个进来必须改这行测试。 */
const OUT_OF_FOOTPRINT = ['view/SourcePane.vue', 'ui/EditorPane.vue', 'services/cmSourceView.ts']

const ACCENTS = ['ink', 'coral', 'blue', 'green', 'gold', 'violet', 'slate', 'teal', 'lime', 'rose', 'amber', 'orange', 'pink', 'cyan', 'cocoa']

const COLOR_SCHEMES = ['default', 'sunset', 'forest', 'ocean', 'sakura', 'mist', 'graphite', 'midnight', 'lavender', 'desert', 'mint', 'coffee', 'plum', 'dusk', 'crimson']

/* ---------- WCAG contrast, recomputed from the token values ----------
   颜色不是口味问题，是可以算的：给了背景色和前景色，比值就是确定的数字。
   这两条断言存在，是因为 --app-muted 曾在浅色面板上只有 3.15:1、十五个主题色
   里只有 ink/slate/cocoa 的白字够 4.5:1（琥珀 2.72:1），而当时的测试全绿——
   对比度没有任何检查在看。这里把性质钉住：改调色板或改主题色，数字掉下 AA 就红。 */

/** sRGB 通道 -> 线性光（WCAG 2.x 相对亮度）。 */
function toLinear(channel: number): number {
  const s = channel / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** #rgb / #rrggbb -> 0..255 三通道。 */
function channels(color: string): [number, number, number] {
  const h = color.replace('#', '')
  const wide = h.length === 3 ? h.replace(/./g, (c) => c + c) : h
  return [0, 2, 4].map((i) => parseInt(wide.slice(i, i + 2), 16)) as [number, number, number]
}

function luminance(color: string): number {
  const [r, g, b] = channels(color).map(toLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.x 对比度，1..21。4.5:1 是正文 AA；这些 token 都用在 10-13px 上，
   够不着“大号文字 3:1”的豁免，所以一律按 4.5 要求。 */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** sRGB -> HSL 色相角（0..360）。状态色的明度可以随主题走，语义只挂在色相上，
   所以“这是警告不是错误”唯一能算的判据就是它离红有多远。 */
function hue(color: string): number {
  const [r, g, b] = channels(color).map((c) => c / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return 0
  const raw = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (raw * 60 + 360) % 360
}

/** AppShell 恒定的四个属性：theme 是生效后的 light/dark，color-scheme 恒有值，
    contrast 是 high/normal。一个组合就是一次真实的渲染场景。 */
interface Scenario {
  theme: 'light' | 'dark'
  scheme: string
  accent: string
  highContrast: boolean
}

/** 去掉注释再切规则：注释块紧挨着选择器，不剥掉的话会被当成选择器的一部分。 */
const CLEAN = css.replace(/\/\*[\s\S]*?\*\//g, '')
const RULES = [...CLEAN.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].trim(),
  body: m[2],
}))

function matchesSelector(selector: string, s: Scenario): boolean {
  // 全文件唯一的 :not() 规则只声明 --app-accent-soft，没有断言读它。
  if (selector.includes(':not(')) return false
  if (selector === ':root') return true
  const attrs = selector.match(/\[[^\]]+\]/g)
  if (!attrs || attrs.join('') !== selector) return false
  return attrs.every((attr) => {
    const m = /^\[data-([a-z-]+)(?:="([^"]*)")?\]$/.exec(attr)
    if (!m) return false
    const present =
      m[1] === 'theme' ? s.theme
      : m[1] === 'color-scheme' ? s.scheme
      : m[1] === 'accent' ? s.accent
      : m[1] === 'contrast' ? (s.highContrast ? 'high' : 'normal')
      : undefined
    return m[2] === undefined ? present !== undefined : present === m[2]
  })
}

/** 和浏览器同款的取值顺序：选择器更具体的赢，一样具体则后写的赢。 */
function specificity(selector: string): number {
  return selector === ':root' ? 1 : (selector.match(/\[/g) ?? []).length
}

function resolveToken(s: Scenario, name: string): string {
  let best: { spec: number; order: number; value: string } | undefined
  RULES.forEach((rule, order) => {
    if (!matchesSelector(rule.selector, s)) return
    const value = rawToken(rule.body, name)
    if (value === undefined) return
    const spec = specificity(rule.selector)
    if (!best || spec > best.spec || (spec === best.spec && order > best.order)) {
      best = { spec, order, value }
    }
  })
  if (!best) throw new Error(`${name} is not declared for ${JSON.stringify(s)}`)
  return best.value
}

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
  it('keeps --app-warn a warning, not a second danger', () => {
    // 警告和错误只差色相：danger 是红（~5°），warn 是琥珀（~36°）。钉色相而不是钉
    // 某个 hex，是因为明度本来就该随主题走（深色底上的琥珀要提亮才看得见），而“这
    // 不是错误”的语义只挂在色相上——把 warn 并成 danger 的别名，插件被禁的提示就
    // 和真出错了看起来是同一件事，这正是这次要避免的清理。
    for (const theme of ['light', 'dark'] as const) {
      const s: Scenario = { theme, scheme: 'default', accent: 'ink', highContrast: false }
      const warn = hue(resolveToken(s, '--app-warn'))
      const danger = hue(resolveToken(s, '--app-danger'))
      expect(warn, `${theme}: --app-warn sits in the amber band`).toBeGreaterThanOrEqual(25)
      expect(warn, `${theme}: --app-warn sits in the amber band`).toBeLessThanOrEqual(60)
      expect(
        Math.abs(warn - danger),
        `${theme}: --app-warn must stay distinguishable from --app-danger`,
      ).toBeGreaterThan(15)
    }
  })
  it('reads --app-warn without a hardcoded fallback', () => {
    // 这条 token 曾经一个定义都没有：唯一读它的声明带着裸 hex 兜底，于是浏览器永远
    // 渲染兜底值，主题、配色和高对比度对它的重指向全是死代码，而且不报错——兜底把
    // “token 没定义”变成了静默降级。所以读它的地方不许再自带第二个值；同时它也得
    // 真的还有人在读，否则这条断言会空转。
    const reads: { file: string; fallback: boolean }[] = []
    for (const file of styleSources(SRC_DIR)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/var\(\s*--app-warn\s*([,)])/g)) {
        reads.push({ file: file.slice(SRC_DIR.length + 1), fallback: m[1] === ',' })
      }
    }
    expect(reads.length, 'nothing reads --app-warn any more').toBeGreaterThan(0)
    expect(
      reads.filter((r) => r.fallback).map((r) => r.file),
      'a fallback silently outranks every theme value',
    ).toEqual([])
  })
  it('keeps --app-warn above the non-text contrast floor on every surface', () => {
    // 它画的是“插件不可用”那条 2px 左边框，属于 WCAG 1.4.11 的非文本对比度：3:1 是
    // 底线（正文的 4.5 不适用于边框）。四个主题场景都要过——warn 没有自己的高对比度
    // 声明，高对比度下拿到的是 light/dark 的值，那也必须还看得见。
    const SURFACES = ['--app-canvas', '--app-panel', '--app-elevated']
    for (const theme of ['light', 'dark'] as const) {
      for (const highContrast of [false, true]) {
        const s: Scenario = { theme, scheme: 'default', accent: 'ink', highContrast }
        const where = `${theme}${highContrast ? '/high-contrast' : ''}`
        for (const surface of SURFACES) {
          expect(
            contrast(resolveToken(s, '--app-warn'), resolveToken(s, surface)),
            `--app-warn on ${surface} (${where})`,
          ).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })
  it('never fades --app-muted where it is text', () => {
    // --app-muted 已经把 AA 用满，再和透明混一次，合成出来的颜色就掉回 2.5:1
    // 上下。这不是 token 能兜住的：要让浅色面板上 82% 的它够到 4.5:1，它本身得
    // 深到 7:1，那种深灰已经不是次级文字了。所以规则落在声明上——muted 只能整条
    // 用；允许往 muted 里混（它在少数派），不允许从它往外混。
    const offenders: string[] = []
    for (const file of styleSources(SRC_DIR)) {
      const name = file.slice(SRC_DIR.length + 1)
      if (OUT_OF_FOOTPRINT.includes(name)) continue
      const dimmedMuted = /(?<![-\w])color:\s*color-mix\(\s*in srgb,\s*var\(--app-muted\)/g
      for (const m of readFileSync(file, 'utf8').matchAll(dimmedMuted)) {
        offenders.push(`${name}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
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
  it('keeps --app-muted at WCAG AA on every surface it is drawn on', () => {
    // 次级文字（分区标题、时间戳、提示、占位符）全部读这个 token，所以它自己
    // 必须在最差的那块背景上也过 4.5:1。任何组件再用 color-mix 把它调淡一点，
    // 就是在把这条保证退回去——那条规则由 components 侧的“只读原文”检查守着。
    const SURFACES = ['--app-canvas', '--app-panel', '--app-elevated']
    for (const theme of ['light', 'dark'] as const) {
      for (const scheme of COLOR_SCHEMES) {
        for (const highContrast of [false, true]) {
          const s: Scenario = { theme, scheme, accent: 'ink', highContrast }
          const where = `${theme}/${scheme}${highContrast ? '/high-contrast' : ''}`
          const muted = resolveToken(s, '--app-muted')
          for (const surface of SURFACES) {
            expect(
              contrast(muted, resolveToken(s, surface)),
              `--app-muted on ${surface} (${where})`,
            ).toBeGreaterThanOrEqual(4.5)
          }
        }
      }
    }
  })
  it('pairs every accent with a foreground that reaches WCAG AA', () => {
    // 主题色本身是用户选的，不能为了白字好看去动它——能动的是配它的那个前景色。
    // 浅色主题色都是中间调，所以多数主题色配墨黑、少数深主题色（ink/slate/cocoa）
    // 配白，每个主题色各自定，而不是统一一个白字。
    for (const theme of ['light', 'dark'] as const) {
      for (const accent of ACCENTS) {
        for (const highContrast of [false, true]) {
          const s: Scenario = { theme, scheme: 'default', accent, highContrast }
          const where = `${accent} (${theme}${highContrast ? '/high-contrast' : ''})`
          expect(
            contrast(resolveToken(s, '--app-accent-contrast'), resolveToken(s, '--app-accent')),
            `--app-accent-contrast on --app-accent for ${where}`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
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
