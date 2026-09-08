# NekoWite v1.2 引用管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add citation management to NekoWite — import `.bib`/`.ris`/CSL-JSON reference files from the vault, search and insert `[@citekey]` (Pandoc syntax) from a sidebar, auto-number citations `[1][2]…` in the WYSIWYG view by first-appearance order, and show a numbered reference list consistent with the in-doc numbering.

**Architecture:** editor-core gets an inline `cite` node (`{ key }`) with a `$remark` preprocessor that splits `[@key]` out of mdast text (reusing the mdxJsxRemark pattern), serializing byte-faithfully to `[@key]`; a `$view` node view renders a `[n]` chip whose `n` is computed by scanning the doc for cite nodes in first-appearance order. The app layer owns reference data: `services/refs.ts` wraps Citation.js parsing, `stores/refs.ts` (Pinia) indexes vault reference files, and `RefSidebar.vue`/`ReferencesPanel.vue` provide search/insert and the numbered list. A small app-level `editorBridge` gives the sidebar access to the active `NekoEditor` view for insert-at-cursor.

**Tech Stack:** `@citation-js/core` + `plugin-bibtex`/`plugin-ris`/`plugin-csl` (app layer), existing Milkdown `$node`/`$view`/`$remark`, Vue 3 + Pinia (app), vitest.

## Global Constraints

- editor-core gets NO new third-party deps (reuse `$node`/`$view`/`$remark`).
- App layer (`apps/desktop`) gets the four `@citation-js/*` deps.
- TypeScript strict; no unused vars/imports; no Chinese code comments (UI strings may be Chinese); English commit messages.
- Before committing: affected package test/typecheck/lint green; run `pnpm -r test` (currently 71 JS + 3 Rust) must not regress.
- pnpm needs `PNPM_STORE_DIR=/tmp/pnpm-store-test/v11` or `--store-dir`.
- Existing cite-adjacent conventions: `mdxJsxRemark` ($remark), `mdxComponent` node ($node with parseMarkdown/toMarkdown/toDOM + html-bucket toMarkdown), `tableFeature`/`mathFeature` (module-level activeView captured AFTER `await ctx.wait(EditorViewReady)`), `mathDialog` (overlay + Vue app + try/finally cleanup).
- Citation.js API note: `new Cite(text, { forceType })` → `.data` is an array of CSL-JSON entries; adapt the reference mapper to the actual installed version's output shape and document deviations.

---

### Task 1: cite 节点 + remark 预处理 + 序列化往返（editor-core）

**Files:**
- Create: `packages/editor-core/src/cite/node.ts`
- Create: `packages/editor-core/src/cite/remark.ts`
- Create: `packages/editor-core/src/cite/index.ts`
- Create: `packages/editor-core/src/cite/node.test.ts`
- Modify: `packages/editor-core/src/plugins/basic.ts`
- Modify: `packages/editor-core/src/index.ts`

**Interfaces:**
- Consumes: `$node`, `$remark` from `@milkdown/utils`; the `mdxJsxRemark` transform pattern (`packages/editor-core/src/mdx/remark.ts`).
- Produces (EXACT, Task 2/3/4 depend):
  - `cite: MilkdownPlugin`（节点 id `cite`, `group:'inline'`, `inline:true`, `atom:true`, attrs `{ key: string }`）。
  - `citeToMarkdown(key: string): string` —— 返回 `[@${key}]`。
  - `citeRemark: MilkdownPlugin`（`$remark` 预处理：把 mdast text 中的 `[@…]` 拆成 `nekoCite` 节点）。
  - `basicPlugins` 在 `...gfm.flat()` 之后、`mathRemark` 之前加 `citeRemark, cite`。

- [ ] **Step 1: 写失败测试**

`packages/editor-core/src/cite/node.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { roundTrip } from '../serialize'
import { citeToMarkdown } from './node'

describe('citeToMarkdown', () => {
  it('renders pandoc-style citation', () => {
    expect(citeToMarkdown('smith2020')).toBe('[@smith2020]')
  })
})

describe('round-trip citations', () => {
  it('preserves a lone citation', () => {
    const md = 'See [@smith2020].\n'
    expect(roundTrip(md)).toBe(md)
  })
  it('preserves mixed inline text', () => {
    const md = 'See [@a] and [@b], plus [@a] again.\n'
    expect(roundTrip(md)).toBe(md)
  })
  it('does not treat plain text as citation', () => {
    const md = 'Emails go to [@ support] and brackets [not a cite].\n'
    expect(roundTrip(md)).toBe(md)
  })
})
```

