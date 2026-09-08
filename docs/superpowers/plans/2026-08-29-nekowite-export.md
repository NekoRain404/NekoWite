# NekoWite v1.3 导出（HTML + PDF）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export the active document to a self-contained HTML file or a PDF via the browser print dialog — with rendered math (KaTeX), numbered citations + reference list, and MDX component appearance matching the editor.

**Architecture:** editor-core gains a pure mdast→HTML exporter (`export/renderDocument`) driven by the SAME remark transforms the editor uses (extract `citeMdast`/`mdxJsxMdast` as reusable pure functions so `$remark` plugins and the export pipeline share them). Math renders via KaTeX (`katex.renderToString`, inline CSS for self-containment); citations number by first-appearance order and emit a trailing reference list. The desktop layer adds `services/export.ts` (write HTML via fsService; PDF via `window.print()` on the generated HTML in a hidden iframe), a Rust `save_file_dialog` command, a whitelist component-renderer map, and SettingsPanel export buttons.

**Tech Stack:** `katex` (editor-core), existing remark/$remark infrastructure, `@tauri-apps/api` + `tauri-plugin-dialog` (desktop), Vue 3.

## Global Constraints

- editor-core gains exactly ONE new dependency: `katex`. desktop may add `@vue/server-renderer` ONLY if the whitelist map proves insufficient (spec §3.3 sanctions whitelist-only for v1.3).
- TypeScript strict; no unused vars/imports; no Chinese code comments (UI strings may be Chinese); English commit messages.
- Before committing: affected package test/typecheck/lint green; `pnpm -r test` (currently 105 JS + 3 Rust) must not regress.
- pnpm needs `PNPM_STORE_DIR=/tmp/pnpm-store-test/v11` or `--store-dir`.
- Do NOT modify the Milkdown `$remark` plugin behavior — extract pure functions and keep `$remark` wrapping them; existing cite/mdx tests must stay green unchanged.
- Do NOT change math/cite/mdx node serialization in the editor; export is a separate read-only path.
- CSS self-containment: prefer `import katexCss from 'katex/dist/katex.min.css?inline'` (Vite `?inline` string) so the exported HTML embeds KaTeX styles. If `?inline` fails in the desktop Vite build, fall back to a minimal built-in CSS constant and document it.

---

### Task 1: 抽取纯 remark 变换（citeMdast / mdxJsxMdast）

**Files:**
- Modify: `packages/editor-core/src/cite/remark.ts`
- Modify: `packages/editor-core/src/mdx/remark.ts`
- Modify: `packages/editor-core/src/cite/index.ts`（如需）
- Modify: `packages/editor-core/src/mdx/index.ts`（如需）

**Interfaces:**
- Consumes: existing `citeRemark`/`mdxJsxRemark` transform bodies.
- Produces (EXACT — Task 2 depends):
  - `citeMdast(tree: MdNode & { children: MdNode[] }, file: { value?: unknown }): void` —— 把 `citeRemark` 的 `$remark` 返回函数体（`(tree, file) => { root.children = transform(root.children) }`）提取为具名纯函数。
  - `mdxJsxMdast(tree: MdNode & { children: MdNode[] }, file: { value?: unknown }): void` —— 同理，把 mdx 的 `(tree, file) => { root.children = transform(root.children, file) }` 提取为具名纯函数。
  - 各自 `$remark` 改为 `$remark(name, () => citeMdast)` / `$remark(name, () => mdxJsxMdast)`（保持 Milkdown 行为逐字节一致）。
  - 从各 `index.ts` 导出纯函数（Task 2 从 `./cite` / `./mdx` 直接 import）。

- [ ] **Step 1: 写失败测试（纯函数可独立使用）**

在 `packages/editor-core/src/cite/remark.test.ts`（新建）：

```ts
import { describe, expect, it } from 'vitest'
import { citeMdast } from './remark'

describe('citeMdast (pure)', () => {
  it('splits [@key] out of a paragraph', () => {
    const tree: any = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'See [@a] and [@b].' }] }] }
    citeMdast(tree, { value: '' })
    const kids = tree.children[0].children
    expect(kids.some((n: any) => n.type === 'nekoCite' && n.value === '[@a]')).toBe(true)
    expect(kids.some((n: any) => n.type === 'nekoCite' && n.value === '[@b]')).toBe(true)
  })
})
```

