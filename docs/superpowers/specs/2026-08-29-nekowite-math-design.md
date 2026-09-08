# NekoWite v1.1 数学公式 Design

- 日期：2026-08-29
- 状态：已确认
- 前置：v1.0 核心体验已合并（`packages/editor-core` 的 Milkdown/remark 管道、`apps/desktop` 的工具栏/三态视图）

## 1. 目标

为 NekoWite 添加数学公式能力（对齐 helloMDX 的 MathLive 体验）：工具栏「插入公式」+ 点击公式弹窗可视化编辑 + 源码模式直接写 LaTeX，文件里始终存 `$…$` / `$$…$$` 纯文本，往返保真。

## 2. 技术选型

| 项 | 选型 | 理由 |
|---|---|---|
| 数学渲染/编辑 | **MathLive**（npm `mathlive` 包） | 提供 `<math-field>` web component（可视化公式编辑 + 内建虚拟键盘）、`convertLatexToMarkup` / `convertLatexToMathML` 等渲染工具；helloMDX 同款 |
| 解析管道 | **remark-math**（`remark-math` + `remark-stringify` 的 math 支持） | `$…$` → `inlineMath`、`$$…$$` → `displayMath` ast 节点，与现有 remark 管道天然衔接 |
| 节点 | Milkdown `$node`（`math_inline` / `math_display`） | 与现有 `mdxComponent` 一致的自定义节点模式 |

## 3. 核心设计

### 3.1 节点

- `math_inline`：`group: 'inline'`，attrs `{ latex: string }`，对应用例 `$E=mc^2$`。
- `math_display`：`group: 'block'`，attrs `{ latex: string }`，对应用例 `$$…$$`。
- 节点渲染：WYSIWYG 视图中用 MathLive 把 latex 渲染为只读公式（`convertLatexToMarkup` 或轻量），点击公式节点触发编辑弹窗。

### 3.2 编辑弹窗（MathEditorDialog）

- 工具栏「插入公式」→ 按当前选择决定插入行内 `$…$` 或块级 `$$…$$` → 打开弹窗。
- 点击已有公式 → 带当前 latex 打开弹窗。
- 弹窗内含一个 `<math-field>` 实例（MathLive 可视化编辑）+ 内建虚拟键盘。
- 确认：从 `<math-field>` 读取 latex → 写回文档（新插或替换）。
- 取消：不改动。

### 3.3 序列化往返

- 解析：remark 管道 `use remarkMath`，`$…$`→`inlineMath`、`$$…$$`→`displayMath`。
- 序列化：将 ast 节点文本写回 markdown；字符串 processor 配置 `singleDollarTextMath` 等以保持 `$…$` 形式。
- 目标：`$E=mc^2$` → 保存 → 重开 → 仍为 `$E=mc^2$`（字节保真测试）。
- 注解（已确认）：正文中孤立的裸 `$`（如价格 `$5`、货币说明）会被 remark-stringify 规范化转义为 markdown 字面形式 `\$`（`roundTrip('Cost is $5.')` → `Cost is \$5.`），幂等且语义无损；这属于 v1.1 认可的标准规范化，代码与测试均已固定该行为。

### 3.4 公式键盘

- 直接使用 MathLive 内建虚拟键盘（Symbols / Greek / 模板 / 计算模板），不额外开发。

## 4. 实现范围（v1.1）

1. 定义 `math_inline` + `math_display` 节点（`packages/editor-core/src/math/`）
2. 集成 remark-math 到序列化管道（`serialize.ts`）
3. MathLive 渲染（只读公式显示于 WYSIWYG）
4. MathEditorDialog 弹窗（新建 + 点击已有公式编辑）
5. 工具栏「插入公式」按钮（行内/块级）
6. 点击公式 → 编辑
7. 往返保真测试 `$…$` / `$$…$$`

## 5. 范围红线（v1.1 不做）

- 不集成引用/自动编号（v1.2）
- 不做公式补全/AI 建议（v1.4）
- 不导出原生 Word 公式（保留 LaTeX）
- 不做公式的复制/拖拽等高级交互

## 6. 测试策略

- **序列化单测（vitest，重点）**：`$…$`/`$$…$$` 经 `roundTrip` 字节保真；行内/块级边界（`$` 转义、数学含下划线 `_` 不触发强调等）。
- **节点单测**：insert/laTex 序列化。
- **MathLive 渲染**：happy-dom 下 Web Component 渲染冒烟（真实渲染依赖浏览器，E2E/手动验证兜底）。
- **E2E（可选补充）**：插入公式 → 渲染出现公式元素。

## 7. 依赖

- `mathlive`：运行时依赖（`packages/editor-core`）。
- `remark-math`：运行时依赖。
- `@types/mathlive`（如存在）或扩展声明。