> 说明：`roundTrip` 走 `serialize.ts` 的 standalone processor——它需要能识别并保留 `[@…]`。本测试用 `roundTrip` 验证「cite 节点 → toMarkdown 输出 `[@key]` → 再解析」的纯文本往返；editor-core 解析端（Milkdown parserCtx）由 Task 2 的 node view / editor 集成测试兜底。若 `roundTrip` 直接能保真（remark 不经 cite 节点也原样输出 `[@key]` 文本），则本测试始终通过——此时需要额外断言 cite 节点确实参与（见 Step 4 的 editor 集成冒烟）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @nekowite/editor-core test`
Expected: FAIL——`citeToMarkdown` 未定义。

- [ ] **Step 3: 实现节点 + remark 预处理**

`packages/editor-core/src/cite/node.ts`：

```ts
import { $node } from '@milkdown/utils'

export interface CiteAttrs {
  key: string
}

export function citeToMarkdown(key: string): string {
  return `[@${key}]`
}

export const cite = $node('cite', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: { key: { default: '' } },
  parseDOM: [{ tag: 'cite[data-cite-key]' }],
  toDOM: (node) => {
    const el = document.createElement('cite')
    el.setAttribute('data-cite-key', String(node.attrs.key))
    el.textContent = citeToMarkdown(String(node.attrs.key))
    return el
  },
  parseMarkdown: {
    match: (n) => n.type === 'nekoCite' && typeof n.value === 'string',
    runner: (state, node, type) => {
      const key = String(node.value ?? '')
        .replace(/^\[@/, '')
        .replace(/\]$/, '')
      state.addNode(type, { key })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'cite',
    runner: (state, node) => {
      state.addNode('html', undefined, citeToMarkdown(String(node.attrs.key ?? '')))
    },
  },
}))
```

`packages/editor-core/src/cite/remark.ts`（预处理 `[@key]` 子串 → `nekoCite` 节点）：

```ts
import { $remark } from '@milkdown/utils'

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
}

const CITE_RE = /\[@([^\]]+)\]/g

