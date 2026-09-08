# NekoWite v1.6 生命周期钩子 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add document/editor lifecycle hooks to the plugin system — plugins can hook editor-ready, doc-change, save-before/after, tab-open/close, and view-mode-change events, all un-registrable on deactivate, isolated per-plugin on error, reusing the existing plugin-host activation/rollback model.

**Architecture:** Extend `PluginDefinition` in `packages/plugin-host` with 7 optional hooks + upgrade `PluginContext` (`editor?`, `emit`). `runtime.ts` gains an internal hook registry (`hooks: Map`), `emitLifecycle(event, ...args)` and `hasLifecycleListeners(event)`; `activatePlugin` registers non-empty hooks (capturing the per-plugin ctx built at activation), `deactivatePlugin` removes them AND calls any unlisten each hook returned. The app layer broadcasts at the natural points: RenderedPane (onEditorReady after `open()`, onDocChange throttled at the existing `onContentChange`), tabs store (onOpenDocument/onCloseTab, onSave/onSaved in saveActive with rewrite support), view store (onViewModeChange in setMode). Scope is lifecycle hooks ONLY (no sandbox/themes/panels per user decision).

**Tech Stack:** existing plugin-host runtime (`types.ts`/`runtime.ts`), Pinia stores, vitest/happy-dom. No new deps.

## Global Constraints

- Changes confined to `packages/plugin-host` (types/runtime) + `apps/desktop` (stores/RenderedPane). No editor-core changes.
- TypeScript strict; no unused vars/imports; no Chinese code comments (UI strings may be Chinese); English commit messages.
- Before committing: affected package test/typecheck/lint green; `pnpm -r test` (currently 175 JS + Rust 22 + 1 ignored) must not regress.
- pnpm needs `PNPM_STORE_DIR=/tmp/pnpm-store-test/v11` or `--store-dir`.
- Existing plugin APIs (`onLoad`/`onUnload`, `definePlugin`, `activatePlugin`/`deactivatePlugin` semantics, rollback) stay byte-compatible — the new hooks are additive.
- `onSave` rewrite is synchronous (returns `string | void`); last non-void return wins.
- `emitLifecycle` isolation: a throwing hook never blocks other hooks (try/catch per hook, like existing deactivatePlugin).
- `onDocChange` MUST be throttled (≥300ms debounce) so keystrokes don't broadcast per character.

---

### Task 1: plugin-host 生命周期类型 + 钩子注册表 + emitLifecycle

**Files:**
- Modify: `packages/plugin-host/src/types.ts`
- Modify: `packages/plugin-host/src/runtime.ts`
- Create: `packages/plugin-host/src/lifecycle.ts`（钩子注册表 + emitLifecycle + hasLifecycleListeners）
- Create: `packages/plugin-host/src/lifecycle.test.ts`
- Modify: `packages/plugin-host/src/index.ts`（导出 lifecycle）

**Interfaces:**
- Consumes: existing `PluginContext`, `activatePlugin`/`deactivatePlugin`.
- Produces (EXACT — Task 2 depends):
  - `export type LifecycleEvent = 'onEditorReady' | 'onDocChange' | 'onSave' | 'onSaved' | 'onOpenDocument' | 'onCloseTab' | 'onViewModeChange'`
  - `export interface LifecycleEventArgMap { onEditorReady: [editor: unknown]; onDocChange: [e: { doc: string }]; onSave: [editor: unknown, content: string]; onSaved: [editor: unknown, content: string]; onOpenDocument: [tab: unknown]; onCloseTab: [tab: unknown]; onViewModeChange: [mode: unknown] }`（`unknown` 参数类型，app 层实测推送具体结构）
  - `export function emitLifecycle(event: LifecycleEvent, ...args: unknown[]): string | void` —— 依次调用该事件所有已注册钩子 `fn(ctx, ...args)`；`onSave` 时若钩子返回 string 记录为 next，最后返回非 void 的 next；单钩子抛错吞掉并继续。
  - `export function hasLifecycleListeners(event: LifecycleEvent): boolean`
  - `export function registerLifecycleHook(id: string, event: LifecycleEvent, fn: (...args: any[]) => unknown, ctx: PluginContext): () => void` —— 加入注册表并捕获 ctx，返回 unregister。
  - `PluginDefinition` 增加可选钩子（Task 1 Step 3 精确签名）；`PluginContext` 增加 `editor?: unknown`（占位，实际 NekoEditor 由 app 层在广播时经 emit 携带）。

