# NekoWite v1.5 FloatBox 浮动盒子 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a floating-element capability via a built-in `FloatBox` MDX component — absolutely positioned over the document, with drag-move / 8-handle resize / rotate / z-order bring-forward-send-backward, round-tripping as plain `<FloatBox x=.. y=.. w=.. h=.. angle=.. z=..>` MDX text and preserving position in HTML/PDF export.

**Architecture:** Zero editor-core changes — FloatBox reuses the existing `mdxComponent` node (`props`+`children` already round-trip) whose `$view` node view mounts a registered Vue component. The FloatBox Vue component renders an absolutely-positioned div (positioning base = the RenderedPane `.editor-container` getting `position:relative`) and implements pointer interactions that dispatch ProseMirror `setNodeMarkup` transactions (updating `props`), with a `useFloatStore` (Pinia) tracking selection + z-layer actions. Export adds a `FloatBox` entry to the `buildComponentRenderers` whitelist and gives the export body container `position:relative`.

**Tech Stack:** existing mdxComponent/Vue node view, Pinia, registry/plugin-host, export renderer whitelist; vitest (happy-dom) for interaction tests. No new deps.

## Global Constraints

- Zero changes to `packages/editor-core` node/serialize/export-core logic (EXCEPT: the one-line `printCss` body `position: relative` addition in `packages/editor-core/src/export/html.ts` is REQUIRED for export fidelity — this is the only core-touch allowed, and it must not regress the 79 editor-core tests).
- New app files live under `apps/desktop/src/plugins/floatbox.ts`, `apps/desktop/src/stores/float.ts`, plus edits to `apps/desktop/src/services/exportRenderers.ts`, `apps/desktop/src/view/RenderedPane.vue` (`.editor-container { position: relative }`), `apps/desktop/src/main.ts` (builtins array + activate), `apps/desktop/src/services/editorBridge.ts` (expose a `setNodeMarkup`-style helper only if needed).
- TypeScript strict; no unused vars/imports; no Chinese code comments (UI strings may be Chinese); English commit messages.
- Before committing: affected package test/typecheck/lint green; `pnpm -r test` (currently 149 JS + 22 Rust + 1 ignored) must not regress.
- pnpm needs `PNPM_STORE_DIR=/tmp/pnpm-store-test/v11` or `--store-dir`.
- The node view interaction tests use happy-dom pointer-event simulation (dispatch `PointerEvent` on the box/handle) — if happy-dom doesn't support PointerEvent fully, fall back to `MouseEvent`-based handlers OR test the pure "given a pointer delta → compute new props → produce transaction" logic extracted into a testable pure function. Prefer extracting pure logic (`applyDrag`, `applyResize`, `applyRotate`) so tests don't depend on DOM event fidelity.

---

### Task 1: FloatBox 组件 + 节点交互（拖拽/缩放/旋转/层级/删除）

**Files:**
- Create: `apps/desktop/src/plugins/floatbox.ts`
- Create: `apps/desktop/src/plugins/floatbox.test.ts`
- Create: `apps/desktop/src/stores/float.ts`
- Modify: `apps/desktop/src/main.ts`（builtins 数组加 floatboxPlugin）

**Interfaces:**
- Consumes: `insertMdxComponent(view, { name, props, children })`（editor-core）、`definePlugin`（plugin-host）、`editorBridge.getView()`、Pinia setup-store pattern（settings/refs）、`MdxComponentAttrs`。
- Produces (EXACT — Task 2/3 depend):
  - `useFloatStore()`（Pinia）：`selectedId: Ref<string | null>`、`select(id: string | null): void`、`bringForward(view): void`（z+1）、`sendBackward(view): void`（z-1）、`removeSelected(view): void`。
  - `floatboxPlugin`（definePlugin）：`components: { FloatBox }` + `toolbar: [{ id: 'floatbox.insert', label: '插入 FloatBox', run: insertFloatBox }]`。
  - `FloatBox` Vue 组件：`props: { x, y, w, h, angle, z, children }`（均为 string，默认给 0/240/160/0/1/''）。
  - 纯函数（供测试，不依赖 DOM）：
    - `normalizeProps(p: Record<string,string>): Required<FloatBoxProps>`（缺省补齐：x=0,y=0,w=240,h=160,angle=0,z=1）
    - `applyDrag(base: {x,y}, dx, dy): {x,y}`（`Math.round(x+dx)`）
    - `applyResize(base: {x,y,w,h}, corner: 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w', dx, dy): {x,y,w,h}`（东南角 = 增 w/h；北/西 = 增而改 x/y；最小尺寸钳制 ≥20）
    - `applyRotate(base: {angle}, dAngleDeg): {angle}`
    - `updateFloatProps(view, pos, propsDelta): void`（`view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, props: { ...oldProps, ...propsDelta } }))` —— 用 editorBridge.getView()）
