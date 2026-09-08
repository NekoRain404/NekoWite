# NekoWite UI 优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 NekoWite 界面从默认样式提升为设计系统驱动（CSS 变量 token + data-* 多主题 + 变体组件），浅/深/跟随系统 + 7 种强调色 + 外观设置即改即用。纯 UI 层，功能零改动。

**Architecture:** 新增 `styles/tokens.css`（全部语义色/强调色/字体/动效 token，浅深两套）与 `styles/components.css`（按钮/输入/面板/弹窗/工具栏变体）。新 Pinia `appearance` store（theme/accent/字号/行高，localStorage 持久化，system→matchMedia）。`App.vue` 跟节点绑定 `data-theme/data-accent`。各 UI 组件接入变体 class 并统一边框/圆角/间距/hover，TabBar 脏点升级为三态保存指示。设置面板新增「外观」区。

**Tech Stack:** Vue 3 + scoped CSS + 纯 CSS 变量；Pinia；vitest。无新运行时依赖。

## Global Constraints

- **纯 UI 层：不得改动任何功能逻辑**——editor-core / plugin-host / Rust / 节点 / 序列化 / 插件 / 数学 / 引用 / 导出 / AI / 浮动 / 生命周期全部不触碰。只改 `apps/desktop/src` 下的样式、组件模板 class、`stores/appearance.ts`（新）、`services/appearance.ts` 若需要。
- 不引入 Tailwind / CVA / 新依赖。
- TypeScript strict；无 unused；无中文代码注释（UI 文案可以中文）；英文 commit message。
- 全 202 个 JS 测试 + E2E 2/2 必须保持绿。
- pnpm 命令需 `PNPM_STORE_DIR=/tmp/pnpm-store-test/v11` 或 `--store-dir`。
- 深色模式标签禁写死颜色（全部走 token）；`color-scheme` 随 `data-theme` 切换。
- 现有 scoped CSS 逐步迁移到 token 化 class；同一视觉元素只保留一套 class（`.btn`/`.input`/`.panel` 等），不在组件内重复硬编码颜色。

---

### Task 1: 设计 token 体系（tokens.css）+ 基底样式

**Files:**
- Create: `apps/desktop/src/styles/tokens.css`
- Modify: `apps/desktop/src/style.css`（重写基底：去 Vite 居中/白字/宽幅，改全屏应用布局 + 语义色）
- Modify: `apps/desktop/src/main.ts`（import tokens.css）
- Create: `apps/desktop/src/styles/tokens.test.ts`（token 完整性断言）

**Interfaces:**
- Produces（Task 2-7 依赖）：
  - 语义色变量（浅深各一套）：`--app-canvas/panel/elevated/border/text/muted/accent/accent-soft/accent-contrast/danger`
  - 7 个 `[data-accent=...]` 选择器定义 `--app-accent/--app-accent-soft`
  - `--app-ease`/`--app-motion-fast`/`--app-radius`/`--app-font`/`--app-mono-font`/`--app-body-size`/`--app-line-height`/代码高亮 6 色（浅深）
  - 字体抗锯齿、`color-scheme` 切换

- [ ] **Step 1: 写失败测试（token 完整性）**

