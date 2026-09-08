# NekoWite v1.1 数学公式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add math formula support to NekoWite — MathLive visual rendering in the WYSIWYG view, a popup MathLive editor (with virtual keyboard) for create/edit, direct LaTeX entry in source view, all stored as `$…$`/`$$…$$` with byte-faithful round-trip.

**Architecture:** Add two Milkdown custom nodes (`math_inline` + `math_display`) storing `{ latex }`, with `parseMarkdown`/`toMarkdown` hooks wired to remark-math (`inlineMath`/`displayMath` mdast types). `remark-math` is added both to the standalone `serialize.ts` processor (for `roundTrip` fidelity) and to Milkdown's parse pipeline (via a `$remark`). Read-only rendering uses MathLive `convertLatexToMarkup` in a `$view` node view (inline + block). A popup dialog (Vue app mounted into a document body overlay) uses MathLive `makeMathField` for editing + virtual keyboard, with a inline/display toggle. Toolbar/click integration follows the existing `tableFeature` pattern (`registerCommand`/`registerToolbar` + a plugin capturing `editorViewCtx`).

**Tech Stack:** `mathlive` (MathLive visual math), `remark-math`, existing Milkdown v7 `$node`/`$view`/`$remark`, Vue 3 (dialog), vitest.

## Global Constraints

- Only touch `packages/editor-core` and `apps/desktop` (mostly editor-core; the toolbar picks up registry items automatically — no WordToolbar edit needed unless stated).
- TypeScript strict; no unused vars/imports; no Chinese code comments (user-facing UI strings may be Chinese); English commit messages.
- Before committing: `pnpm --filter @nekowite/editor-core test`, typecheck, lint all green; run `pnpm -r test` to catch regressions in plugin-host/desktop.
- pnpm commands need `PNPM_STORE_DIR=/tmp/pnpm-store-test/v11` or `--store-dir`.
- Existing 48 tests must keep passing (editor-core 24, plugin-host 11, desktop 13). Do NOT break the mdx/table/serialize behavior.
- MathLive API specifics may differ by installed version: if the package exposes `MathLive` as a named export vs a `window.MathLive` global, adapt the import accordingly and document it. The semantic API (`MathLive.convertLatexToMarkup(latex)`, `MathLive.makeMathField(el, opts)`, `mf.getValue()`) is stable across 0.10x. Report any deviation.

---

### Task 1: 数学节点 + remark 序列化往返（纯逻辑）

**Files:**
- Create: `packages/editor-core/src/math/nodes.ts`
- Create: `packages/editor-core/src/math/remark.ts`
- Create: `packages/editor-core/src/math/index.ts`
- Create: `packages/editor-core/src/math/nodes.test.ts`
- Modify: `packages/editor-core/src/serialize.ts`（加 remark-math）
- Modify: `packages/editor-core/src/plugins/basic.ts`（节点 + remark 插件入位）
- Modify: `packages/editor-core/src/index.ts`（导出 `./math`）
- Modify: `packages/editor-core/package.json`（加 `remark-math`）

**Interfaces:**
- Consumes: Milkdown `$node`, existing markdown patterns.
- Produces (EXACT, later tasks rely on these):
  - `mathInline: MilkdownPlugin`（节点 id `math_inline`, `group: 'inline'`, `inline: true, atom: true`，attrs `{ latex: string }`）— `parseMarkdown` match `inlineMath`、`toMarkdown` 输出 `$…$`。
  - `mathDisplay: MilkdownPlugin`（节点 id `math_display`, `group: 'block'`, `atom: true`，attrs `{ latex: string }`）— match `displayMath`、输出 `$$\n…\n$$`。
  - `mathToMarkdown(latex: string, mode: 'inline' | 'display'): string` 纯函数。
  - `mathRemark: MilkdownPlugin`（`$remark` 包装 remark-math，供 Milkdown 解析 `$…$`）。
  - `basicPlugins` 在 `...gfm` 之后加入 `mathRemark, mathInline, mathDisplay`。

- [ ] **Step 1: 写失败测试**