- [ ] **Step 1: 写失败测试**

`packages/plugin-host/src/lifecycle.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import { emitLifecycle, hasLifecycleListeners, registerLifecycleHook } from './lifecycle'

const ctx = { id: 'p1', name: 'P1', insertComponent: () => {} } as never

describe('lifecycle hooks', () => {
  it('emitLifecycle calls registered hooks in order with ctx', () => {
    const a = vi.fn(); const b = vi.fn()
    registerLifecycleHook('p1', 'onDocChange', a, ctx)
    registerLifecycleHook('p2', 'onDocChange', b, ctx)
    emitLifecycle('onDocChange', { doc: 'x' })
    expect(a).toHaveBeenCalledWith(ctx, { doc: 'x' })
    expect(b).toHaveBeenCalledWith(ctx, { doc: 'x' })
  })

  it('isolation: a throwing hook does not block others', () => {
    const boom = vi.fn(() => { throw new Error('boom') })
    const ok = vi.fn()
    registerLifecycleHook('p1', 'onSaved', boom, ctx)
    registerLifecycleHook('p2', 'onSaved', ok, ctx)
    expect(() => emitLifecycle('onSaved', null, 'c')).not.toThrow()
    expect(ok).toHaveBeenCalled()
  })

  it('unregister removes the hook', () => {
    const fn = vi.fn()
    const un = registerLifecycleHook('p1', 'onOpenDocument', fn, ctx)
    un()
    emitLifecycle('onOpenDocument', { id: 't1' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('onSave last non-void string wins', () => {
    registerLifecycleHook('p1', 'onSave', () => 'first', ctx)
    registerLifecycleHook('p2', 'onSave', () => 'second', ctx)
    expect(emitLifecycle('onSave', null, 'orig')).toBe('second')
  })

  it('hasLifecycleListeners reflects registration', () => {
    const un = registerLifecycleHook('p1', 'onViewModeChange', () => {}, ctx)
    expect(hasLifecycleListeners('onViewModeChange')).toBe(true)
    un()
    expect(hasLifecycleListeners('onViewModeChange')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @nekowite/plugin-host test`
Expected: FAIL——`lifecycle` 模块不存在。

- [ ] **Step 3: 实现 lifecycle.ts + 类型扩展**

`packages/plugin-host/src/lifecycle.ts`：

```ts
import type { PluginContext } from './types'

export type LifecycleEvent =
  | 'onEditorReady' | 'onDocChange' | 'onSave' | 'onSaved'
  | 'onOpenDocument' | 'onCloseTab' | 'onViewModeChange'

interface HookEntry {
  id: string
  fn: (...args: unknown[]) => unknown
  ctx: PluginContext
}

const hooks = new Map<LifecycleEvent, HookEntry[]>()

export function registerLifecycleHook(
  id: string,
  event: LifecycleEvent,
  fn: (...args: unknown[]) => unknown,
  ctx: PluginContext,
): () => void {
  const entry: HookEntry = { id, fn, ctx }
  const list = hooks.get(event) ?? []
  list.push(entry)
  hooks.set(event, list)
  return () => {
    const cur = hooks.get(event) ?? []
    const i = cur.indexOf(entry)
    if (i >= 0) cur.splice(i, 1)
  }
}

export function hasLifecycleListeners(event: LifecycleEvent): boolean {
  return (hooks.get(event)?.length ?? 0) > 0
}

export function emitLifecycle(event: LifecycleEvent, ...args: unknown[]): string | void {
  let next: string | void
  for (const entry of hooks.get(event) ?? []) {
    try {
      const r = entry.fn(entry.ctx, ...args)
      if (event === 'onSave' && typeof r === 'string') next = r
    } catch { /* isolation: one plugin's failure never blocks others */ }
  }
  return next
}
```

`packages/plugin-host/src/types.ts` 扩展：