- 节点渲染：FloatBox 组件 `setup` 里渲染绝对定位 div + 交互。**拿到 node 的 pos 做 setNodeMarkup 需要 getPos** —— mdxComponent 的 node view 目前把 props 原样传给 Vue 组件，**不含 getPos/view**。因此需要在 `packages/editor-core/src/mdx/node.ts` 的 `mdxNodeView` 里，把 `getPos` 作为额外 prop 注入 Vue 组件（`h(component, { ...props, children, _getPos: getPos, _view: view })`）——这是对 core 的最小侵入改动（只在渲染时多传两个 prop，不影响其他组件；`_` 前缀 prop 不会被序列化影响，因为 props 序列化走 `node.attrs.props`，与渲染时传入的额外 prop 无关）。若你担心污染，也可在 FloatBox 内部通过 `editorBridge.getView()` 拿 view、用 `getPos` 从 Vue 组件拿不到——**必须让 node view 传入 getPos**，否则交互无法定位节点。故 Task 1 允许对 `mdx/node.ts` 做这一处最小改动（传 `_getPos`/`_view` prop），并在 report 记录。
- 交互（FloatBox 组件内）：
  - 拖拽：根 div `@pointerdown` 记录起点 + `window` pointermove/pointerup（或 `@pointermove` on root），`applyDrag` → `updateFloatProps`；选中（`floatStore.select(id)`）。id 用 `node.attrs` 里现有 identity？mdxComponent 无 id —— 用 `_getPos()` 作为选中 id（`floatStore.select(String(pos))`），position 变化后 id 漂移可接受（v1.5 简化，report 注明）。
  - 缩放：8 个手柄（`.fb-handle.fb-nw` 等），pointer 序列 → `applyResize` → updateFloatProps。
  - 旋转：顶部 `.fb-rotate-handle`，pointermove 按角度增量 → `applyRotate` → updateFloatProps。
  - 层级：store `bringForward/sendBackward` 调 updateFloatProps({ z: cur+1 })。
  - 删除：`floatStore.removeSelected(view)` 找到 pos 处节点 `tr.delete(pos, pos+node.nodeSize)`。
  - 内容编辑：内容 div `contenteditable`，`@blur` 时把 `el.innerText` 写回 `props.children`（updateFloatProps），再 `el.innerHTML = ''`（node view 会因 attrs 变化重渲染）——v1.5 简化为纯文本往返（不做行内 markdown 富编辑）。
- 测试 `floatbox.test.ts`：normalizeProps 补齐默认；applyDrag/applyResize（含东南角增、北角改 x/y、最小 20 钳制）/applyRotate 纯函数断言；store 的 bringForward/sendBackward（mock view + dispatch spy 断言 setNodeMarkup 被调、z 变化）。若 happy-dom 支持，加一个真实 node view 交互冒烟（可选）。

- [ ] **Step 1: 写失败测试（纯函数 + store）**

