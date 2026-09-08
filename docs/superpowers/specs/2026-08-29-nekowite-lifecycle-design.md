# NekoWite v1.6 生命周期钩子 Design

- 日期：2026-08-29
- 状态：已确认
- 前置：v1.0–v1.5 已合并至 master；plugin-host 已有 `onLoad/onUnload` + 激活/回滚/隔离

## 1. 目标

为插件系统补充**文档/编辑器生命周期钩子**，让插件能在编辑器创建、文档内容变化、保存、标签开关、视图切换等关键点挂钩并做联动（实时统计、校验、改写保存内容等）。所有钩子与现有 `onLoad/onUnload` 并存，可卸载、激活/停用自动注册/清理，不泄漏。

## 2. 新增钩子（`PluginDefinition` 扩展）

```ts
interface PluginDefinition {
  onLoad?(ctx): void
  onUnload?(ctx): void                        // 已有

  onEditorReady?(ctx, editor: NekoEditor): void
  onDocChange?(ctx, e: { doc: string }): void
  onSave?(ctx, editor: NekoEditor, content: string): string | void   // 保存前，可改写
  onSaved?(ctx, editor: NekoEditor, content: string): void            // 保存后
  onOpenDocument?(ctx, tab: OpenTab): void
  onCloseTab?(ctx, tab: OpenTab): void
  onViewModeChange?(ctx, mode: 'source'|'rendered'|'split'): void
}
```

## 3. 核心机制

### 3.1 订阅上下文 ctx（升级）

- `PluginContext` 现有 `{ id, name, insertComponent }`。
- 升级为包含 `editor?: NekoEditor`（当前活动编辑器，`onEditorReady` 后可用）与 `emit(event: LifecycleEvent, ...args): void`（保留，供 app 层事件总线广播时插件侧接收）。
- 每个钩子回调**返回 unlisten（可选）**：`() => void`，返回则 host 记录并在 `deactivatePlugin` 时调用，用于插件在钩子内自行注册的监听器清理（如 `onEditorReady` 里 `editor.onContentChange(...)` 返回的 unlisten）。

### 3.2 host 注册/清理

- `packages/plugin-host/src/runtime.ts`：`activatePlugin` 时为每个非空钩子注册到 host 内部的事件注册表（`hooks: Map<LifecycleEvent, Array<{ id, fn }>>`）；`deactivatePlugin` 全部移除并调用钩子返回的 unlisten。与现有回滚（组件/命令/工具栏）一致。
- 对外暴露：
  - `emitLifecycle(event, ...args): void`（app 层调用，触发某事件的所有已注册钩子；单钩子抛错隔离，不中断其他钩子）
  - `hasLifecycleListeners(event): boolean`（可测）
- `LifecycleEvent = 'onEditorReady' | 'onDocChange' | 'onSave' | 'onSaved' | 'onOpenDocument' | 'onCloseTab' | 'onViewModeChange'`

### 3.3 app 层广播点（apps/desktop）

| 钩子 | 触发点 |
|---|---|
| `onEditorReady` | RenderedPane 创建 editor 且 `open()` 成功后（`setCalloutView` 同位置附近） |
| `onDocChange` | 编辑器 `onContentChange` 已有回调处（RenderedPane），**节流**（如 500ms 防抖）避免每次击键全量广播 |
| `onSave` / `onSaved` | tabs store `saveActive()`（保存前取 `content` 传给 `onSave`，若返回新串则用之；保存后 `onSaved`） |
| `onOpenDocument` | FileTree 点击打开 / tabs store `openTab` 成功后 |
| `onCloseTab` | tabs store `closeTab` 后 |
| `onViewModeChange` | view store `setMode` 后 |

- `onSave` 改写：`saveActive` 里 `const next = emitLifecycle('onSave', editor, content)` —— 若返回 string 则作为实际写入内容，并同步回 tab.content。

## 4. 实现范围（v1.6）

1. `packages/plugin-host`：`PluginDefinition`/`PluginContext` 类型扩展；`runtime.ts` 钩子注册表 + `activate/deactivate` 自动注册/清理 + 钩子返回 unlisten 处理；`emitLifecycle`/`hasLifecycleListeners` 导出；单测（触发、卸载、隔离、unlisten 调用、回滚）。
2. `apps/desktop`：RenderedPane / tabs store / view store / FileTree 各广播点接线；`onDocChange` 节流。
3. 测试：每个钩子 app 侧触发一次（mock editor/store）+ host 侧注册/清理/隔离；`onSave` 改写内容端到端。

## 5. 范围红线（v1.6 不做）

- 不做插件沙箱（webview/worker）——用户已选仅生命周期钩子。
- 不做主题/侧栏面板/更多注册面（组件/命令/工具栏之外）。
- 不做 `onSave` 之外的异步改写（onSave 同步返回 string 或 void）。
- 不做钩子优先级/顺序配置（按激活顺序执行）。

## 6. 测试策略

- **plugin-host 单测**：`emitLifecycle` 触发所有已注册钩子并传正确 args；单钩子抛错不影响其他；`deactivatePlugin` 移除全部并调用返回的 unlisten；`activatePlugin` 只注册非空钩子。
- **desktop 单测**：各广播点 mock 触发一次且参数正确；`onSave` 改写返回串被用于写入。
- **手动冒烟**：写一个示例插件在 `onDocChange` 里 console/状态栏字数，验证实时联动；`onSave` 改写内容验证。

## 7. 依赖

- 无新第三方依赖（复用 plugin-host runtime、Pinia stores、RenderedPane 已有回调）。