```ts
export interface PluginContext {
  id: string
  name: string
  insertComponent: (name: string) => void
  editor?: unknown // populated by the app after onEditorReady
}

export interface PluginDefinition extends RegistrationBatch {
  name?: string
  components?: Record<string, Component>
  toolbar?: ToolbarItem[]
  commands?: EditorCommand[]
  onLoad?(ctx: PluginContext): void
  onUnload?(ctx: PluginContext): void
  onEditorReady?(ctx: PluginContext, editor: unknown): void | (() => void)
  onDocChange?(ctx: PluginContext, e: { doc: string }): void | (() => void)
  onSave?(ctx: PluginContext, editor: unknown, content: string): string | void | (() => void)
  onSaved?(ctx: PluginContext, editor: unknown, content: string): void | (() => void)
  onOpenDocument?(ctx: PluginContext, tab: unknown): void | (() => void)
  onCloseTab?(ctx: PluginContext, tab: unknown): void | (() => void)
  onViewModeChange?(ctx: PluginContext, mode: unknown): void | (() => void)
}
```

> 每个钩子可返回 `() => void` 作为该钩子注册的自有监听器（如 onEditorReady 里 `editor.onContentChange(...)` 的 unlisten），host 在 deactivate 时调用。

- [ ] **Step 4: runtime.ts 接线（activate 注册 / deactivate 清理）**

`packages/plugin-host/src/runtime.ts`：
- 引入 `registerLifecycleHook` + `LifecycleEvent`。
- `activatePlugin`：构建一次 `ctx`（现在的 onLoad ctx），在 `onLoad?.()` 之后，遍历 `definition` 的 7 个钩子，对每个非空钩子 `registerLifecycleHook(id, event, fn, ctx)` 并把返回的 unregister 存入 `active` 记录；`onLoad` 的返回也作为 unlisten 处理（如有）。**钩子注册加入 try 保护**（注册发生在 onLoad 之后、active.set 之前；失败走现有 catch 回滚时，也要把已注册钩子 unregister 掉——在 catch 分支补 hook-uneustg）。`ActivePlugin` 增加 `hookUnregisters: Array<() => void>`。
- `deactivatePlugin`：先调用 `plugin.hookUnregisters` 里的 unlisten（**先调 unlisten 再 unregister**，使插件在钩子内注册的监听器先释放），再逐个 `un()` 注册表项；保持现有 try/catch/finally。

- [ ] **Step 5: index.ts 导出 + 跑测试 + Commit**

`packages/plugin-host/src/index.ts` 加 `export * from './lifecycle'`。
Run: `pnpm --filter @nekowite/plugin-host test` 全绿（新 + 既有 11）；`pnpm -r test` 不回归；typecheck/lint。
```bash
git add packages/plugin-host
git commit -m "feat(plugin-host): add lifecycle hooks registry and emit API"
```

---

### Task 2: app 层广播点接线

**Files:**
- Modify: `apps/desktop/src/view/RenderedPane.vue`（onEditorReady + onDocChange 节流）
- Modify: `apps/desktop/src/stores/tabs.ts`（onOpenDocument/onCloseTab/onSave/onSaved】
- Modify: `apps/desktop/src/stores/view.ts`（onViewModeChange）
- Modify: `apps/desktop/src/stores/tabs.test.ts`（新增广播断言）、`apps/desktop/src/stores/view.test.ts`（新增）
- Modify（可选）: `apps/desktop/src/plugins/status.ts` 或新增示例插件用于冒烟

**Interfaces:**
- Consumes: `emitLifecycle`/`hasLifecycleListeners`（Task 1）、`NekoEditor`、现有 stores。
- Produces: 各广播点的正确接线；`onSave` 改写内容路径。

- [ ] **Step 1: 写失败测试（onSave 改写 + onOpenDocument/onCloseTab/onViewModeChange 触发）**

`apps/desktop/src/stores/tabs.test.ts` 增：

```ts
// mock ../services/fs + ../services/errors + 注入 emitLifecycle
// 用 vi.mock('../lifecycle') 困难（跨包），改 mock '@nekowite/plugin-host' 的 emitLifecycle 或直接 spy
```

> 由于 tabs store 从 `@nekowite/plugin-host` import `emitLifecycle`，测试用 `vi.mock('@nekowite/plugin-host', () => ({ emitLifecycle: vi.fn(), ... }))`（需同时保留 definePlugin 等被 store 引用项，或仅 mock emitLifecycle）。tabs.test.ts 是桌面包，`@nekowite/plugin-host` 是 workspace 依赖——`vi.mock` 对整个 module 生效，需 `vi.importActual` 合并。**取更稳做法**：不 mock 包，而是给 tabs store 的广播做「真实 emitLifecycle + 注册一个 spy 钩子」的集成断言（registerLifecycleHook 一个 onSave 钩子返回改写串，再调 saveActive，断言写入内容）。

