# NekoWite v1.3 导出（HTML + PDF）Design

- 日期：2026-08-29
- 状态：已确认
- 前置：v1.0+v1.1+v1.2 已合并至 master；编辑器含 math（MathLive/KaTeX 可复用）、cite（`[@key]` 编号）、mdx 组件节点

## 1. 目标

将当前文档导出为**自包含 HTML 文件**或**PDF**，导出内容包含渲染后的数学公式、引用编号 + 参考文献列表、MDX 内置组件外观，文件长什么样、导出就什么样（所见即所得）。

- **HTML**：单文件 `.html`，内联 CSS + KaTeX 渲染的数学，自包含可分享。
- **PDF**：生成同一 HTML → 调浏览器/WebView 打印对话框 → 另存为 PDF。复用同一渲染路径。

## 2. 技术选型

| 项 | 选型 | 理由 |
|---|---|---|
| mdast → HTML | 自写渲染器（遍历 mdast，输出 HTML 字符串） | 精确控制 math/cite/mdx 节点输出；复用重心 |
| remark 变换 | 抽取 `citeRemark`/`mdxJsxRemark` 的 transform 为**纯 remark 插件函数**，编辑器（`$remark`）与导出管道共用 | 保证「所见即所得」：导出看到的就是编辑器解析的同一棵 mdast |
| 数学渲染 | **KaTeX**（`katex.renderToString` + `katex/dist/katex.min.css` 内联） | 静态、自包含、打印级质量；编辑用 MathLive 不变（导出为一次性离线渲染） |
| 引用编号 | 复用 `computeCiteOrder` 语义：按文档首现顺序 `[1][2]…` | 与编辑器 chip、ReferencesPanel 编号规则一致 |
| PDF | HTML → `window.print()`（Tauri WebView 打印对话框） | 零额外依赖，所见即所得；用户选「保存为 PDF」 |

## 3. 核心设计

### 3.1 可复用 remark 变换抽取（editor-core）

现状：`cite/remark.ts` 的 `citeRemark` 与 `mdx/remark.ts` 的 `mdxJsxRemark` 都是 `$remark`（Milkdown 插件），导出管道（纯 unified）无法复用。

**改造**：把变换逻辑（`splitCite`/`transform`、mdx 的 `transform`/`tryMergeComponent`）提炼为**纯 remark 插件函数**（`(tree, file) => void`），如：
- `packages/editor-core/src/cite/remark.ts` 导出 `citeMdast(tree, file)`（纯函数）+ `citeRemark = $remark('citeRemark', () => citeMdast)`。
- `packages/editor-core/src/mdx/remark.ts` 导出 `mdxJsxMdast(tree, file)` + `mdxJsxRemark = $remark('mdxJsxRemark', () => mdxJsxMdast)`。

导出管道只用 `citeMdast` / `mdxJsxMdast`，行为与编辑器一致。现有 `$remark` 包装保持对 Milkdown 的兼容。

### 3.2 导出管道（editor-core `export/`）

`renderDocument(markdown: string, opts: RenderOptions): string`：

```ts
interface RenderDocumentOptions<TId = string> {
  title?: string
  refs?: Map<string, Reference>      // 引用库（app 传入）
  componentRenderers?: Record<string, (props: Record<string,string>, childrenHtml: string) => string>
                                       // 内置组件 → 静态 HTML（app 层注入）
  math?: 'katex' | 'text'             // 默认 katex；缺失时降级纯文本 latex
  includeCss?: boolean                // 嵌入排版 CSS（默认 true）
}
```

流程：`unified` + remarkParse + remarkGfm + remarkFrontmatter + `citeMdast` + `mdxJsxMdast` + remarkMath
→ mdast → 自定义 html renderer → 完整 HTML 文档字符串（`<!DOCTYPE html>`，内联 CSS）。