`packages/editor-core/src/math/nodes.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { roundTrip } from '../serialize'
import { mathToMarkdown } from './nodes'

describe('mathToMarkdown', () => {
  it('inline math emits single dollar', () => {
    expect(mathToMarkdown('E=mc^2', 'inline')).toBe('$E=mc^2$')
  })
  it('display math emits double dollar block', () => {
    expect(mathToMarkdown('x^2', 'display')).toBe('$$\nx^2\n$$')
  })
})

describe('round-trip math', () => {
  it('preserves inline math', () => {
    const md = 'Energy is $E=mc^2$ and $x_i$ stays math, not emphasis.\n'
    expect(roundTrip(md)).toBe(md)
  })
  it('preserves display math', () => {
    const md = '$$\nx^2 + y^2 = z^2\n$$\n'
    expect(roundTrip(md)).toBe(md)
  })
  it('preserves escaped dollar and plain text', () => {
    const md = 'Cost is \\$5. Not math $5x$.\n'
    expect(roundTrip(md)).toContain('\\$5')
  })
})
```

> 说明：这些测试依赖 `serialize.ts` 已接入 remark-math 与 math 节点的 toMarkdown。等实现后 `roundTrip` 需手写把 math 节点序列化，见 Step 3。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @nekowite/editor-core test`
Expected: FAIL——`mathToMarkdown` 未定义、`roundTrip` 未保留 `$…$`。

- [ ] **Step 3: 实现节点 + 序列化**

`packages/editor-core/src/math/nodes.ts`：

```ts
import { $node } from '@milkdown/utils'

export interface MathAttrs {
  latex: string
}

export function mathToMarkdown(latex: string, mode: 'inline' | 'display'): string {
  if (mode === 'inline') return `$${latex}$`
  return `$$\n${latex}\n$$`
}

const inlineAttrs = { latex: { default: '' } }
const displayAttrs = { latex: { default: '' } }

export const mathInline = $node('math_inline', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: inlineAttrs,
  parseDOM: [{ tag: 'math[data-math-inline]' }],
  toDOM: (node) => {
    const el = document.createElement('math')
    el.setAttribute('data-math-inline', '')
    el.textContent = node.attrs.latex
    return el
  },
  parseMarkdown: {
    match: (n) => n.type === 'inlineMath' && typeof n.value === 'string',
    runner: (state, node, type) => {
      state.addNode(type, { latex: node.value ?? '' })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_inline',
    runner: (state, node) => {
      state.addNode('html', undefined, mathToMarkdown(String(node.attrs.latex ?? ''), 'inline'))
    },
  },
}))

export const mathDisplay = $node('math_display', () => ({
  group: 'block',
  atom: true,
  attrs: displayAttrs,
  parseDOM: [{ tag: 'math[data-math-display]' }],
  toDOM: (node) => {
    const el = document.createElement('math')
    el.setAttribute('data-math-display', '')
    el.textContent = node.attrs.latex
    return el
  },
  parseMarkdown: {
    match: (n) => n.type === 'displayMath' && typeof n.value === 'string',
    runner: (state, node, type) => {
      state.addNode(type, { latex: node.value ?? '' })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_display',
    runner: (state, node) => {
      state.addNode('html', undefined, mathToMarkdown(String(node.attrs.latex ?? ''), 'display'))
    },
  },
}))
```

> 说明：`toMarkdown` 复用 mdxComponent 的 `state.addNode('html', undefined, raw)` 模式，把 `$…$`/`$$…$$` 作为原文写入 Markdown serializer 输出——这会让 Milkdown 的 `getMarkdown()` 与后续 `roundTrip` 保真。若该模式在运行时对 `inline` 节点序列化有异常（同级/包裹问题），改用它种的 inline 原文输出方式，并记录；判定标准是 round-trip 测试通过。

`packages/editor-core/src/math/remark.ts`：

```ts
import { $remark } from '@milkdown/utils'
import remarkMath from 'remark-math'

export const mathRemark = $remark('mathRemark', () => [remarkMath])
```

`packages/editor-core/src/math/index.ts`：

```ts
export * from './nodes'
export * from './remark'
```

修改 `packages/editor-core/src/serialize.ts`：

```ts
import remarkMath from 'remark-math'
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkMath)
  .use(remarkStringify, { bullet: '-', emphasis: '*', strong: '*', fences: true })