`apps/desktop/src/plugins/floatbox.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { normalizeProps, applyDrag, applyResize, applyRotate } from './floatbox'

describe('floatbox geometry', () => {
  it('normalizes missing props', () => {
    expect(normalizeProps({})).toEqual({ x: 0, y: 0, w: 240, h: 160, angle: 0, z: 1 })
  })
  it('drag adds delta', () => {
    expect(applyDrag({ x: 10, y: 20 }, 5, -3)).toEqual({ x: 15, y: 17 })
  })
  it('se-resize grows w/h', () => {
    expect(applyResize({ x: 0, y: 0, w: 100, h: 50 }, 'se', 10, 20)).toEqual({ x: 0, y: 0, w: 110, h: 70 })
  })
  it('nw-resize shifts x/y and grows', () => {
    expect(applyResize({ x: 50, y: 40, w: 100, h: 50 }, 'nw', -5, -10)).toEqual({ x: 45, y: 30, w: 105, h: 60 })
  })
  it('resize clamps minimum size', () => {
    expect(applyResize({ x: 0, y: 0, w: 30, h: 30 }, 'se', -100, -100)).toEqual({ x: 0, y: 0, w: 20, h: 20 })
  })
  it('rotate adds angle delta', () => {
    expect(applyRotate({ angle: 15 }, 5)).toEqual({ angle: 20 })
  })
})
```

`apps/desktop/src/stores/float.test.ts`：

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFloatStore } from './float'

const dispatchMock = vi.hoisted(() => vi.fn())
const trMock = vi.hoisted(() => {
  const tr = { setNodeMarkup: vi.fn(() => tr), delete: vi.fn(() => tr) }
  return tr
})
vi.mock('../services/editorBridge', () => ({
  editorBridge: { getView: vi.fn(() => ({ state: { tr: trMock } as never, dispatch: dispatchMock }) as never) },
}))

describe('useFloatStore', () => {
  beforeEach(() => { setActivePinia(createPinia()); dispatchMock.mockClear(); trMock.setNodeMarkup.mockClear(); trMock.delete.mockClear() })

  it('selects and clears', () => {
    const s = useFloatStore()
    s.select('5')
    expect(s.selectedId).toBe('5')
    s.select(null)
    expect(s.selectedId).toBeNull()
  })

  it('bringForward bumps z via setNodeMarkup', () => {
    const s = useFloatStore()
    s.bringForward()
    expect(trMock.setNodeMarkup).toHaveBeenCalled()
    expect(dispatchMock).toHaveBeenCalled()
  })
})
```

> `bringForward` 里需要读取当前 pos 处节点的 props.z —— 由于 store 拿不到 pos（`_getPos` 在 Vue 组件闭包里），**层级/删除的 pos 依赖选中态的 pos**：`useFloatStore` 增加 `activePos: Ref<number | null>`，组件在选中时 `floatStore.select(String(pos), pos)` 同时记 pos；`bringForward/sendBackward/removeSelected` 用 `activePos`。测试按此契约调整。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @nekowite/desktop test`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 float.ts + floatbox.ts + core 的 getPos prop**

- `stores/float.ts`：`selectedId: Ref<string|null>`、`activePos: Ref<number|null>`、`select(id, pos?)`、`bringForward()/sendBackward()`（经 editorBridge.getView() + setNodeMarkup 更新 props.z；需读当前节点 attrs）、`removeSelected()`（tr.delete(pos, pos+nodeSize)）。
- `plugins/floatbox.ts`：normalizeProps/applyDrag/applyResize/applyRotate/updateFloatProps 纯函数 + `FloatBox` Vue 组件（绝对定位 div + 手柄 + 交互，props 接收 `_getPos`/`_view`）+ `insertFloatBox()`（`insertMdxComponent(view, { name: 'FloatBox', props: {}, children: '浮动内容' })`）+ `floatboxPlugin`（components + toolbar）。
- `packages/editor-core/src/mdx/node.ts` `mdxNodeView`：`h(component, { ...props, children, _getPos: getPos, _view: view })` —— 最小改动（见上）；确认不破坏现有 Callout（它忽略额外 prop）。
- `main.ts` builtins 数组加 `floatboxPlugin`。

- [ ] **Step 4: 跑测试 + Commit**

Run: `pnpm --filter @nekowite/desktop test`（新 + 既有）→ 全绿；`pnpm -r test` 不回归；editor-core typecheck（改了 node.ts）。
```bash
git add packages/editor-core apps/desktop
git commit -m "feat(desktop): add draggable FloatBox component with geometry helpers"
```

---

### Task 2: 编辑区定位基准 + 选中态 UI（层级工具栏）