function splitCite(value: string): MdNode[] {
  const out: MdNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  CITE_RE.lastIndex = 0
  while ((m = CITE_RE.exec(value)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
    out.push({ type: 'nekoCite', value: m[0] })
    last = m.index + m[0].length
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

function transform(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = []
  for (const node of nodes) {
    if (node.type === 'text' && typeof node.value === 'string' && node.value.includes('[@')) {
      const parts = splitCite(node.value)
      if (parts.length > 1) {
        out.push(...parts)
        continue
      }
    }
    if (node.children && node.children.length > 0) {
      out.push({ ...node, children: transform(node.children) })
    } else {
      out.push(node)
    }
  }
  return out
}

export const citeRemark = $remark<'citeRemark', Record<string, unknown>>(
  'citeRemark',
  () =>
    function citeRemark() {
      return (tree) => {
        const root = tree as MdNode & { children: MdNode[] }
        root.children = transform(root.children)
      }
    },
)
```

`packages/editor-core/src/cite/index.ts`：

```ts
export * from './node'
export * from './remark'
```

- [ ] **Step 4: 接入 basicPlugins + 导出 + 编辑器集成冒烟**

`packages/editor-core/src/plugins/basic.ts`：

```ts
import { cite, citeRemark } from '../cite'
// 在 ...gfm.flat(), 之后：
citeRemark,
cite,
```

`packages/editor-core/src/index.ts` 加 `export * from './cite'`。

editor 集成冒烟（在 `editor.test.ts` 或临时 REPL）：`editor.open('See [@smith2020].')` 后 `editor.save()` 输出含 `[@smith2020]`；若 cite 节点没被解析成节点（只是文本），也仍保真——用 `editor.getView()` 检查 `state.doc` 里存在 `cite` 节点来确认解析端真的产出了节点（这是 Task 2 node view 渲染的前提）。把该检查写成 editor-core 的一个测试（`cite` 出现在 doc 中）。

- [ ] **Step 5: 跑测试**

Run: `pnpm --filter @nekowite/editor-core test`
Expected: 新增测试 PASS，既有 47 个测试不回归。

- [ ] **Step 6: Commit**

```bash
git add packages/editor-core
git commit -m "feat(editor-core): add cite node with remark preprocessing and round-trip serialization"
```

---

### Task 2: cite 节点 Node View（自动编号 [n]）

**Files:**
- Create: `packages/editor-core/src/cite/views.ts`
- Modify: `packages/editor-core/src/cite/index.ts`
- Modify: `packages/editor-core/src/plugins/basic.ts`
- Create: `packages/editor-core/src/cite/views.test.ts`

**Interfaces:**
- Consumes: `cite` node (Task 1); `$view` from `@milkdown/utils`; `EditorView`.
- Produces (EXACT):
  - `citeNodeView: MilkdownPlugin`（`$view`，渲染 `[n]` chip，`n` 为文档内 cite 节点首现顺序 1..N；`inline: true`；点击时复制 `[@key]` 到剪贴板或触发一个可注入回调）。
  - `computeCiteOrder(view: EditorView): Map<string, number>` —— 纯函数：遍历 `view.state.doc` 按深度优先找 `cite` 节点，首次出现的 key 记为 1、2…；重复 key 沿用首次编号。（供 node view 与 app 的 ReferencesPanel 共用同一编号规则。）

- [ ] **Step 1: 写失败测试（computeCiteOrder 纯逻辑）**

`packages/editor-core/src/cite/views.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { createEditor, basicPlugins } from '../editor'
import { computeCiteOrder } from './views'

describe('computeCiteOrder', () => {
  it('numbers by first-appearance order with dedup', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('See [@a], then [@b], then [@a] again.')
    await new Promise((r) => setTimeout(r, 0))
    const order = computeCiteOrder(editor.getView())
    expect(order.get('a')).toBe(1)
    expect(order.get('b')).toBe(2)
    editor.destroy()
  })
})
```

> 若 happy-dom 下 editor.open 后 doc 里没有 cite 节点（解析端未触发），先修 Task 1 的解析集成；本测试是解析端 + 编号的双重验收。

- [ ] **Step 2: 跑测试确认失败 → 实现**

`packages/editor-core/src/cite/views.ts`：

```ts
import { $view } from '@milkdown/utils'
import type { EditorView } from '@milkdown/prose/view'
import type { NodeViewConstructor } from '@milkdown/prose/view'
import { cite } from './node'
import { citeToMarkdown } from './node'

export function computeCiteOrder(view: EditorView): Map<string, number> {
  const order = new Map<string, number>()
  let n = 0
  view.state.doc.descendants((node) => {
    if (node.type.name === 'cite') {
      const key = String(node.attrs.key ?? '')
      if (!order.has(key)) order.set(key, ++n)
    }
    return true
  })
  return order
}

const citeNodeView: NodeViewConstructor = (node, view, getPos) => {
  const dom = document.createElement('span')
  dom.className = 'cite-chip'
  dom.setAttribute('data-cite-key', String(node.attrs.key ?? ''))

  const render = () => {
    const pos = typeof getPos === 'function' ? getPos() : null
    let number = '?'
    if (pos != null) {
      const order = computeCiteOrder(view)
      number = String(order.get(String(node.attrs.key ?? '')) ?? '?')
    }
    dom.textContent = `[${number}]`
    dom.title = citeToMarkdown(String(node.attrs.key ?? ''))
  }
  render()

  return {
    dom,
    inline: true,
    update: (newNode) => {
      if (newNode.type !== node.type) return false
      node = newNode
      render()
      return true
    },
    destroy: () => undefined,
  }
}

export const citeNodeView = $view(cite, () => citeNodeView)
```

> 说明：编号 O(文档规模) 每节点重算一次，v1.2 可接受。`?` 兜底（getPos 不可用）。

- [ ] **Step 3: 接入 basicPlugins + 导出**

`packages/editor-core/src/plugins/basic.ts` 在 `citeRemark, cite` 之后加 `citeNodeView`。`packages/editor-core/src/cite/index.ts` 必须导出 `./views`（Task 4 的 ReferencesPanel 依赖 `computeCiteOrder`）：
```ts
// packages/editor-core/src/cite/index.ts
export * from './node'
export * from './remark'
export * from './views'
```
`packages/editor-core/src/index.ts` 的 `export * from './cite'` 随之覆盖全部。

- [ ] **Step 4: 跑测试 + Commit**

Run: `pnpm --filter @nekowite/editor-core test` → 全绿。
```bash
git add packages/editor-core
git commit -m "feat(editor-core): render numbered citation chips via node view"
```

---

### Task 3: 引用解析服务 + refs store（app 层）

**Files:**
- Create: `apps/desktop/src/services/refs.ts`
- Create: `apps/desktop/src/services/refs.test.ts`
- Create: `apps/desktop/src/stores/refs.ts`
- Create: `apps/desktop/src/stores/refs.test.ts`
- Modify: `apps/desktop/package.json`（加 `@citation-js/*` 依赖）

**Interfaces:**
- Consumes: `fsService` (read file content), existing Pinia pattern.
- Produces (EXACT, Task 4 depends):
  - `type RefFormat = 'bib' | 'ris' | 'csl'`
  - `type Reference = { key: string; title: string; authors: string[]; year: string; type: string }`
  - `detectFormat(filename: string): RefFormat | null`（`.bib`/`.ris`/`.json` 分别 → bib/ris/csl；其余 null）
  - `parseRefs(text: string, format: RefFormat): Reference[]`（包 Citation.js，`new Cite(text, { forceType })` → `.data` 映射成 Reference；key 缺失时用 `.id` 或生成占位）
  - `useRefsStore()`（Pinia）：`refs: Map<string, Reference>`、`refFiles: string[]`、`loadVault(vault: string): Promise<void>`、`search(query: string): Reference[]`、`get(key: string): Reference | undefined`、`clear(): void`

- [ ] **Step 1: 写失败测试（解析 + 检测）**

`apps/desktop/src/services/refs.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { detectFormat, parseRefs } from './refs'

const BIB = `@article{smith2020,
  title = {A Great Paper},
  author = {Smith, John and Doe, Jane},
  year = {2020},
}`

describe('detectFormat', () => {
  it('detects by extension', () => {
    expect(detectFormat('refs.bib')).toBe('bib')
    expect(detectFormat('refs.ris')).toBe('ris')
    expect(detectFormat('refs.json')).toBe('csl')
    expect(detectFormat('notes.md')).toBeNull()
  })
})

describe('parseRefs', () => {
  it('parses bibtex into Reference', () => {
    const refs = parseRefs(BIB, 'bib')
    expect(refs.length).toBeGreaterThan(0)
    const r = refs[0]
    expect(r.key).toBe('smith2020')
    expect(r.title).toContain('Great Paper')
    expect(r.authors).toContain('Smith, John')
    expect(r.year).toBe('2020')
  })
})
```

> 若 Citation.js 解析的字段名/结构与本测试期望不同，按实际输出调整断言（但必须保留 key/title/author 可读）。

- [ ] **Step 2: 跑测试确认失败 → 实现 refs.ts**

`apps/desktop/src/services/refs.ts`：

```ts
import { Cite } from '@citation-js/core'
import '@citation-js/plugin-bibtex'
import '@citation-js/plugin-ris'
import '@citation-js/plugin-csl'

export type RefFormat = 'bib' | 'ris' | 'csl'

export interface Reference {
  key: string
  title: string
  authors: string[]
  year: string
  type: string
}

const FORCE_TYPE: Record<RefFormat, string> = {
  bib: '@bibtex/text',
  ris: '@ris/text',
  csl: '@csl/text',
}

export function detectFormat(filename: string): RefFormat | null {
  if (filename.endsWith('.bib')) return 'bib'
  if (filename.endsWith('.ris')) return 'ris'
  if (filename.endsWith('.json')) return 'csl'
  return null
}

function authorName(a: { family?: string; given?: string } | string | undefined): string {
  if (typeof a === 'string') return a
  if (!a) return ''
  return [a.given, a.family].filter(Boolean).join(' ')
}

export function parseRefs(text: string, format: RefFormat): Reference[] {
  try {
    const cite = new Cite(text, { forceType: FORCE_TYPE[format] })
    return cite.data.map((entry: Record<string, unknown>) => {
      const authors = Array.isArray(entry.author) ? entry.author.map(authorName) : []
      const year =
        (entry.issued as { 'date-parts'?: number[][] } | undefined)?.['date-parts']?.[0]?.[0] ??
        String(entry.year ?? '')
      return {
        key: String(entry.id ?? entry.key ?? ''),
        title: String(entry.title ?? ''),
        authors,
        year: String(year),
        type: String(entry.type ?? ''),
      }
    })
  } catch {
    return []
  }
}
```

> 若 `new Cite(text, { forceType })` 的 API 在该版本不同（如 `Cite.async` 或需要 `inputType`），按实际版本适配并记录。

- [ ] **Step 3: 实现 refs store**

`apps/desktop/src/stores/refs.ts`：

```ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fsService } from '../services/fs'
import { detectFormat, parseRefs, type Reference } from '../services/refs'

export const useRefsStore = defineStore('refs', () => {
  const refs = ref<Map<string, Reference>>(new Map())
  const refFiles = ref<string[]>([])

  async function loadVault(vault: string): Promise<void> {
    refs.value = new Map()
    refFiles.value = []
    const entries = await fsService.list(vault, '.')
    const candidates = entries.filter((e) => detectFormat(e.name) !== null)
    for (const entry of candidates) {
      const format = detectFormat(entry.name)
      if (!format) continue
      try {
        const text = await fsService.read(vault, entry.path)
        const parsed = parseRefs(text, format)
        refFiles.value.push(entry.name)
        for (const r of parsed) {
          if (r.key) refs.value.set(r.key, r)
        }
      } catch {
        // single file failure does not abort others
      }
    }
  }

  function search(query: string): Reference[] {
    const q = query.trim().toLowerCase()
    if (!q) return [...refs.value.values()]
    return [...refs.value.values()].filter((r) =>
      [r.key, r.title, ...r.authors, r.year]
        .filter(Boolean)
        .some((f) => f.toLowerCase().includes(q)),
    )
  }

  function get(key: string): Reference | undefined {
    return refs.value.get(key)
  }

  function clear(): void {
    refs.value = new Map()
    refFiles.value = []
  }

  return { refs, refFiles, loadVault, search, get, clear }
})
```

`apps/desktop/src/stores/refs.test.ts`（mock fsService）：loadVault 索引、search 匹配、get。

- [ ] **Step 4: 跑测试 + 依赖**

`apps/desktop/package.json` dependencies 加：
```json
"@citation-js/core": "^0.7",
"@citation-js/plugin-bibtex": "^0.7",
"@citation-js/plugin-ris": "^0.7",
"@citation-js/plugin-csl": "^0.7"
```
→ `pnpm install` → `pnpm --filter @nekowite/desktop test` / typecheck / lint 全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): add citation parsing service and refs store"
```

---

### Task 4: RefSidebar + ReferencesPanel + editorBridge + 集成

**Files:**
- Create: `apps/desktop/src/services/editorBridge.ts`
- Create: `apps/desktop/src/ui/RefSidebar.vue`
- Create: `apps/desktop/src/ui/ReferencesPanel.vue`
- Create: `apps/desktop/src/services/editorBridge.test.ts`
- Modify: `apps/desktop/src/App.vue`（vault 加载 refs + 布局加侧栏/面板）
- Modify: `apps/desktop/src/view/RenderedPane.vue`（注册 editor 到 bridge）
- Modify: `apps/desktop/src/plugins/callout.ts` 参照（无改动）

**Interfaces:**
- Consumes: `computeCiteOrder` (Task 2), `useRefsStore` (Task 3), `NekoEditor`/`getView()` (editor-core), `tabs` store.
- Produces:
  - `editorBridge = { setEditor(e: NekoEditor | null): void; getView(): EditorView | null }`（模块级单例，RenderedPane 挂载/卸载时 set，RefSidebar 读取）。
  - `RefSidebar.vue`：props 无；搜索输入 + 结果列表（key / title / authors / year）；点击项 → `insertCiteAtCursor(key)`。
  - `ReferencesPanel.vue`：读取当前文档的 cite 顺序（从 active tab 文本 + `computeCiteOrder` 所需——app 端用 `getView()` 或解析文本），渲染编号列表：`[n] key — title (authors, year)`；无引用显示空态。

- [ ] **Step 1: 写失败测试（editorBridge + 插入）**

`apps/desktop/src/services/editorBridge.test.ts`（mock editor-core 的 createEditor 或用真实编辑器）：

```ts
import { describe, expect, it, vi } from 'vitest'
import { editorBridge } from './editorBridge'
import { insertCiteAtCursor } from './editorBridge'

describe('editorBridge', () => {
  it('inserts a cite node at cursor via the registered editor', async () => {
    // mock a minimal NekoEditor-like view
    const dispatch = vi.fn()
    const state = {
      schema: { nodes: { cite: { create: vi.fn(() => ({ node: true })) } } },
      tr: { replaceSelectionWith: vi.fn(() => ({ ok: true })) },
    }
    editorBridge.setEditor({ getView: () => ({ state, dispatch }) } as never)
    insertCiteAtCursor('smith2020')
    expect(state.schema.nodes.cite.create).toHaveBeenCalledWith({ key: 'smith2020' })
    expect(state.tr.replaceSelectionWith).toHaveBeenCalled()
    editorBridge.setEditor(null)
  })
})
```

- [ ] **Step 2: 跑测试确认失败 → 实现 editorBridge.ts**

`apps/desktop/src/services/editorBridge.ts`：

```ts
import type { NekoEditor } from '@nekowite/editor-core'
import type { EditorView } from '@nekowite/prose/view'

let editor: NekoEditor | null = null

export const editorBridge = {
  setEditor(e: NekoEditor | null): void { editor = e },
  getEditor(): NekoEditor | null { return editor },
  getView(): EditorView | null {
    if (!editor) return null
    try { return editor.getView() } catch { return null }
  },
}

export function insertCiteAtCursor(key: string): void {
  const view = editorBridge.getView()
  if (!view) return
  const { state } = view
  const type = state.schema.nodes.cite
  if (!type) return
  const node = type.create({ key })
  view.dispatch(state.tr.replaceSelectionWith(node))
}
```

> 注意：`@nekowite/prose/view` 类型来自 editor-core 的依赖；若 desktop 无法直接 import（未暴露），改用 `ReturnType<typeof editor.getView>` 或 editor-core 导出一个 `EditorView` 类型 re-export。调整并记录。

- [ ] **Step 3: 实现两个 UI 组件**

`RefSidebar.vue`（搜索 + 插入）：

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { useRefsStore } from '../stores/refs'
import { insertCiteAtCursor } from '../services/editorBridge'

const store = useRefsStore()
const query = ref('')

function insert(key: string): void {
  insertCiteAtCursor(key)
  query.value = ''
}
</script>

<template>
  <aside class="ref-sidebar">
    <h3>References</h3>
    <input v-model="query" class="ref-search" placeholder="搜索 key / 标题 / 作者 / 年份" />
    <ul class="ref-list">
      <li v-for="r in store.search(query)" :key="r.key" class="ref-item" @click="insert(r.key)">
        <span class="ref-key">{{ r.key }}</span>
        <span class="ref-title">{{ r.title }}</span>
        <span class="ref-meta">{{ r.authors.join(', ') }} · {{ r.year }}</span>
      </li>
      <li v-if="store.search(query).length === 0" class="ref-empty">
        无匹配引用。请将 .bib / .ris / .json(CSL) 文件放入 vault。
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.ref-sidebar { width: 260px; border-right: 1px solid #e0e0e0; padding: 10px; overflow: auto; }
.ref-search { width: 100%; box-sizing: border-box; padding: 6px; margin-bottom: 8px; }
.ref-list { list-style: none; margin: 0; padding: 0; }
.ref-item { padding: 6px; border-bottom: 1px solid #f0f0f0; cursor: pointer; font-size: 12px; }
.ref-item:hover { background: #f0f7ff; }
.ref-key { font-weight: 700; display: block; }
.ref-title { display: block; color: #333; }
.ref-meta { display: block; color: #888; }
.ref-empty { color: #999; font-size: 12px; padding: 8px; }
</style>
```

`ReferencesPanel.vue`（当前文档编号化引用列表）：

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { computeCiteOrder } from '@nekowite/editor-core'
import { useRefsStore } from '../stores/refs'
import { editorBridge } from '../services/editorBridge'

const refs = useRefsStore()

const cited = computed(() => {
  const view = editorBridge.getView()
  if (!view) return []
  // 复用 editor-core 的统一编号规则（computeCiteOrder），与文档内 [n] chip 完全一致
  const order = computeCiteOrder(view)
  return [...order.entries()].map(([key, num]) => ({ key, num, ref: refs.get(key) }))
})
</script>

<template>
  <section class="references-panel">
    <h3>References</h3>
    <ol v-if="cited.length" class="refs-list">
      <li v-for="c in cited" :key="c.key" class="refs-item">
        [{{ c.num }}] <b>{{ c.key }}</b> — {{ c.ref ? `${c.ref.title} (${c.ref.authors.join(', ')}, ${c.ref.year})` : '（未在引用库中找到）' }}
      </li>
    </ol>
    <p v-else class="refs-empty">本文档还没有引用。</p>
  </section>
</template>

<style scoped>
.references-panel { border-top: 1px solid #e0e0e0; padding: 10px; max-height: 220px; overflow: auto; }
.refs-list { margin: 0; padding-left: 20px; font-size: 12px; }
.refs-empty { color: #999; font-size: 12px; }
</style>
```

> 说明：`computeCiteOrder` 由 editor-core 导出（Task 2/Step 3），ReferencesPanel 直接复用以保证编号一致，不在 app 层重复实现。

- [ ] **Step 4: App.vue / RenderedPane 接线**

- `App.vue`：`import { useRefsStore } from './stores/refs'`；`applyVault` 里 `void refs.loadVault(path)`；`onMounted` 恢复 vault 时同样加载；布局在 `shell-body` 的 FileTree 之后、`main` 之前插入 `<RefSidebar />`，`main` 内 `TabBar`+`EditorPane` 之后（或 StatusBar 之上）插入 `<ReferencesPanel />`（可做成折叠；v1.2 固定展示在底部即可）。
- `RenderedPane.vue`：`onMounted` 里 `editorBridge.setEditor(editor)`；`onBeforeUnmount` 里 `editorBridge.setEditor(null)`（在 `editor.destroy()` 前后均可，注意别在 destroy 后调用 getView）。

- [ ] **Step 5: 跑测试 + 全量回归 + 手动冒烟**

- `pnpm -r test`（editor-core + plugin-host + desktop）全绿。
- `pnpm --filter @nekowite/desktop typecheck` / `lint` / `build`。
- 手动冒烟（若环境允许）：vault 里放一个 `refs.bib` → 启动 → 侧栏出现引用 → 点击插入 → 文档出现 `[@smith2020]` → 渲染视图出现 `[1]` chip → 底部 References 面板显示 `[1] smith2020 — …`。若不可用，记录「待手动验证」。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): add reference sidebar, numbered panel, and editor bridge"
```

---

## Self-Review

**Spec 覆盖检查：**
- .bib/.ris/CSL 导入 → Task 3（parseRefs + loadVault）✅
- `[@citekey]` 侧栏引用 → Task 4（RefSidebar + insertCiteAtCursor）✅
- 自动编号 → Task 2（computeCiteOrder + chip）+ Task 4（ReferencesPanel 复用）✅
- WYSIWYG `[n]` chip → Task 2 node view ✅
- 往返保真 `[@key]` → Task 1（roundTrip + toMarkdown）✅
- 范围红线（无 prefix/locator UI、无导出、无 Zotero）→ 未加入任务 ✅

**占位符检查：** 无 TBD/TODO；Task 1 Step 1 明确说明了 `roundTrip` 可能天然保真、需用 doc 节点断言补强的判定标准；Task 3/4 的 Citation.js / prose type 适配点都有明确替代方案。✅

**类型一致性：**
- `citeToMarkdown(key)`（Task 1）→ Task 2 views 复用 ✅
- `CiteAttrs = { key: string }`（Task 1）→ Task 2/4 attrs 一致 ✅
- `computeCiteOrder(view): Map<string, number>`（Task 2）→ Task 4 ReferencesPanel 复用 ✅
- `Reference`/`RefFormat`/`detectFormat`/`parseRefs`（Task 3）→ Task 4 store 消费 ✅
- `useRefsStore` 的 `refs/search/get/loadVault/clear`（Task 3）→ Task 4 消费 ✅
- `editorBridge.setEditor/getEditor/getView` + `insertCiteAtCursor`（Task 4）→ RenderedPane/RefSidebar 消费 ✅
- `citeNodeView`（Task 2）在 basicPlugins 注册，与 `cite` 节点配套 ✅