```

> 说明：完成此步后，`roundTrip` 会用 remark-math 解析 `$…$`→`inlineMath` 再序列化回 `$…$`，实现纯函数层的往返保真。但 `editor.save()` 走 `roundTrip(getMarkdown()(ctx))`，getMarkdown 的输出要包含 math 节点产出的 `$…$`（Step 3 的 `toMarkdown`），两端对齐后整体保真。

- [ ] **Step 4: 接入 basicPlugins + 导出**

`packages/editor-core/src/plugins/basic.ts` 在列表中加入：

```ts
import { mathDisplay, mathInline, mathRemark } from '../math'
// 在 ...gfm.flat(), 之后、mdxComponent 之前：
mathRemark,
mathInline,
mathDisplay,
```

`packages/editor-core/src/index.ts` 加入 `export * from './math'`。

`packages/editor-core/package.json` dependencies 加：`"remark-math": "^6"` → `pnpm install`。

- [ ] **Step 5: 跑测试**

Run: `pnpm --filter @nekowite/editor-core test`
Expected: math 测试 PASS，且已有 24 个测试仍通过（尤其 serialize 的 `roundTrip` 非 math 用例——remark-math 不应改变纯文本行为）。

- [ ] **Step 6: 跑 editor 集成冒烟（可选但鼓励）**

在 `editor.test.ts`（或临时 REPL）验证：`editor.open('$E=mc^2$')` 后 `editor.save()` 输出含 `$E=mc^2$`。若 Milkdown 解析/序列化链路有 gap，在 report 记录并微调节点 match/runner。

- [ ] **Step 7: Commit**

```bash
git add packages/editor-core
git commit -m "feat(editor-core): add math nodes and remark round-trip serialization"
```

---

### Task 2: MathLive 只读渲染 Node Views

**Files:**
- Create: `packages/editor-core/src/math/atoms.ts`
- Create: `packages/editor-core/src/math/views.ts`
- Modify: `packages/editor-core/src/math/index.ts`
- Modify: `packages/editor-core/src/plugins/basic.ts`
- Modify: `packages/editor-core/package.json`（加 `mathlive`）

**Interfaces:**
- Consumes: `mathInline`, `mathDisplay` (Task 1), `editorViewCtx` pattern (tableFeaturePlugin).
- Produces (EXACT):
  - `renderLatexMarkup(latex: string): string` —— MathLive `convertLatexToMarkup` 结果，加载失败时降级返回转义 latex 文本。
  - `mathInlineNodeView: $view`, `mathDisplayNodeView: $view` —— 只读渲染，点击时 `view.dispatch` 触发打开编辑（emit 给 Task 3 的 dialog，通过抛事件或回调位）。
  - `createMathEditor(el: HTMLElement, options: { value?: string; onChange?: (latex: string) => void }): MathEditorHandle`，`MathEditorHandle = { getValue(): string; setValue(latex: string): void; dispose(): void }`（Task 3 dialog 用）。

- [ ] **Step 1: 写失败测试（atoms 降级逻辑）**

`packages/editor-core/src/math/atoms.test.ts`：

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderLatexMarkup } from './atoms'

describe('renderLatexMarkup', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('returns MathLive markup when available', () => {
    // MathLive global 被 mock 成有 convertLatexToMarkup
    ;(globalThis as any).MathLive = { convertLatexToMarkup: (s: string) => `<math>${s}</math>` }
    expect(renderLatexMarkup('E=mc^2')).toBe('<math>E=mc^2</math>')
  })

  it('degrades to escaped latex when MathLive unavailable', () => {
    ;(globalThis as any).MathLive = undefined
    expect(renderLatexMarkup('a < b')).toContain('a')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @nekowite/editor-core test`
Expected: FAIL——`renderLatexMarkup` 未定义。

- [ ] **Step 3: 实现 atoms.ts**

`packages/editor-core/src/math/atoms.ts`：

