# NekoWite v1.5 FloatBox 浮动盒子 Design

- 日期：2026-08-29
- 状态：已确认
- 前置：v1.0–v1.4 已合并至 master（mdxComponent 节点 + Vue node view + 内置插件注册 + export renderer 白名单 + 三态视图）

## 1. 目标

提供**浮动元素**能力（自由画布辅助）：一个内置 MDX 组件 `FloatBox`，在文档上方绝对定位渲染，支持拖拽移动、8 向缩放、旋转、层级（置前/置后）。文件里始终是纯 MDX 文本（`<FloatBox x=.. y=.. w=.. h=.. angle=.. z=..>…内容…</FloatBox>`），往返保真，导出时保留定位。

## 2. 技术选型

| 项 | 选型 | 理由 |
|---|---|---|
| 存储/往返 | 复用 `mdxComponent` 节点（props + children 已支持） | 零内核改动，`<FloatBox ...>` 天然是 MDX 文本 |
| 编辑器渲染 | 内置 Vue 组件 + `$view` node view（绝对定位 div） | 与 Callout 同模式；编辑区容器 `position:relative` 作基准 |
| 导出 | export renderer 白名单加 FloatBox（内联定位） | v1.3 机制已有，导出所见即所得 |
| 交互 | Vue 组件内 pointer 事件 → dispatch 事务改 node attrs | 拖拽/缩放/旋转/层级全部落在 `props`，进文档 |

## 3. 核心设计

### 3.1 组件与属性

- `FloatBox`：MDX 组件，attrs/props：
  - `x`、`y`（px，相对编辑区容器的左上角）
  - `w`、`h`（px，盒子尺寸）
  - `angle`（度，旋转）
  - `z`（层级，int）
  - `children`（内容，文本/行内 markdown；经 `mdxComponentToMarkdown` 往返）
- 文件表示：`<FloatBox x="120" y="80" w="240" h="160" angle="15" z="3">内容</FloatBox>`（缺省属性省略或给默认值，序列化时补齐默认）。

### 3.2 渲染

- **编辑区容器**（RenderedPane 的 `.editor-container`）加 `position: relative` —— 作为浮动元素的定位基准。
- **node view**：注册 FloatBox 组件，渲染 `<div class="float-box" style="position:absolute; left:{x}px; top:{y}px; width:{w}px; height:{h}px; transform:rotate({angle}deg); z-index:{z}">`。内容区可编辑（`contenteditable` 或经 mdx children 往返）。
- 内容编辑：FloatBox 内部内容以 markdown 文本编辑（简单做法：内容 div contenteditable，失焦时把文本写回 node attrs.children，走往返）。

### 3.3 交互

- **选中**：点击 FloatBox → 显示边框 + 8 个缩放手柄 + 顶部旋转手柄；选中态由前端 `useFloatStore`（Pinia，`selectedId`）管理。
- **拖拽移动**：pointerdown 记录起点，pointermove 更新 `x/y`，pointerup 结束；每次变更 dispatch 事务 `setNodeMarkup(pos, null, { x, y })`。
- **缩放**：8 个手柄分别改 `w/h`（角手柄按比例）。
- **旋转**：顶部手柄围绕中心更新 `angle`。
- **层级**：选中态浮动工具栏「置前/置后」→ `z += 1 / z -= 1`。
- **删除**：选中后按 Delete/Backspace（或工具栏删除）→ 移除该节点。
- 交互只在 `rendered`（WYSIWYG）视图生效；source 视图就是普通文本。

### 3.4 导出

- `buildComponentRenderers()`（export）加 `FloatBox` → `<div style="position:absolute; left/..; width/..; height/..; transform:rotate(..); z-index:..">childrenHtml</div>`，外层 body 容器需 `position:relative`（导出 CSS 里给 body 容器加）。这与编辑器所见一致。

## 4. 实现范围（v1.5）

1. editor-core：无需内核改动（复用 mdxComponent）；确认 `mdxJsxMdast` 对 `<FloatBox>` 自闭合/带 children 都能收敛（已有测试覆盖）。
2. app：`plugins/floatbox.ts` 注册 FloatBox 组件（node view + 交互）+ `useFloatStore`（选中/层级）。
3. export：renderer 白名单加 FloatBox + 导出容器 `position:relative`。
4. 测试：FloatBox 序列化往返、renderer 输出、node view 交互（拖拽改 attrs）。

## 5. 范围红线（v1.5 不做）

- 不做 FloatImage / FloatSticker / 文本批注（后续可加同模式组件）。
- 不做多选 / 框选 / 对齐辅助线 / 吸附网格。
- 不做浮动元素与文字环绕（floats 悬浮于文字之上即可）。
- 不做撤销粒度优化（复用 ProseMirror 事务历史）。

## 6. 测试策略

- **序列化单测**：`<FloatBox ...>内容</FloatBox>` 经 roundTrip 字节保真；缺省属性补齐。
- **renderer 单测**：FloatBox 输出含 `position:absolute; left:{x}px; ...` inline style + childrenHtml。
- **node view 交互单测（happy-dom）**：拖拽 pointer 序列 → dispatch 事务 attrs.x/y 变化；缩放/旋转/层级同理；Delete 移除节点。
- **E2E/手动**：插入 FloatBox → 拖拽/缩放/旋转/置前 → 保存 → 重开 → 位置保留；导出 HTML 保留定位。

## 7. 依赖

- 无新第三方依赖（复用 Vue、mdxComponent、registry、export renderer 基础设施）。
