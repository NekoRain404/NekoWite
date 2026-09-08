# NekoWite UI 优化 Design

- 日期：2026-09-02
- 状态：已确认
- 前置：v1.0–v1.6 全部完成并合入 master；项目 1.0.0，202 个 JS 测试全绿

## 1. 目标

将 NekoWite 的界面从「Vite 模板默认」提升为精致、统一、可主题化的桌面编辑器 UI —— 参考 Memoir 的设计系统：CSS 变量语义 token + data-* 属性驱动的多主题 + 变体化组件。**纯 UI 层改造，不动任何功能逻辑。**

## 2. 技术路线与约束

- **不引入 Tailwind / CVA 等新运行时依赖**：保持 Vue 3 + scoped CSS，用 **CSS 变量设计 token + data-* 属性**，与现有代码风格同构。
- 改动集中在 `apps/desktop/src`（样式 + 组件 class + 一个 appearance store），**不触碰** editor-core / plugin-host / Rust / 任何功能逻辑（节点、序列化、插件、数学、引用、导出、AI、浮动、生命周期）。
- 全部 202 个 JS 测试 + 既有 E2E 必须保持绿。

## 3. 核心设计

### 3.1 设计 token 体系（`apps/desktop/src/styles/tokens.css`）

语义色分层（参考 Memoir）：
- `canvas / panel / elevated / border / text / muted / accent / accent-soft / accent-contrast / danger`
- `:root`（浅色）与 `[data-theme="dark"]`（深色）各定义一套
- 7 种强调色 `[data-accent="ink|coral|blue|green|gold|violet|slate"]`，各自定义 `--app-accent` / `--app-accent-soft`，深色下 accent-soft 用 `color-mix` 自适应
- 字体栈：`Inter, "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, ...`；`-webkit-font-smoothing: antialiased`
- 动效：`--app-ease: cubic-bezier(0.22, 1, 0.36, 1)`、`--app-motion: 160ms`
- 尺寸 token：`--app-radius: 8px`、行高、字号变量
- 代码高亮色（浅/深各一套）：keyword/string/number/fn/type/prop

### 3.2 主题驱动（data-* + appearance store）

- 新 Pinia store `apps/desktop/src/stores/appearance.ts`：`theme: 'light'|'dark'|'system'`、`accent: 'ink'|'coral'|'blue'|'green'|'gold'|'violet'|'slate'`（默认 ink）、`bodyFontSize: number`（默认 15）、`lineHeight: number`（默认 1.8）、`density: 'comfortable'|'compact'`（可选，v1 可只落数据不改排布，标注「生效待完善」）
- localStorage 持久化（key `nekowite.appearance`）
- `App.vue` 根节点绑定 `:data-theme` / `:data-accent`；`theme === 'system'` 时监听 `matchMedia('(prefers-color-scheme: dark)')`
- 跟随系统：`useMatchMedia` 或 store 内监听

### 3.3 变体化组件样式（`apps/desktop/src/styles/components.css`）

统一 class 变体（作用于各 vue 组件模板，不引入新组件包装）：
- `.btn`：primary / secondary / ghost / danger × md / sm / icon；含 hover/active 过渡、`focus-visible` 焦点环、disabled 态
- `.input`：文本框（vault 路径、设置输入、搜索框）统一边框/聚焦
- `.panel`：侧栏/设置面板/浮层表面语义
- `.chip` / `.tag`：标签（文件类型、状态）
- `.dialog-overlay` / `.dialog`：弹窗蒙层 + 卡片（ConflictDialog、数学弹窗复用）
- `.toolbar-btn` / `.tb-sep`：工具栏按钮变体（WordToolbar、ViewSwitch、FloatToolbar 复用）
- `.focus-ring`：非鼠标焦点时的可见性环

### 3.4 布局打磨

- `App.vue`：header 毛玻璃（`backdrop-filter: blur(14px)`）+ elevated 语义色；去掉 Vite 默认居中/`max-width`/白字
- StatusBar / TabBar / FileTree / RefSidebar / ReferencesPanel：统一边框、圆角、间距、缩进、hover 态、滚动条
- **保存状态指示（TabBar 新增）**：脏标记升级为 `.save-dot` 三态——`saved`（绿）/ `dirty`（红）/ `saving`（accent 脉冲动画）；与现有保存流程联动（dirty 已有，saving 用 saveActive 生命周期补状态——**需在功能层最小加一个 saving 状态标志**，属「接线条目」，不改保存逻辑本身）
- `ProseMirror` 内容区排版：行高、段落间距、代码块背景（可选，标注）

### 3.5 设置面板「外观」区

- 主题切换：浅色 / 深色 / 跟随系统（SegmentedControl 风格按钮组）
- 强调色：7 色 swatch 单选（色圆点 + 名称）
- 字号 / 行高：数字输入或步进
- 改动即时生效（绑定 appearance store），持久化

## 4. 实现范围（本 spec）

1. `styles/tokens.css`（全部 token）
2. `styles/components.css`（组件变体）
3. `stores/appearance.ts` + 测试（初始/持久化/切换/跟随系统）
4. `App.vue` 根绑定 + header 毛玻璃 + 去默认样式
5. 各 UI 组件接入变体 class：WordToolbar / ViewSwitch / SettingsPanel / FileTree / RefSidebar / ReferencesPanel / TabBar（含保存三态点）/ StatusBar / AppToast / ConflictDialog / FloatToolbar / EditorPane / SourcePane / RenderedPane
6. 设置面板「外观」区 UI + 接线

## 5. 范围红线（不做）

- 不改任何功能逻辑 / 编辑器内核 / Rust / 导出渲染
- 不动 MDX 组件渲染样式（Callout 等已 work，仅可由 token 间接影响）
- 不引入第三方 UI 库 / 构建依赖
- 深色模式下的打印/导出 CSS 不做适配（导出保持独立浅色）
- Auto-save/自动保存不在本轮（保存状态点仅为指示，不新增自动保存逻辑）

## 6. 测试策略

- **appearance store 单测**：默认值、localStorage 持久化往返、`theme/accent` 切换、`effectiveTheme()`（system→实际 light/dark）
- **token 完整性单测**：检查 tokens.css 中所有语义 token 在浅色与深色都定义（可写一个读取 CSS 文本的断言）
- **组件冒烟**：`pnpm dev` 手动——浅/深/7 色即时切换、保存三态点、统一按钮/输入观感
- **回归**：全 202 JS 测试 + E2E 2/2 保持绿