```ts
type MathLiveGlobal = {
  convertLatexToMarkup?(latex: string): string
  makeMathField?(el: HTMLElement, opts: Record<string, unknown>): MathEditorHandle
}

function getMathLive(): MathLiveGlobal {
  const w = globalThis as unknown as { MathLive?: MathLiveGlobal }
  return w.MathLive ?? {}
}

export interface MathEditorHandle {
  getValue(): string
  setValue(latex: string): void
  dispose(): void
}

export function renderLatexMarkup(latex: string): string {
  const { convertLatexToMarkup } = getMathLive()
  if (typeof convertLatexToMarkup === 'function') {
    try {
      return convertLatexToMarkup(latex)
    } catch {
      /* fall through */
    }
  }
  return latex
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function createMathEditor(
  el: HTMLElement,
  options: { value?: string; onChange?: (latex: string) => void } = {},
): MathEditorHandle {
  const { makeMathField } = getMathLive()
  if (typeof makeMathField === 'function') {
    const mf = makeMathField(el, {
      value: options.value ?? '',
      virtualKeyboardMode: 'onfocus',
      onInput: () => options.onChange?.(mf.getValue()),
    })
    return {
      getValue: () => mf.getValue(),
      setValue: (l) => mf.setValue(l),
      dispose: () => (typeof mf.remove === 'function' ? mf.remove() : undefined),
    }
  }
  // 降级：无 MathLive 时用 contenteditable 占位，getValue 返回其文本
  el.setAttribute('contenteditable', 'true')
  ;(el as HTMLElement).textContent = options.value ?? ''
  return {
    getValue: () => (el.textContent ?? ''),
    setValue: (l) => { el.textContent = l },
    dispose: () => { /* nothing */ },
  }
}
```

> 说明：`getMathLive()` 读全局 `window.MathLive`，因为它注入通常来自 `import 'mathlive'` 的副作用。若安装的 mathlive 版本改为 default/named 导出（而非挂全局），在 `atoms.ts` 顶部加静态 `import * as MathLiveNS from 'mathlive'` 并在 `getMathLive` 里回退取它——按实际版本适配并记录。CSS：在 `views.ts` 或 `app` 入口引入 `import 'mathlive/static.css'`（若该路径不存在则用包内实际 CSS 路径），保证公式字形/字体生效。

- [ ] **Step 4: 实现 views.ts（Node Views，只读渲染 + 点击打开编辑）**

`packages/editor-core/src/math/views.ts`：

```ts
import { $view } from '@milkdown/utils'
import type { NodeViewConstructor } from '@milkdown/prose/view'
import { mathDisplay, mathInline } from './nodes'
import { renderLatexMarkup } from './atoms'
import { openMathDialog } from './dialog' // Task 3 提供；此步先用占位导出，见下

const makeMathNodeView =
  (mode: 'inline' | 'display'): NodeViewConstructor =>
  (node, view, getPos) => {
    const dom = document.createElement(mode === 'inline' ? 'span' : 'div')
    dom.className = `math-node math-${mode}`

    const render = () => {
      dom.innerHTML = renderLatexMarkup(String(node.attrs.latex ?? ''))
    }
    render()

    dom.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const pos = typeof getPos === 'function' ? getPos() : null
      openMathDialog(view, {
        mode,
        latex: String(node.attrs.latex ?? ''),
        existingPos: pos,
        schema: view.state.schema,
      })
    })

    return {
      dom,
      ...(mode === 'inline' ? { inline: true } : {}),
      update: (newNode) => {
        if (newNode.type !== node.type) return false
        node = newNode
        render()
        return true
      },
      destroy: () => { dom.removeEventListener('click', () => {} as never) },
    }
  }

export const mathInlineNodeView = $view(mathInline, () => makeMathNodeView('inline'))
export const mathDisplayNodeView = $view(mathDisplay, () => makeMathNodeView('display'))
```

> 说明：`openMathDialog` 在 Task 3 才实现。为避免开发顺序依赖，此步在 `views.ts` 引用一个 `../dialog` 的接口签名，Task 3 实现它。若觉得当前步必须先能编译，可在 Task 3 到来前用 `globalThis` 占位导出；更推荐先把 Task 3 的 `dialog.ts` 骨架签名写好，让本步 import 成立——见 Task 3 Step 1 的接口约定。

`packages/editor-core/src/math/index.ts` 加：`export * from './atoms'`、`export * from './views'`。

`packages/editor-core/src/plugins/basic.ts` 在节点之后加 `mathInlineNodeView`, `mathDisplayNodeView`（排在 `...gfm` 之后，确保 view 在其 schema 节点就绪后注册）。

`packages/editor-core/package.json` dependencies 加：`"mathlive": "^0.103"` → `pnpm install`。

- [ ] **Step 5: 跑测试**