**Files:**
- Modify: `apps/desktop/src/view/RenderedPane.vue`（`.editor-container { position: relative }`）
- Create: `apps/desktop/src/components/FloatToolbar.vue`
- Modify: `apps/desktop/src/ui/EditorPane.vue`（挂 FloatToolbar）
- Modify: `apps/desktop/src/plugins/floatbox.ts`（组件内选中态样式 class + 选中时调 floatStore.select）

**Interfaces:**
- Consumes: `useFloatStore`（Task 1）、`editorBridge`。
- Produces: `FloatToolbar.vue` —— 当 `floatStore.selectedId` 非空时显示浮动工具栏（置前 / 置后 / 删除按钮，分别调 bringForward/sendBackward/removeSelected）。

- [ ] **Step 1: 写失败测试（FloatToolbar 逻辑可测部分）**

工具函数：`apps/desktop/src/plugins/floatbox.ts` 增加 `canAdjust(view): boolean`（editorBridge.getView() 非空且 store.selectedId 非空）——纯逻辑单测：

```ts
describe('floatbox canAdjust', () => {
  it('true when selected and view available', () => {
    // mock editorBridge.getView → non-null, store.selectedId='5'
    expect(canAdjust()).toBe(true)
  })
  it('false when nothing selected', () => {
    // selectedId=null
    expect(canAdjust()).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败 → 实现**

- `RenderedPane.vue` `.editor-container` 加 `position: relative;`（scoped style）。这是 FloatBox 绝对定位基准。
- `FloatToolbar.vue`：`v-if="floatStore.selectedId"` 的浮动条（右上角 fixed 于 EditorPane），按钮置前/置后/删除 → store 方法；空态隐藏。
- `EditorPane.vue`：渲染 `<FloatToolbar />`（放 WordToolbar 附近或编辑区上方）。
- `floatbox.ts`：组件根 div 当选中时 `class="float-box selected"`；pointerdown 时 `floatStore.select(String(getPos()), getPos())`。
- 补充 CSS：`.float-box { position:absolute; border:1px dashed #ccc; background:#fff; box-sizing:border-box; } .float-box.selected { border-color:#4a90d9; } .fb-handle {...} .fb-rotate-handle {...}` —— 放 `apps/desktop/src/style.css`（全局，node view 渲染在 editor 容器内，scoped 样式不可达）。

- [ ] **Step 3: 跑测试 + Commit**

Run: `pnpm --filter @nekowite/desktop test` 全绿；`pnpm dev` 手动冒烟（插入 FloatBox → 出现绝对定位盒子 → 点击选中 → 工具栏出现）。
```bash
git add apps/desktop
git commit -m "feat(desktop): position editor container and add float toolbar"
```

---

### Task 3: 导出支持（renderer 白名单 + body 定位）

**Files:**
- Modify: `apps/desktop/src/services/exportRenderers.ts`（加 FloatBox）
- Modify: `apps/desktop/src/services/exportRenderers.test.ts`（或 export.test.ts）
- Modify: `packages/editor-core/src/export/html.ts`（`printCss` body 加 `position: relative`）
- Modify: `packages/editor-core/src/export/html.test.ts`（补断言）

**Interfaces:**
- Consumes: `ComponentRenderer` 类型、`renderDocument` 的 renderer 白名单机制。
- Produces: `buildComponentRenderers()` 增加 `FloatBox` 项 —— `(props, childrenHtml) => `<div class="float-box" style="position:absolute; left:{x}px; top:{y}px; width:{w}px; height:{h}px; transform:rotate({angle}deg); z-index:{z}">${childrenHtml}</div>``（x/y/w/h/angle/z 经 normalizeProps 补默认 + attrEscape 转义数值；children 透传）。

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/services/exportRenderers.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { buildComponentRenderers } from './exportRenderers'

describe('FloatBox renderer', () => {
  it('emits absolutely-positioned div with props', () => {
    const out = buildComponentRenderers().FloatBox!({ x: '10', y: '20', w: '100', h: '50', angle: '15', z: '3' }, '<p>hi</p>')
    expect(out).toContain('position:absolute')
    expect(out).toContain('left:10px')
    expect(out).toContain('top:20px')
    expect(out).toContain('width:100px')
    expect(out).toContain('height:50px')
    expect(out).toContain('rotate(15deg)')
    expect(out).toContain('z-index:3')
    expect(out).toContain('<p>hi</p>')
  })
})
```

`packages/editor-core/src/export/html.test.ts` 加：

```ts
it('export body is positioned relative for floats', () => {
  const html = renderDocument('text')
  // printCss body 含 position: relative
  expect(html).toMatch(/body\s*{[^}]*position\s*:\s*relative/)
})
```

- [ ] **Step 2: 跑测试确认失败 → 实现**

- `exportRenderers.ts`：import normalizeProps（从 floatbox.ts，注意避免循环依赖——normalizeProps 是纯函数，放 `apps/desktop/src/services/floatProps.ts` 供 plugins/floatbox.ts 与 exportRenderers.ts 共用，避免 plugins→services 反向 import；**若放 plugins 层，exportRenderers 直接复制一份数值补默认逻辑亦可，但复用更好 → 新建 `services/floatProps.ts` 导出 normalizeProps**，floatbox.ts 改为从该处 import）。
- `html.ts` `printCss`：`body { ... position: relative; }`（一行）。
- `exportRenderers.ts` `buildComponentRenderers` 加 FloatBox。

- [ ] **Step 3: 跑测试 + Commit**

Run: `pnpm -r test` 全绿（editor-core 新断言 + desktop）；`pnpm --filter @nekowite/desktop build` 通过。
```bash
git add packages/editor-core apps/desktop
git commit -m "feat(export): render FloatBox with absolute positioning in exports"
```

---

### Task 4: 全量回归 + 手动冒烟

**Files:**
- Run: `pnpm -r test`（editor-core ≥79 + 新断言, plugin-host 11, desktop ≥新）、`pnpm typecheck`、`pnpm lint`、`pnpm --filter @nekowite/desktop build`、`(cd apps/desktop/src-tauri && cargo test)`（应不受影响，快速确认）。
- 手动冒烟（若可启动）：打开文档 → 工具栏「插入 FloatBox」→ 盒子出现 → 拖拽移动 → 缩放手柄调整 → 旋转手柄 → 置前/置后 → 编辑内容 → 保存 → 重开 → 位置/内容保留；导出 HTML 打开 → 盒子定位保留。若不可启动，记录精确「待手动验证」清单。
- Commit（若有修复）：`"fix: ..."`。

---

## Self-Review

**Spec 覆盖检查：**
- FloatBox 内置组件 + 绝对定位渲染 → Task 1/2 ✅
- 拖拽移动 → Task 1（applyDrag + pointer 交互）✅
- 8 向缩放 → Task 1（applyResize 全手柄 + 最小钳制）✅
- 旋转 → Task 1（applyRotate）✅
- 层级（置前/置后）→ Task 1 store + Task 2 toolbar ✅
- 删除 → Task 1 store.removeSelected ✅
- 编辑区容器 position:relative → Task 2 ✅
- 导出 renderer + body 定位 → Task 3 ✅
- 范围红线（无 FloatImage/多选/环绕/吸附）→ 未加入任务 ✅

**占位符检查：** 无 TBD/TODO；两个需现场确认的（happy-dom PointerEvent 支持度 → 已给纯函数回退方案；`_getPos`/`_view` 注入 → 明确最小改动 + 记录要求）。✅

**类型一致性：**
- `normalizeProps(p): Required<FloatBoxProps>`（Task 1）→ Task 3 exportRenderers 复用（经 services/floatProps.ts）✅
- `applyDrag/applyResize/applyRotate`（Task 1）→ FloatBox 组件交互消费 ✅
- `updateFloatProps(view, pos, propsDelta)`（Task 1）→ 组件 + store 消费 ✅
- `useFloatStore` 的 `selectedId/activePos/select/bringForward/sendBackward/removeSelected`（Task 1）→ Task 2 FloatToolbar 消费 ✅
- `floatboxPlugin`（Task 1）→ Task 2/4 builtins/main.ts 消费 ✅
- `buildComponentRenderers().FloatBox`（Task 3）→ export.ts 现有机制自动生效 ✅