`apps/desktop/src/styles/tokens.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, './tokens.css'), 'utf8')

const REQUIRED = ['--app-canvas', '--app-panel', '--app-elevated', '--app-border', '--app-text', '--app-muted', '--app-accent', '--app-accent-soft', '--app-accent-contrast', '--app-danger', '--app-ease', '--app-radius']

describe('tokens.css', () => {
  it('defines all semantic tokens in light (:root) and dark ([data-theme=dark])', () => {
    for (const t of REQUIRED) {
      expect(css).toMatch(new RegExp(`:root[^{]*\\{[^}]*${t}:`), `${t} in light`)
      expect(css).toMatch(new RegExp(`\\[data-theme="dark"\\][^{]*\\{[^}]*${t}:`), `${t} in dark`)
    }
  })
  it('defines all 7 accent variations', () => {
    for (const a of ['ink', 'coral', 'blue', 'green', 'gold', 'violet', 'slate']) {
      expect(css).toContain(`[data-accent="${a}"]`)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @nekowite/desktop test`
Expected: FAIL——文件不存在。

- [ ] **Step 3: 实现 tokens.css（照 spec §3.1，参考 Memoir tokens.css）**

`apps/desktop/src/styles/tokens.css`：

```css
@import 'math-dialog.css' 不需要——已是独立文件，main.ts 已 import。

:root {
  color-scheme: light;
  --app-canvas: #fbfaf6;
  --app-panel: #f5f3ee;
  --app-elevated: #fffefb;
  --app-border: #e7e3db;
  --app-text: #292a27;
  --app-muted: #8c8982;
  --app-accent: #343532;
  --app-accent-soft: #e7e5df;
  --app-accent-contrast: #ffffff;
  --app-danger: #c94c41;
  --app-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --app-motion-fast: 140ms;
  --app-radius: 8px;
  --app-font: Inter, "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --app-mono-font: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
  --app-body-size: 15px;
  --app-line-height: 1.8;
  --app-code-keyword: #8a4e30;
  --app-code-string: #2d7a56;
  --app-code-number: #b56a16;
  --app-code-fn: #3d5f8f;
  --app-code-type: #6a548f;
  --app-code-prop: #5c6848;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  font-family: var(--app-font);
}

[data-theme="dark"] {
  color-scheme: dark;
  --app-canvas: #171714;
  --app-panel: #1d1d1a;
  --app-elevated: #24241f;
  --app-border: #37362f;
  --app-text: #f0eee8;
  --app-muted: #a5a198;
  --app-accent: #efede7;
  --app-accent-soft: #393832;
  --app-accent-contrast: #171715;
  --app-danger: #ef766b;
  --app-code-keyword: #e0a57a;
  --app-code-string: #86c4a4;
  --app-code-number: #e0b36a;
  --app-code-fn: #8fb0dd;
  --app-code-type: #b7a3dd;
  --app-code-prop: #b3c49a;
}

[data-accent="ink"] { --app-accent: #343532; --app-accent-soft: #e7e5df; }
[data-theme="dark"][data-accent="ink"] { --app-accent: #efede7; --app-accent-soft: #393832; }
[data-accent="coral"] { --app-accent: #d65f4d; --app-accent-soft: #f6e3de; }
[data-accent="blue"] { --app-accent: #3f7edb; --app-accent-soft: #e7effb; }
[data-accent="green"] { --app-accent: #3e9b73; --app-accent-soft: #e5f3ed; }
[data-accent="gold"] { --app-accent: #b98b09; --app-accent-soft: #f8f0d6; }
[data-accent="violet"] { --app-accent: #8a65d1; --app-accent-soft: #eee8f9; }
[data-accent="slate"] { --app-accent: #607287; --app-accent-soft: #e9edf1; }
[data-theme="dark"][data-accent]:not([data-accent="ink"]) {
  --app-accent-soft: color-mix(in srgb, var(--app-accent) 25%, var(--app-panel));
}
```

> 注意：tokens.css 需要被 `main.ts` import；`math-dialog.css` 保持独立 import 不动。

- [ ] **Step 4: 重写 style.css 基底**

`apps/desktop/src/style.css` 删除 Vite 默认的居中/`max-width:1280`/`#app padding`，改为：

```css
* { box-sizing: border-box; }
html, body, #app { margin: 0; padding: 0; height: 100%; width: 100%; }
body { font-family: var(--app-font); font-size: var(--app-body-size); line-height: var(--app-line-height); }
html[data-theme="dark"] { color-scheme: dark; }
/* 滚动条 */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--app-border) 120%, transparent); border-radius: 999px; border: 2px solid transparent; background-clip: content-box; }
::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--app-muted) 60%, transparent); background-clip: content-box; }
```

（`App.vue` 已自带 shell 布局样式，Task 4 迁移到 token；style.css 只做全局基底。）

- [ ] **Step 5: main.ts import tokens.css + 跑测试**

`apps/desktop/src/main.ts` 顶部或样式区加 `import './styles/tokens.css'`（与既有 `import './style.css'` 并列；`math-dialog.css` 保持原样）。

Run: `pnpm --filter @nekowite/desktop test`（新 token 测试绿）→ typecheck/lint → `pnpm -r test` 不回归。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/styles apps/desktop/src/main.ts apps/desktop/src/style.css
git commit -m "style(desktop): add design tokens and app base styles"
```

---

### Task 2: appearance store（主题/强调色/字号/行高，持久化 + 跟随系统）

**Files:**
- Create: `apps/desktop/src/stores/appearance.ts`
- Create: `apps/desktop/src/stores/appearance.test.ts`

**Interfaces:**
- Consumes: 无（纯 Pinia + localStorage）。
- Produces（Task 4/7 依赖）：
  - `type Theme = 'light' | 'dark' | 'system'`
  - `type Accent = 'ink' | 'coral' | 'blue' | 'green' | 'gold' | 'violet' | 'slate'`
  - `useAppearanceStore()`：`theme: Ref<Theme>`、`accent: Ref<Accent>`、`bodyFontSize: Ref<number>`、`lineHeight: Ref<number>`、`effectiveTheme: () => 'light'|'dark'`（system 时按 matchMedia 返回实际）
  - `setTheme(t)` / `setAccent(a)` / `setBodyFontSize(n)` / `setLineHeight(n)`
  - localStorage 持久化（key `nekowite.appearance`），读取时容错默认

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/stores/appearance.test.ts`（happy-dom 有 matchMedia？——用 `globalThis.matchMedia` mock 或 jsdom 提供；vitest happy-dom 需手动 stub `window.matchMedia`）：

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAppearanceStore } from './appearance'

// happy-dom 无 matchMedia，stub
const matchMediaMock = vi.fn(() => ({
  matches: false, media: '(prefers-color-scheme: dark)',
  onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
}))

describe('useAppearanceStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    globalThis.matchMedia = matchMediaMock as never
  })

  it('defaults to system theme and ink accent', () => {
    const s = useAppearanceStore()
    expect(s.theme).toBe('system')
    expect(s.accent).toBe('ink')
    expect(s.effectiveTheme()).toBe('light') // matches=false
  })

  it('persists theme and accent to localStorage', () => {
    const s = useAppearanceStore()
    s.setTheme('dark')
    s.setAccent('coral')
    const saved = JSON.parse(localStorage.getItem('nekowite.appearance') ?? '{}')
    expect(saved.theme).toBe('dark')
    expect(saved.accent).toBe('coral')
  })

  it('restores from localStorage on next load', () => {
    localStorage.setItem('nekowite.appearance', JSON.stringify({ theme: 'dark', accent: 'blue' }))
    const s = useAppearanceStore()
    expect(s.theme).toBe('dark')
    expect(s.accent).toBe('blue')
  })

  it('effectiveTheme follows dark media query when system', () => {
    matchMediaMock.mockReturnValue({ ...matchMediaMock(), matches: true })
    const s = useAppearanceStore()
    expect(s.effectiveTheme()).toBe('dark')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**
Run: `pnpm --filter @nekowite/desktop test` → FAIL。

- [ ] **Step 3: 实现 appearance.ts**

按 spec §3.2 与测试实现。`effectiveTheme()` 在 `theme==='light'/'dark'` 直接返回，`system` 用 `window.matchMedia('(prefers-color-scheme: dark)').matches`。持久化写 `nekowite.appearance`，读取 JSON 容错（parse 失败回默认）。

- [ ] **Step 4: 跑测试 + Commit**
```bash
pnpm --filter @nekowite/desktop test
git add apps/desktop/src/stores
git commit -m "feat(desktop): add appearance store with theme/accent persistence"
```

---

### Task 3: 变体组件样式（components.css）+ 基础复用

**Files:**
- Create: `apps/desktop/src/styles/components.css`
- Modify: `apps/desktop/src/main.ts`（import components.css）
- Modify（本轮只落样式+测试，不接组件）：无（接入在 Task 5/6）

**Interfaces:**
- Produces（Task 5-7 用 .btn/.input/.panel/.chip/.toolbar-btn/.dialog 等）：
  - `.btn` + 变体 `.btn-primary/.btn-secondary/.btn-ghost/.btn-danger` × `.btn-sm/.btn-md/.btn-icon`
  - `.input`（文本输入，focus 高亮）
  - `.panel`、`.panel-header`、`.panel-title`
  - `.toolbar-btn`（图标/文字小按钮，active 态 `.is-active`）
  - `.chip`/`.tag`
  - `.dialog-overlay`/`.dialog`/`.dialog-actions`
  - `.switch-option`（三态按钮组选项）+ `.is-active`
  - `.focus-ring`（`focus-visible: outline` 环）
  - `.save-dot`（三态点，Task 6 用）

- [ ] **Step 1: 写失败测试（components.css 存在性 + 关键 class 声明）**

`apps/desktop/src/styles/components.test.ts`：

```ts
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
```

> 若你需要在 components.css 里放少量允许的 hex（如纯黑/白 inset highlight `rgb(255 255 255 / .42)`），把断言放宽为「除 rgb()/color-mix() 外无裸 hex」并在 report 说明。

- [ ] **Step 2: 跑测试确认失败**
Run: `pnpm --filter @nekowite/desktop test` → FAIL（文件不存在 + 断言 false）。

- [ ] **Step 3: 实现 components.css**
按 spec §3.3，全部按钮/输入/面板/弹窗/工具栏/保存点/开关选项，全部用 var(--app-*)。所有都有 hover（`color-mix` 明暗）、active、`focus-visible` 环、`transition: Xms var(--app-ease)`。

- [ ] **Step 4: main.ts import + 跑测试 + Commit**
```bash
pnpm --filter @nekowite/desktop test
git add apps/desktop/src/styles apps/desktop/src/main.ts
git commit -m "style(desktop): add component variant styles on design tokens"
```

---

### Task 4: App.vue 根绑定 + 主题驱动 + header 毛玻璃

**Files:**
- Modify: `apps/desktop/src/App.vue`（根组件 `data-theme/data-accent` 绑定、header 毛玻璃、去默认样式）
- Modify: `apps/desktop/src/main.ts`（可选：启动时确保 data 属性初始）

**Interfaces:**
- Consumes: `useAppearanceStore`（Task 2，`effectiveTheme`）。
- Produces: 根 `<div class="shell">` 上的 `:data-theme="effectiveTheme()"` 与 `:data-accent="accent"`（响应式）；header 语义化/microfrost；body 背景用 token。

- [ ] **Step 1: 写失败测试（App 绑定逻辑可测部分）**

组件/绑定用 happy-dom 组件测试较脆；改为在 store 层已覆盖（Task 2 的 effectiveTheme）。本轮测试：一个「App 渲染时根元素带 data 属性」的组件测试 `apps/desktop/src/App.appearance.test.ts`（挂载 App 后 `document.querySelector('.shell')?.dataset` 断言 theme/accent）——若 happy-dom 下 App 挂载依赖 Tauri invoke（loadVaultPlugins/fs），用 `vi.mock('@tauri-apps/api/core')` 等 `invoke` 返回空；或用最小化「能挂载且根有 data 属性」的断言。若太脆，降级为「绑定由 store 驱动已验证 + App.vue 模板审查」并在 report 记录。**优先尝试组件测试，失败则注明。**

- [ ] **Step 2: 实现**
- `App.vue` script：`const appearance = useAppearanceStore()`；`const theme = computed(() => appearance.effectiveTheme())`；template 根 `<div class="shell" :data-theme="theme" :data-accent="appearance.accent">`。
- `echo` system 跟随：store 内 `effectiveTheme` 每次调用现算（响应式依赖 `theme`/`system` + 操作系统变化无需实时——`watch` matchMedia 触发重新计算即可，v1 可只每次渲染算，或加一个 `watch(() => appearance.theme, ...)` + matchMedia listener 手动 bump）。**推荐**：App 挂载时注册 `matchMedia('(prefers-color-scheme: dark)')` 的 `change` 监听，变化时 `appearance.touchSystem()`（一个递增的 `systemRevision` ref），`effectiveTheme` 依赖它 → 响应式自动跟。
- header 改为毛玻璃：`.shell-header { background: color-mix(in srgb, var(--app-elevated) 68%, var(--app-canvas)); backdrop-filter: blur(14px); }`；border 用 `--app-border`；文字用 `--app-text`；标题/设置按钮用组件变体 class。
- 核心区域背景：`.shell`/`.main` 用 `var(--app-canvas)`；侧栏/面板用 `var(--app-panel)`。

- [ ] **Step 3: 跑测试 + Commit**
`pnpm --filter @nekowite/desktop test`、typecheck、lint；`pnpm dev` 手动看一眼（若可）。提交 `"feat(desktop): bind theme/accent at app root with glass header"`。

---

### Task 5: 工具栏/开关/设置面板接入变体

**Files:**
- Modify: `apps/desktop/src/components/WordToolbar.vue`（按钮 → `.toolbar-btn`/`.btn`）
- Modify: `apps/desktop/src/view/ViewSwitch.vue`（三态 → `.switch-option`/`.is-active`）
- Modify: `apps/desktop/src/components/FloatToolbar.vue`（→ `.btn`）
- Modify: `apps/desktop/src/components/AppToast.vue`（→ token）
- Modify: `apps/desktop/src/ui/StatusBar.vue`（→ token）
- Modify: `apps/desktop/src/components/ConflictDialog.vue`（→ `.dialog-overlay`/`.dialog`/`.btn`）
- Modify: `apps/desktop/src/math-dialog.css`（→ 对齐 token 命名或补充 `.dialog` 复用）

**Interfaces:**
- Consumes: components.css 变体（Task 3）。
- Produces: 这些组件视觉统一到 token 体系。

- [ ] **Step 1: 逐组件替换 class + 清理 scoped 硬编码色**
对每个文件：模板 class 换成 tokens 变体（`.toolbar-btn`/`.btn btn-secondary`/`.switch-option`/`.dialog-overlay .dialog` 等），删除 scoped 里硬编码 hex/border 或改为 `var(--app-*)`。保留：布局尺寸、交互逻辑、事件绑定不变。

- [ ] **Step 2: 跑测试 + 手动**
- `pnpm --filter @nekowite/desktop test`（既有组件测试仍绿——WordToolbar/FloatToolbar/GhostWriter 等有测试，class 变化不应破坏行为断言）。
- `pnpm dev` 手动确认观感。不可用则记录。

- [ ] **Step 3: Commit**
```bash
git add apps/desktop/src/components apps/desktop/src/view apps/desktop/src/ui apps/desktop/src/math-dialog.css
git commit -m "style(desktop): migrate toolbar, switcher, dialogs, and overlays to variant tokens"
```

---

### Task 6: 侧栏/标签/列表 + 保存三态点

**Files:**
- Modify: `apps/desktop/src/ui/FileTree.vue`
- Modify: `apps/desktop/src/ui/RefSidebar.vue`
- Modify: `apps/desktop/src/ui/ReferencesPanel.vue`
- Modify: `apps/desktop/src/ui/TabBar.vue`（保存三态点）
- Modify: `apps/desktop/src/ui/SettingsPanel.vue`（外观区在 Task 7）
- Modify: `apps/desktop/src/store...` 无

**Interfaces:**
- Consumes: components.css；TabBar 三态点 -> Task 需在 tabs store 暴露 `saveState`（`saved|dirty|saving`），**最小改动**：`saveActive` 内 saving 时短暂置标（或用本地 ref）。**约束：不加自动保存逻辑**，仅指示。
- Produces: 统一列表项观感（padding/hover/激活态/缩进），TabBar 三态点。

- [ ] **Step 1: 列表类组件标准化**
FileTree/RefSidebar/ReferencesPanel：行项统一 `.list-item`/`.is-active`/hover、图标与文字色用 token；文件树缩进/箭头统一。TabBar：`.tab` active 用 elevated + border，`.tab-dirty` 替换为 `.save-dot`。

- [ ] **Step 2: TabBar 三态保存点**
- tabs store（**仅指示**）：`const savingIds = ref<Set<string>>(new Set())`、`markSaving(id)`/`markSaved(id)`；`saveActive` 成功前后调（`markSaving(t.id)` → write → `markSaved(t.id)`，失败仍 clear）。加测试：`saveActive` 过程中 `saveStateOf(id)` 为 saving，结束为 saved。
- TabBar 渲染 `.save-dot[data-state="saved|dirty|saving"]`（saved 隐藏或淡绿小点；dirty 红，saving 动画）。
- CSS 在 components.css（Task 3 已含 `.save-dot`，本轮补齐 data-state 三态 + pulse 动画）。

- [ ] **Step 3: 跑测试 + Commit**
`pnpm -r test` 全绿；`git commit -m "style(desktop): normalize list/tab surfaces and add three-state save indicator"`。

---

### Task 7: 设置面板「外观」区 + 即时生效

**Files:**
- Modify: `apps/desktop/src/ui/SettingsPanel.vue`（新增外观区）
- Modify: `apps/desktop/src/main.ts`（可选：初始 data 属性）

**Interfaces:**
- Consumes: `useAppearanceStore`；components.css `.switch-option`/`.btn`/`.input`。
- Produces: 外观设置 UI——主题（浅/深/跟随系统）、强调色（7 色 swatch）、字号/行高（步进输入），改动即写 store + 持久化。

- [ ] **Step 1: 写失败测试（store 侧联动已覆盖 Task 2；本轮 UI 部分若可单测则加）**
外观区主要是 UI 转发，逻辑在 store。若加组件测试太脆，记录「手测」；至少确保 `SettingsPanel` 现有可能的测试仍绿。

- [ ] **Step 2: 实现外观区**
- `.settings-section` 内加「外观」：主题 3 个 `.switch-option`（浅/深/跟随系统）；强调色 7 个 swatch（用小色圆 `.accent-swatch[style="--swatch: var(--app-accent)"]` + 名称，点击 `setAccent`）；字号 `input[type=number]` 或 `+/-` 步进（`setBodyFontSize`），行高同理。
- 所有控件绑定 store；组件 `App.vue` 根 `data-*` 已实时响应（Task 4）。
- swatch 样式放 components.css 或 SettingsPanel scoped（用 token）。

- [ ] **Step 3: 手动验证 + 回归 + Commit**
`pnpm dev`：改主题/强调色即改即用、持久化后重启保留。全量 `pnpm -r test`。`git commit -m "feat(desktop): add appearance settings (theme, accent, typography)"`。

---

### Task 8: 全量回归 + 视觉冒烟（收尾）

**Files:**
- Run: `pnpm -r test`（202 全量 + 新增 token/appearance/store 测试）、`pnpm typecheck`、`pnpm lint`、`pnpm --filter @nekowite/desktop build`、E2E（`pnpm test:e2e`）。
- 视觉冒烟（若可 launch）：浅/深/7 色切换、保存三态点、工具栏/对话框/侧栏观感；截图对比前后。若不可 launch，记录「待手动验证」精确清单。
- Commit（若有修复）。

---

## Self-Review

**Spec 覆盖：**
- token 体系（浅深 + 7 accent + 字体/动效/代码高亮）→ Task 1 ✅
- appearance store（theme/accent/字号/行高/持久化/跟随系统）→ Task 2 ✅
- 变体组件样式 → Task 3 ✅
- 根绑定 + 毛玻璃 + 去默认 → Task 4 ✅
- 工具栏/对话框/开关/占位接入 → Task 5 ✅
- 侧栏/标签/列表 + 保存三态点 → Task 6 ✅
- 设置面板外观区 → Task 7 ✅
- 回归 + 冒烟 → Task 8 ✅
- 红线（纯 UI、无新依赖、深色导出不处理、无自动保存）→ 未实现 ✅

**占位符：** 无 TBD；两处「若 UI 挂载测试太脆则降级」给了明确判定与记录要求；`@media` 跟随系统用 `systemRevision` bump 方案明确。✅

**类型一致性：**
- `useAppearanceStore` 的 `theme/accent/effectiveTheme/setTheme/setAccent/touchSystem`（Task 2）→ Task 4/7 消费 ✅
- components.css 的 `.btn/.input/.panel/.toolbar-btn/.switch-option/.save-dot/.dialog-overlay/.dialog`（Task 3）→ Task 5/6/7 消费 ✅
- `saveStateOf/markSaving/markSaved`（Task 6 tabs store）→ TabBar 消费 ✅