Run: `pnpm --filter @nekowite/editor-core test`
Expected: atoms 测试 PASS，既有测试不回归。若 `views.ts` 引用的 dialog 未实现导致编译失败，先把 `dialog.ts` 提供一个最小可编译的 `openMathDialog` 空实现（Task 3 填充），并在 report 说明。

- [ ] **Step 6: Commit**

```bash
git add packages/editor-core
git commit -m "feat(editor-core): render math via MathLive with clickable node views"
```

---

### Task 3: MathEditorDialog + 工具栏 + 点击编辑 + 插入

**Files:**
- Create: `packages/editor-core/src/math/dialog.ts`
- Create: `packages/editor-core/src/math/dialog.test.ts`
- Modify: `packages/editor-core/src/math/feature.ts`（新建）
- Modify: `packages/editor-core/src/math/index.ts`
- Modify: `packages/editor-core/src/plugins/basic.ts`
- Modify（可选）：`apps/desktop/src/main.ts`（若需引入 MathLive CSS/副作用）

**Interfaces:**
- Consumes: `mathInline`/`mathDisplay` 节点（Task 1）、`createMathEditor`/`renderLatexMarkup`（Task 2）、`mathToMarkdown`（Task 1）、`registerCommand`/`registerToolbar`（registry）。
- Produces (EXACT):
  - `openMathDialog(view: EditorView, opts: { mode: 'inline' | 'display'; latex?: string; existingPos?: number | null; schema?: Schema }): void`
  - `insertMath(view: EditorView, latex: string, mode: 'inline' | 'display'): void`
  - `MATH_COMMAND_ID = 'math.insert'`
  - `mathFeature: () => void`（注册 command + toolbar）与 `mathFeaturePlugin: MilkdownPlugin`（捕获 editorViewCtx 供 command 使用）。

- [ ] **Step 1: 写失败测试（insertMath 纯逻辑）**

`packages/editor-core/src/math/dialog.test.ts`（或并入 nodes.test）——用编辑器创建真实 doc，验证 insert 后 save 出正确 markdown：

```ts
import { describe, expect, it } from 'vitest'
import { createEditor, basicPlugins } from '../editor'
import { insertMath } from './feature'

describe('insertMath', () => {
  it('inserts inline math that round-trips', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    editor.open('# T\n\n\n')
    await new Promise((r) => setTimeout(r, 0))
    const view = editor.getView()
    // 把光标放到空段落
    view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodes.paragraph.create()))
    insertMath(view, 'a+b', 'inline')
    const md = await editor.save()
    expect(md).toContain('$a+b$')
    editor.destroy()
  })
})
```

> 说明：若真实编辑器在 happy-dom 下 `editor.getView()`/insert 时序不稳定，改用「构造 schema 节点 → `mathInline.create({latex:'a+b'})` → 校验 `mathToMarkdown` + toMarkdown 输出」的纯函数断言，并把该集成用例标注为环境敏感。判定标准：插入后 markdown 出现 `$…$`/`$$…$$` 且 round-trip 不失真。

- [ ] **Step 2: 实现 feature.ts**

`packages/editor-core/src/math/feature.ts`：

```ts
import type { MilkdownPlugin } from '@milkdown/ctx'
import { editorViewCtx } from '@milkdown/core'
import type { EditorView } from '@milkdown/prose/view'
import { registerCommand, registerToolbar } from '../registry'

export const MATH_COMMAND_ID = 'math.insert'
let activeView: EditorView | null = null

export function insertMath(view: EditorView, latex: string, mode: 'inline' | 'display'): void {
  const { state } = view
  const type = mode === 'inline' ? state.schema.nodes.math_inline : state.schema.nodes.math_display
  if (!type) return
  const node = type.create({ latex })
  view.dispatch(state.tr.replaceSelectionWith(node))
}

export function mathFeature(): void {
  registerCommand({
    id: MATH_COMMAND_ID,
    run: () => { if (activeView) openMathDialog(activeView, { mode: 'inline' }) },
  })
  registerToolbar({
    id: MATH_COMMAND_ID,
    label: '∑ f(x)', // 数学公式按钮
    run: () => { if (activeView) openMathDialog(activeView, { mode: 'inline' }) },
  })
}

export const mathFeaturePlugin: MilkdownPlugin = (ctx) => {
  return () => { activeView = ctx.get(editorViewCtx) }
}

// 循环 import 拆解：openMathDialog 来自 dialog.ts，在此延迟 require/import 以避免循环依赖
import { openMathDialog } from './dialog'
mathFeature()
```