`packages/editor-core/src/mdx/remark.test.ts`（新建）：

```ts
import { describe, expect, it } from 'vitest'
import { mdxJsxMdast } from './remark'

describe('mdxJsxMdast (pure)', () => {
  it('collapses whole-block component into mdxJsxFlowElement', () => {
    const tree: any = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'html', value: '<Callout>' }, { type: 'text', value: 'note' }, { type: 'html', value: '</Callout>' }] }],
    }
    mdxJsxMdast(tree, { value: '<Callout>\n\nnote\n\n</Callout>' })
    const kid = tree.children[0]
    expect(kid.type).toBe('mdxJsxFlowElement')
    expect(kid.value).toContain('Callout')
  })
})
```

> 若 `transform` 内部对 `file.value` 偏移的依赖使 `value: ''` 无法产出理想节点，测试用与实现一致的真实 source 字符串断言最终 mdast 形状——判定标准是「纯函数可独立调用且行为与 `$remark` 一致」。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @nekowite/editor-core test`
Expected: FAIL——`citeMdast`/`mdxJsxMdast` 未导出。

- [ ] **Step 3: 重构**

`packages/editor-core/src/cite/remark.ts`：把 `$remark` 回调里的返回函数体提到具名函数：

```ts
export function citeMdast(
  tree: MdNode & { children: MdNode[] },
  _file: { value?: unknown },
): void {
  tree.children = transform(tree.children)
}

export const citeRemark = $remark<'citeRemark', Record<string, unknown>>('citeRemark', () => citeMdast)
```

`packages/editor-core/src/mdx/remark.ts`：同理提取 `mdxJsxMdast(tree, file)`（函数体就是现在 `return (tree, file) => {...}` 的内容）。

各 `index.ts` 加导出（若 `export *` 已覆盖则无需改）。

- [ ] **Step 4: 跑测试**

Run: `pnpm --filter @nekowite/editor-core test`
Expected: 新纯函数测试 PASS；既有 62 个测试不回归（尤其 cite/mdx 的 editor 集成测试——验证 `$remark` 包装后行为逐字节一致）。

- [ ] **Step 5: Commit**

```bash
git add packages/editor-core
git commit -m "refactor(editor-core): extract pure cite and mdx remark transforms"
```

---

### Task 2: editor-core 导出渲染器 renderDocument

**Files:**
- Create: `packages/editor-core/src/export/html.ts`
- Create: `packages/editor-core/src/export/html.test.ts`
- Create: `packages/editor-core/src/export/index.ts`
- Modify: `packages/editor-core/src/index.ts`
- Modify: `packages/editor-core/package.json`（加 `katex`）

**Interfaces:**
- Consumes: `citeMdast` (Task 1), `mdxJsxMdast` (Task 1), remark-math (`inlineMath`/`displayMath` mdast types), `Reference`-like shape.
- Produces (EXACT — Task 3/4 depend):
  - `type ExportRef = { key: string; title?: string; authors?: string[]; year?: string }`
  - `type ComponentRenderer = (props: Record<string, string>, childrenHtml: string) => string`
  - `interface RenderDocumentOptions { title?: string; refs?: Map<string, ExportRef>; componentRenderers?: Record<string, ComponentRenderer>; math?: 'katex' | 'text'; includeCss?: boolean }`
  - `renderDocument(markdown: string, opts?: RenderDocumentOptions): string` —— 返回完整 `<!DOCTYPE html>` 文档字符串（内联 CSS，含 KaTeX CSS；`<title>` 取 opts.title 或 frontmatter.title；正文含渲染后的数学/引用/组件；文末参考文献章节）。

- [ ] **Step 1: 写失败测试**

`packages/editor-core/src/export/html.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { renderDocument } from './html'