测试示例（tabs.test.ts 增）：

```ts
import { registerLifecycleHook } from '@nekowite/plugin-host'

describe('lifecycle broadcast from tabs store', () => {
  it('onSave rewrite changes what is written to disk', async () => {
    // 构造 active tab（path non-null, vault set, content 'abc'）
    // registerLifecycleHook('test', 'onSave', () => 'abc!', ctx)
    // await store.saveActive()
    // 断言 fsService.write 被以 'abc!' 调用，且 tab.content === 'abc!'
  })
})
```

`apps/desktop/src/stores/view.test.ts` 增：`setMode('source')` 后若注册了 `onViewModeChange` 钩子则被调用且参数为 'source'。

- [ ] **Step 2: 跑测试确认失败 → 实现**

- `view.ts` `setMode`：`emitLifecycle('onViewModeChange', mode.value)` 在 mode 更新后。
- `tabs.ts`：
  - `openTab` 成功后（tab push 后）`emitLifecycle('onOpenDocument', { id: tab.id, path: tab.path })`。
  - `closeTab` 移除前 `emitLifecycle('onCloseTab', { id, path: t.path })`。
  - `saveActive`：`const next = emitLifecycle('onSave', undefined, t.content); const content = typeof next === 'string' ? next : t.content; if (next === content) content 用到；写入 content；写后 `emitLifecycle('onSaved', undefined, content)`；若改写，`t.content = content`（保持模型同步）。
- `RenderedPane.vue`：
  - onMounted 里 `editor.open(...)` 成功后（`setCalloutView` 附近）`emitLifecycle('onEditorReady', editor)`。
  - onContentChange 回调里把「写回 tab.content 的 markdown」节流后 `emitLifecycle('onDocChange', { doc })`（用 `setTimeout` 300ms 防抖，卸载时 clear）。
  - 注意：不要把 ghost-text/suggest 或 FloatBox 交互误触发——`onDocChange` 只应在真实文档内容变化后广播（编辑器 onChange 已有 guard）。

- [ ] **Step 3: 跑测试 + Commit**

Run: `pnpm --filter @nekowite/desktop test`（新 + 既有）全绿；`pnpm -r test`；typecheck/lint。
```bash
git add apps/desktop
git commit -m "feat(desktop): broadcast lifecycle hooks from editor and stores"
```

---

### Task 3: 全量回归 + 示例插件冒烟

**Files:**
- Modify: `apps/desktop/src/plugins/status.ts`（可选：加一个 onDocChange 字数联动示例，验证真实联动）
- Run: `pnpm -r test`（editor-core 80, plugin-host ≥11+新, desktop ≥84+新）、`pnpm typecheck`、`pnpm lint`、`pnpm --filter @nekowite/desktop build`、`(cd apps/desktop/src-tauri && cargo test)`（快速确认）。
- 冒烟（若可启动）：打开文档 → 输入 → 示例插件 onDocChange 状态栏字数实时更新；保存 → onSave/onSaved 触发（可用 console）；切换三态视图 → onViewModeChange 触发。不可启动则记录「待手动验证」。

**Commit**（若有修复）：`"fix: ..."`。

---

## Self-Review

**Spec 覆盖：**
- 7 个钩子类型 → Task 1 ✅
- ctx 升级（editor?）→ Task 1 types ✅
- host 注册/清理/unlisten → Task 1 runtime ✅
- emitLifecycle/hasLifecycleListeners → Task 1 ✅
- app 广播点（onEditorReady/onDocChange 节流/onSave 改写/onSaved/onOpenDocument/onCloseTab/onViewModeChange）→ Task 2 ✅
- 隔离/回滚 → Task 1 ✅（复用既有 catch）
- 红线（无沙箱/主题/面板）→ 未加入任务 ✅

**占位符检查：** 无 TBD；onSave「last non-void」、节流 300ms、unlisten-before-unregister 均有明确语义。✅

**类型一致性：**
- `LifecycleEvent` / `emitLifecycle(event, ...args): string|void` / `hasLifecycleListeners` / `registerLifecycleHook(id,event,fn,ctx): ()=>void`（Task 1）→ Task 2 消费 ✅
- `PluginDefinition` 7 个钩子签名（Task 1）→ runtime 遍历注册（Task 1）✅
- `PluginContext.editor?: unknown` → app 广播时经 emit 携带实参 ✅