> 说明：`mathFeature()` 在模块加载时注册命令+工具栏（与 tableFeature 一致）；label 用数学符号（如 `∑`）。`openMathDialog` 的默认 mode=inline；用户在弹窗里可切换 inline/display。

- [ ] **Step 3: 实现 dialog.ts（MathLive 弹窗编辑器）**

`packages/editor-core/src/math/dialog.ts`：

```ts
import { createApp, ref, h, type App } from 'vue'
import type { EditorView } from '@milkdown/prose/view'
import type { Schema } from '@milkdown/prose/model'
import { createMathEditor, type MathEditorHandle } from './atoms'
import { insertMath } from './feature'

export interface OpenMathOptions {
  mode: 'inline' | 'display'
  latex?: string
  existingPos?: number | null
  schema?: Schema
}

export function openMathDialog(view: EditorView, opts: OpenMathOptions): void {
  const overlay = document.createElement('div')
  overlay.className = 'math-overlay'
  document.body.appendChild(overlay)

  let mf: MathEditorHandle | null = null
  let resolved: 'inline' | 'display' = opts.mode
  const fieldHost = document.createElement('div')
  fieldHost.className = 'math-field-host'

  const onConfirm = (): void => {
    const latex = mf?.getValue() ?? ''
    if (opts.existingPos != null && opts.schema) {
      const tr = view.state.tr
      const nodeType = resolved === 'inline' ? opts.schema.nodes.math_inline : opts.schema.nodes.math_display
      const node = nodeType.create({ latex })
      view.dispatch(tr.replaceWith(opts.existingPos, opts.existingPos + 1, node))
    } else {
      insertMath(view, latex, resolved)
    }
    app?.unmount()
    overlay.remove()
  }
  const onCancel = (): void => {
    app?.unmount()
    overlay.remove()
  }

  const app: App | null = createApp({
    setup() {
      const mode = ref<'inline' | 'display'>(opts.mode)
      const setMode = (m: 'inline' | 'display') => { resolved = m; mode.value = m }
      return () => h('div', { class: 'math-dialog', onClick: (e: MouseEvent) => e.stopPropagation() }, [
        h('div', { class: 'math-dialog-title' }, '插入 / 编辑公式'),
        h('div', { ref: (el) => { if (el) { mf = createMathEditor(el as HTMLElement, { value: opts.latex ?? '' }) } }, class: 'math-field-host' }),
        h('div', { class: 'math-mode-toggle' }, [
          h('label', [h('input', { type: 'radio', name: 'math-mode', checked: mode.value === 'inline', onChange: () => setMode('inline') }), ' 行内 $..$']),
          h('label', [h('input', { type: 'radio', name: 'math-mode', checked: mode.value === 'display', onChange: () => setMode('display') }), ' 块级 $$..$$']),
        ]),
        h('div', { class: 'math-actions' }, [
          h('button', { onClick: onCancel }, '取消'),
          h('button', { class: 'primary', onClick: onConfirm }, '确定'),
        ]),
      ])
    },
  })

  // Vue app 挂到 overlay；overlay 点击自身关闭
  overlay.addEventListener('click', (e) => { if (e.target === overlay) onCancel() })
  app.mount(overlay)
  ;(overlay.firstElementChild as HTMLElement | null)?.focus?.()
}
```

> 说明：MathLive 的 `makeMathField` 在虚拟键盘/UI 上依赖其 CSS；若 `static.css` 未随包注入，需在 app 入口（`apps/desktop/src/main.ts` 或 `style.css`）`import 'mathlive/static.css'`（或实际 CSS 路径）。实现时按实际渲染结果决定 CSS 引入位置，并在 report 记录。对无 MathLive 的降级路径（happy-dom/CI），`createMathEditor` 返回 contenteditable 占位，仍可 getValue——保证测试可跑。

`packages/editor-core/src/math/index.ts` 加：`export * from './feature'`、`export * from './dialog'`。

`packages/editor-core/src/plugins/basic.ts` 末尾（view 之后）加 `mathFeaturePlugin`。