describe('renderDocument', () => {
  it('renders headings, lists, links, code', () => {
    const html = renderDocument('# Title\n\n- a\n- b\n\n[link](https://x.dev)\n\n`code`\n')
    expect(html).toContain('<h1')
    expect(html).toContain('<li>')
    expect(html).toContain('href="https://x.dev"')
    expect(html).toContain('<code>')
  })

  it('renders katex math', () => {
    const html = renderDocument('Inline $E=mc^2$ and block:\n\n$$x^2$$\n')
    expect(html).toContain('katex')
  })

  it('numbers citations and appends reference list', () => {
    const refs = new Map<string, ExportRef>()
    refs.set('a', { key: 'a', title: 'Alpha', authors: ['Smith'], year: '2020' })
    refs.set('b', { key: 'b', title: 'Beta', authors: ['Doe'], year: '2021' })
    const html = renderDocument('See [@a] and [@b] and [@a].\n', { refs })
    expect(html).toContain('>1<')   // first [@a]
    expect(html).toContain('>2<')   // [@b]
    expect(html).toMatch(/参考文献/)
    expect(html).toContain('Alpha')
    expect(html).toContain('Beta')
  })

  it('renders mdx components via renderer map', () => {
    const renderers = { Callout: (props: Record<string, string>, childrenHtml: string) => `<aside class="callout callout-${props.type ?? 'info'}">${childrenHtml}</aside>` }
    const html = renderDocument('<Callout type="warn">Heads up</Callout>\n', { componentRenderers: renderers })
    expect(html).toContain('class="callout callout-warn"')
    expect(html).toContain('Heads up')
  })

  it('degrades math to latex when math=text', () => {
    const html = renderDocument('$E=mc^2$\n', { math: 'text' })
    expect(html).not.toContain('katex')
    expect(html).toContain('E=mc^2')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @nekowite/editor-core test`
Expected: FAIL——`renderDocument` 未定义。

- [ ] **Step 3: 实现 html.ts**

结构（示例，按实际 mdast 节点类型完整实现——heading/paragraph/emphasis/strong/inlineCode/code/blockquote/link/image/list/listItem/thematicBreak/table/tableRow/tableCell/yaml/frontmatter/inlineMath/displayMath/nekoCite/mdxJsxFlowElement/tableRow 等）：

```ts
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
import katex from 'katex'
import katexCss from 'katex/dist/katex.min.css?inline'
import { citeMdast } from '../cite'
import { mdxJsxMdast } from '../mdx'

export interface ExportRef { key: string; title?: string; authors?: string[]; year?: string }
export type ComponentRenderer = (props: Record<string, string>, childrenHtml: string) => string
export interface RenderDocumentOptions {
  title?: string
  refs?: Map<string, ExportRef>
  componentRenderers?: Record<string, ComponentRenderer>
  math?: 'katex' | 'text'
  includeCss?: boolean
}

// ... processor：unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter,['yaml']).use(remarkMath).use(() => (tree, file) => { mdxJsxMdast(tree as any, file); citeMdast(tree as any, file) })

// renderNode(node, ctx): string —— 递归，按类型返回 HTML
// - inlineMath: math==='katex' ? `<span class="math-inline">${katex.renderToString(value, { displayMode: false, throwOnError: false })}</span>` : `<span class="math-latex">$${value}$</span>`
// - displayMath: katex displayMode true，包 <div class="math-display">
// - nekoCite: `<span class="cite">[${number}]</span>`（number 来自 ctx.citeNumbers 表，首次出现编 1..N）
// - mdxJsxFlowElement: parse name/attrs/children（复用 mdx/node.ts 的 parseMdxTag），若 componentRenderers[name] → 调它；否则中性占位 `<div class="mdx-fallback">…源码…</div>`
// - 其余节点按语义输出（用 escapeHtml 对文本/attr 转义；href/src 转义）

// 主流程：parse → 先遍历一次收集 cite 顺序（ctx.citeNumbers + order array）→ 渲染 body → 拼装文档：
// `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${katexCss}${printCss}</style></head><body>${body}<section class="references">…<ol>…</ol></section></body></html>`
// frontmatter.title 作为 title 后备；frontmatter 本体渲染成 <pre class="frontmatter">…</pre>（保留 YAML 文本，escaped）
```

> 重要实现提示：
> - 引用编号只对「当前文档首次出现的 key」分配；重复 `[@a]` 用同一编号（与 editor `computeCiteOrder` 规则一致）。用两个测试锁定 `>1<`、`>2<` 且第三处仍 `>1<`。
> - `includeCss === false` 时省略 `<style>`（测试 PDF/嵌入场景可关）。默认 true。
> - `katex.renderToString` 的 `throwOnError: false` 保证非法公式不抛（输出错误红字，不崩）。
> - `?inline` CSS 若构建报错，用常量 `const katexCss = ''` 降级并在 report 记录（配合 `math: 'text'` 也能通过测试）。
> - cite 顺序收集必须在渲染 body 前完成（两遍：先扫后渲）。
> - `mdxJsxFlowElement` 的 children 需要先递归渲染成 childrenHtml 再交给 renderer（Callout 的 `children` 通常是纯文本/行内）。

- [ ] **Step 4: 跑测试 + 依赖**

`packages/editor-core/package.json` deps 加 `"katex": "^0.16"` → `pnpm install` → `pnpm --filter @nekowite/editor-core test` / typecheck / lint 全绿。

- [ ] **Step 5: Commit**

```bash
git add packages/editor-core
git commit -m "feat(editor-core): add markdown to HTML export renderer"
```

---

### Task 3: Rust 保存对话框 + desktop 导出服务

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`（新增 `save_file_dialog` 命令）
- Create: `apps/desktop/src/services/export.ts`
- Create: `apps/desktop/src/services/export.test.ts`
- Create: `apps/desktop/src/services/exportRenderers.ts`
- Modify: `apps/desktop/src/services/fs.ts`（可选：加 saveFile 便捷方法）
- Modify: `apps/desktop/package.json`（视需要）

**Interfaces:**
- Consumes: `renderDocument` + types (Task 2), `fsService.write`, `useRefsStore`（拿 refs Map 转 `ExportRef` map）, registry 内置组件白名单。
- Produces (EXACT — Task 4 depends):
  - `exportHtml(source: string, vault: string, savePath: string, opts: ExportUiOptions): Promise<void>` —— 调 renderDocument（title 从 source frontmatter 提取或传参；refs 从 useRefsStore().refs 转换）→ fsService.write(vault, savePath, html)。
  - `exportToPdf(source: string, opts: ExportUiOptions): Promise<void>` —— 生成 html 字符串 → 隐藏 iframe（`document.createElement('iframe')`，`srcdoc` 或 blob URL 加载）→ `iframe.contentWindow.print()`（Tauri WebView 调系统打印对话框）→ 打印结束移除 iframe。
  - `buildComponentRenderers(): Record<string, ComponentRenderer>` —— **内置白名单**静态映射：`Callout` → `<aside class="callout callout-{type}">{children}</aside>`（与导出 CSS 一致）。第三方组件不在此表（导出为中性的 `mdx-fallback`）。若 v1.3 需要支持已注册任意组件，改用 `@vue/server-renderer`（见 Global Constraints 前提），否则白名单即可。
  - `ExportUiOptions = { title?: string; refs?: Map<string, ExportRef>; math?: 'katex' | 'text'; savePath?: string }`

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/services/export.test.ts`（mock fsService + window.print + iframe）：

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { exportHtml, buildComponentRenderers } from './export'

const writeMock = vi.hoisted(() => vi.fn())
vi.mock('../services/fs', () => ({ fsService: { write: writeMock } }))

describe('buildComponentRenderers', () => {
  it('renders Callout to aside', () => {
    const r = buildComponentRenderers()
    const out = r.Callout?.({ type: 'info' }, '<b>hi</b>') ?? ''
    expect(out).toContain('callout-info')
    expect(out).toContain('<b>hi</b>')
  })
})

describe('exportHtml', () => {
  beforeEach(() => writeMock.mockReset())

  it('writes rendered html to disk', async () => {
    writeMock.mockResolvedValue(undefined)
    await exportHtml('# T\n', 'vault', 'out.html', { title: 'Doc' })
    expect(writeMock).toHaveBeenCalledWith('vault', 'out.html', expect.stringContaining('<!DOCTYPE html>'))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @nekowite/desktop test`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

`apps/desktop/src/services/exportRenderers.ts`：

```ts
import type { ComponentRenderer } from '@nekowite/editor-core'

export function buildComponentRenderers(): Record<string, ComponentRenderer> {
  return {
    Callout: (props, childrenHtml) =>
      `<aside class="callout callout-${props.type ?? 'info'}"><div class="callout-body">${childrenHtml}</div></aside>`,
  }
}
```

`apps/desktop/src/services/export.ts`：

```ts
import { renderDocument, type ExportRef, type RenderDocumentOptions } from '@nekowite/editor-core'
import { fsService } from './fs'
import { buildComponentRenderers } from './exportRenderers'

export interface ExportUiOptions {
  title?: string
  refs?: Map<string, ExportRef>
  math?: 'katex' | 'text'
  savePath?: string
}

function toRenderOptions(opts: ExportUiOptions): RenderDocumentOptions {
  return {
    title: opts.title,
    refs: opts.refs,
    componentRenderers: buildComponentRenderers(),
    math: opts.math,
    includeCss: true,
  }
}

export async function exportHtml(source: string, vault: string, savePath: string, opts: ExportUiOptions): Promise<void> {
  const html = renderDocument(source, toRenderOptions(opts))
  await fsService.write(vault, savePath, html)
}

export function exportToPdf(source: string, opts: ExportUiOptions): void {
  const html = renderDocument(source, toRenderOptions(opts))
  const iframe = document.createElement('iframe')
  iframe.style.display = 'none'
  iframe.srcdoc = html
  document.body.appendChild(iframe)
  iframe.onload = () => {
    iframe.contentWindow?.focus()
    iframe.contentWindow?.print()
  }
  // 打印对话框是阻塞的；打印返回后清理
  setTimeout(() => iframe.remove(), 60000)
}
```

`apps/desktop/src-tauri/src/lib.rs` 新增命令（tauri-plugin-dialog 的 save dialog）：

```rust
#[tauri::command]
fn save_file_dialog(app: tauri::AppHandle, default_name: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_dialog::FilePath;
    let path = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .blocking_save_file();
    Ok(path.and_then(|p| match p {
        FilePath::Path(p) => Some(p.to_string_lossy().to_string()),
        _ => None,
    }))
}
```
并在 `generate_handler![...]` 注册。

`apps/desktop/src/services/fs.ts` 加便捷方法：`saveFileDialog: (defaultName: string) => invoke<string | null>('save_file_dialog', { defaultName })`。

- [ ] **Step 4: 跑测试 + Rust**

Run: `pnpm --filter @nekowite/desktop test` / typecheck / lint 全绿；`(cd apps/desktop/src-tauri && cargo test)` 不回归；`cargo build` 通过。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): add html/pdf export service and save dialog"
```

---

### Task 4: 导出 UI 接线 + 全量回归

**Files:**
- Modify: `apps/desktop/src/ui/SettingsPanel.vue`（导出区）
- Modify: `apps/desktop/src/App.vue`（或由 SettingsPanel 直接发事件）
- Modify（可选）: `apps/desktop/src/style.css`（导出后打印/iframe 相关全局样式，若需要）

**Interfaces:**
- Consumes: `exportHtml`/`exportToPdf` (Task 3), `useTabsStore`（active tab 的 content/path），`fsService.saveFileDialog`，`useRefsStore`。
- Produces: SettingsPanel 内「导出」区块——两个按钮「导出 HTML」「导出 PDF」，作用于当前 active tab；导出文件名 `{basename}.html/.pdf`；经 save_file_dialog 选路径后写盘；错误走 `notifyError`。

- [ ] **Step 1: 写失败测试（导出文件名推导纯函数）**

`apps/desktop/src/services/exportName.ts`（新建）+ 测试：

```ts
import { describe, expect, it } from 'vitest'
import { exportBaseName } from './exportName'

describe('exportBaseName', () => {
  it('derives base name from path', () => {
    expect(exportBaseName('/vault/notes/hello.md')).toBe('hello')
    expect(exportBaseName('hello.mdx')).toBe('hello')
    expect(exportBaseName(null)).toBe('untitled')
  })
})
```

- [ ] **Step 2: 跑测试确认失败 → 实现 exportName.ts + 测试通过**

`apps/desktop/src/services/exportName.ts`：

```ts
export function exportBaseName(path: string | null | undefined): string {
  if (!path) return 'untitled'
  const base = path.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.[^.]+$/, '') || 'untitled'
}
```

- [ ] **Step 3: SettingsPanel 加导出区**

`SettingsPanel.vue` 的 `settings-body` 内新增：

```vue
<div class="settings-section">
  <span class="settings-label">导出 (当前文档)</span>
  <div class="view-modes">
    <button :disabled="!hasActiveTab" @click="onExportHtml">导出 HTML</button>
    <button :disabled="!hasActiveTab" @click="onExportPdf">导出 PDF</button>
  </div>
</div>
```

脚本逻辑：

```ts
import { computed } from 'vue'
import { useTabsStore } from '../stores/tabs'
import { useRefsStore } from '../stores/refs'
import { exportHtml, exportToPdf } from '../services/export'
import { exportBaseName } from '../services/exportName'
import { fsService } from '../services/fs'
import { notifyError } from '../services/errors'
import type { ExportRef } from '@nekowite/editor-core'

const tabs = useTabsStore()
const refs = useRefsStore()
const hasActiveTab = computed(() => !!tabs.activeTab?.content)

function refsMap(): Map<string, ExportRef> {
  const m = new Map<string, ExportRef>()
  for (const r of refs.refs.values()) m.set(r.key, { key: r.key, title: r.title, authors: r.authors, year: r.year })
  return m
}

async function onExportHtml(): Promise<void> {
  const tab = tabs.activeTab
  if (!tab) return
  const name = exportBaseName(tab.path) + '.html'
  const savePath = await fsService.saveFileDialog(name)
  if (!savePath) return
  try {
    await exportHtml(tab.content, tabs.vault ?? '', savePath, { title: name, refs: refsMap() })
    notifySuccess?.(`已导出 ${savePath}`) // 若无成功 toast，复用 notifyError 或跳过
  } catch (e) {
    notifyError(`导出失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

function onExportPdf(): void {
  const tab = tabs.activeTab
  if (!tab) return
  exportToPdf(tab.content, { title: exportBaseName(tab.path), refs: refsMap() })
}
```

> 说明：`tabs.vault` 若不存在（active tab path 为绝对 vault 路径时），`exportHtml` 写盘需要 vault——用 `tabs.vault`（若 store 有）否则从 `tab.path` 推导根（到 vault 的部分）。实际以现有 tabs store 字段为准，必要时在 store 补一个 `vault` 字段并接线（App.vue applyVault 里 `tabs.setVault(path)` 已存在——检查 store 是否有对应状态，没有则加上并同步 Task 3 的 exportHtml 调用）。

- [ ] **Step 4: 全量回归 + 手动冒烟**

- `pnpm -r test`（editor-core 62 + plugin-host 11 + desktop ≥32 + Rust 3）全绿；`pnpm typecheck`、`pnpm lint`。
- 手动（若环境允许）：写一个含 `$E=mc^2$`、`[@a]`、`<Callout>` 的文档 → Settings 导出 HTML → 浏览器打开验证公式/引用/组件渲染；导出 PDF → 打印对话框出现。不可用则记录「待手动验证」。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): add export UI entry points in settings panel"
```

---

## Self-Review

**Spec 覆盖检查：**
- 可复用 remark 变换（编辑器/导出共用）→ Task 1 ✅
- mdast→HTML renderDocument（全节点 + KaTeX math + cite 编号 + mdx 组件 + 参考文献 + frontmatter title）→ Task 2 ✅
- exportHtml / exportToPdf 服务 + 组件白名单渲染器 → Task 3 ✅
- Rust save_file_dialog 命令 → Task 3 ✅
- UI 导出入口（SettingsPanel HTML/PDF 按钮）→ Task 4 ✅
- PDF 走浏览器打印（复用 HTML 渲染路径）→ Task 3 exportToPdf ✅
- 范围红线（无 DOCX、无主题自定义、无资源内联、PDF 必经打印对话框）→ 未加入任务 ✅

**占位符检查：** 无 TBD/TODO；`?inline` CSS 降级、`$remark` 行为保持、`tabs.vault` 是否存在、`@vue/server-renderer` 是否启用——均给了明确判定标准与替代路径。✅

**类型一致性：**
- `citeMdast(tree, file): void` / `mdxJsxMdast(tree, file): void`（Task 1）→ Task 2 导出管道消费 ✅
- `ExportRef` / `ComponentRenderer` / `RenderDocumentOptions` / `renderDocument(md, opts): string`（Task 2）→ Task 3/4 消费 ✅
- `buildComponentRenderers(): Record<string, ComponentRenderer>`（Task 3）→ 内部 toRenderOptions 使用 ✅
- `exportHtml(source, vault, savePath, opts)` / `exportToPdf(source, opts)`（Task 3）→ Task 4 消费 ✅
- `exportBaseName(path): string`（Task 4）→ Task 4 自身 + 测试 ✅
- `ExportUiOptions`（Task 3）→ Task 4 传参一致 ✅