**html renderer 要点**（按节点类型）：
- 常规节点：heading/paragraph/list/blockquote/strong/em/code/inlineCode/link/image/thematicBreak/frontmatter/yaml 等 → 语义化 HTML。
- 原始 `html` 节点：导出侧将其转义为可见文本（XSS 安全默认），与编辑器「渲染为真实 HTML」有意的行为差异，见 §3.2 html.ts 注释。
- `inlineMath`/`displayMath`：KaTeX `renderToString(value, { displayMode })`；若 KaTeX 不可用 → 输出 `<span class="math-latex">$…$</span>` 降级。
- `nekoCite`：`[n]`（n 由首现顺序编号，opts.refs 查找不到仍编号但标注「(未找到)」）。
- `mdxJsxFlowElement`：若 `componentRenderers[name]` 存在 → 调它（存名/attrs/childrenHtml）；否则输出中性占位（如 `<div class="mdx-fallback">…源码…</div>`）。
- 表格：`<table><thead><tbody>` 语义化。
- YAML frontmatter：渲染为一个 meta 区块（标题用 frontmatter.title 作 `<title>`）。

**引用统计**：renderer 内部先扫描一次 mdast 收集 `[@key]` 顺序 → 生成编号表 → 文末插入「参考文献」章节（ol 列表：`[n] key — title (authors, year)`；无 refs 时只列 key）。

### 3.3 app 层导出服务（desktop `services/export.ts`）

- `exportHtml(source: string, savePath: string, opts): Promise<void>`：调 `renderDocument` → 写文件（复用 fsService.write / save dialog）。
- `exportToPdf(source: string, opts): Promise<void>`：调 `renderDocument` → 打开一个隐藏 iframe/新窗口加载生成的 HTML → `window.print()`。用户选打印机/「另存为 PDF」。（Tauri WebView 的 print 对话框即是系统打印，标准做法。）
- 组件渲染器注入：`buildComponentRenderers()` —— 遍历 registry 注册的组件，用 `@vue/server-renderer`（`renderToString`）把 Vue 组件渲染为静态 HTML（Callout → `<aside class="callout">…</aside>`）。若 SSR 不可用/抛错 → 降级为非渲染节点。

> 说明：Vue server-renderer 在主进程 WebView 内可用（`@vue/server-renderer` 是 Vue 官方包，纯 JS）。若集成复杂度过高，v1.3 可先只支持**内置白名单组件**（Callout 等已知组件），第三方组件导出为占位/源码——写入计划时再定。

### 3.4 UI 入口（desktop）

- 设置面板（SettingsPanel）内增「导出」区：**导出 HTML** / **导出 PDF** 两个按钮（作用于当前 active tab）。
- 导出文件名：`{basename}.html` / `{basename}.pdf`，经保存对话框选路径（`open_folder_dialog` 扩展或复用保存对话框命令）。

## 4. 实现范围（v1.3）

1. editor-core：抽取 `citeMdast`/`mdxJsxMdast` 纯函数（编辑器 `$remark` 保持兼容）。
2. editor-core：`export/renderDocument`（html renderer 全节点覆盖 + KaTeX + cite 编号 + mdx 组件 + 参考文献）。
3. desktop：`exportHtml`/`exportToPdf` 服务 + 组件 SSR 渲染器注入 + 保存对话框。
4. UI：SettingsPanel 导出按钮（导出 HTML / PDF）。
5. 依赖：`katex`（editor-core）、`@vue/server-renderer`（desktop）。

## 5. 范围红线（v1.3 不做）

- 不导出 DOCX/Word（规格明确只做 PDF+HTML）。
- 不导出参考文献为独立 `.bib`/CSL 文件。
- 不做导出主题/样式自定义（固定一套印刷 CSS）。
- 不嵌入图片资产为 base64（外链/本地路径原样保留；不做资源内联）。
- PDF 不做静默文件生成（必须经打印对话框，用户可控）。

## 6. 测试策略

- **editor-core（vitest）**：`renderDocument` 对 heading/list/table/link/code/frontmatter 输出正确 HTML；inlineMath/displayMath 走 KaTeX（mock 或真实 KaTeX）输出 `<span class="katex">`；`[@a][@b][@a]` 编号 1,2,1 + 文末参考文献；mdx 组件经 componentRenderers 注入输出；无 refs 降级。
- **desktop（vitest）**：`buildComponentRenderers` 对 Callout 输出包含 class 的静态 HTML；导出服务调 fsService.write（mock）写入正确内容。
- **E2E/手动**：导出 HTML → 浏览器打开渲染正确（公式/引用/表格）；导出 PDF → 打印对话框出现。

## 7. 依赖

- `katex`（editor-core，运行时）
- `@vue/server-renderer`（desktop，运行时；与 vue 版本一致）
- 无 Rust 侧新依赖。