> ⚠️ 循环依赖注意：`feature.ts`（insertMath）与 `dialog.ts`（openMathDialog 用 insertMath）互相 import。处理：把 `insertMath` 保留在 `feature.ts`；`dialog.ts` 顶部 `import { insertMath } from './feature'`；`feature.ts` 底部 `import { openMathDialog } from './dialog'`——通过「函数在使用时才调用」避免初始化循环（两者都在函数体内引用，而非模块顶层执行），ESM 循环 import 对函数引用是允许的。若构建报循环，重构为三文件：`feature.ts`（insertMath + 注册，不 import dialog）、`dialog.ts`（openMathDialog，import feature）、`index.ts` 内部再组合。

- [ ] **Step 4: 跑测试 + 修复循环/编译**

Run: `pnpm --filter @nekowite/editor-core test`
Expected: insertMath 测试 PASS，既有测试不回归。若循环 import 报错，按 Step 3 说明重构。

- [ ] **Step 5: 应用集成冒烟 + CSS**

- 确保 MathLive CSS 生效：在 `apps/desktop/src/main.ts`（或 App）`import 'mathlive/static.css'`；若该路径不存在，按实际包内 CSS 路径替换，并在 report 记录。
- Run: `pnpm dev`（手动）：工具栏出现 `∑ f(x)` 按钮 → 点击弹出 MathLive 编辑面板 + 虚拟键盘 → 输入公式 → 确定 → 文档出现渲染公式；点击公式 → 弹窗回填可编辑；源码视图直接写 `$…$` → 切渲染视图显示为公式。
- 若浏览器/窗口不可用，记录「待手动验证」项：工具栏插入、点击编辑、CS：`$…$` 在渲染视图显示。

- [ ] **Step 6: 全量回归**

Run: `pnpm -r test`（editor-core + plugin-host + desktop 全绿，总计 ≥49 + Rust 3），`pnpm lint`、`pnpm typecheck`。

- [ ] **Step 7: Commit**

```bash
git add packages/editor-core apps/desktop/src/main.ts
git commit -m "feat(editor-core,desktop): add MathLive formula dialog with toolbar insert and click-to-edit"
```

---

## Self-Review

**Spec 覆盖检查：**
- math_inline + math_display 节点 → Task 1 ✅
- remark-math 解析管道（`$…$`→inlineMath、`$$…$$`→displayMath）→ Task 1 ✅（serialize.ts + mathRemark）
- MathLive 渲染（只读显示于 WYSIWYG）→ Task 2 ✅（renderLatexMarkup + node views）
- MathEditorDialog 弹窗（新建 + 点击已有公式编辑）→ Task 3 ✅（openMathDialog + existingPos 替换）
- 工具栏「插入公式」按钮 + 行内/块级选择 → Task 3 ✅（mathFeature + dialog 内 toggle）
- 点击公式 → 编辑 → Task 2+3 ✅（node view click → openMathDialog）
- 往返保真 `$…$`/`$$…$$` → Task 1 ✅（round-trip 测试）
- 不做引用/AI/导出原生公式 → 未加入任务 ✅

**占位符检查：** 唯二需按环境适配的点（MathLive 的 `MathLive` 全局 vs named export；`mathlive/static.css` 路径；循环依赖处理）均在任务内给出了明确替代方案，非「之后再说」占位。

**类型一致性：**
- `mathToMarkdown(latex, mode)`（Task 1）→ Task 1 测试 + Task 3 不直接用（插入走节点）✅
- `MathAttrs = { latex: string }`（Task 1）→ Task 2/3 节点 attrs 一致 ✅
- `renderLatexMarkup(latex)`、`createMathEditor(el, opts): MathEditorHandle`（Task 2）→ Task 3 dialog 消费 ✅
- `openMathDialog(view, { mode, latex?, existingPos?, schema? })`、`insertMath(view, latex, mode)`、`MATH_COMMAND_ID`、`mathFeature`/`mathFeaturePlugin`（Task 3）→ 内部自洽，Task 2 的 `views.ts` 引用 `openMathDialog(view, { mode, latex, existingPos, nodeType: node.type, schema })`——签名中 `nodeType` / `schema` 与 Task 3 的 `schema` 字段核对：**修正 Task 2 调用为 `{ mode, latex, existingPos, schema: view.state.schema }`**（去掉 nodeType，`replaceWith(pos, pos+1, node)` 用 `schema.nodes.math_inline|math_display` 由 mode 决定，不需要 nodeType）。✅
