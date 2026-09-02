# NekoWite B 项：Gateway 分层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入 gateway 分层——所有 Tauri 调用收敛到接口化 gateway，并提供浏览器内存实现（`pnpm dev` 纯前端可演示），同时桌面 Tauri 行为不变；组件/store 零直接 `invoke`。

**Architecture:** 定义 `FsGateway`/`AiGateway`/`KeyGateway` 接口（`services/gateways.ts`），`tauri.ts`（现有 invoke 逻辑迁移，契约不变）+ `memory.ts`（内存 Map + 虚拟目录树）两套实现，`getGateways()` 按 `window.__TAURI_INTERNALS__` 选择。`services/fs.ts` 转发到 gateway（保留 `fsService` 名字，消费方零改动）；`ai.ts`/`settings.ts` 的 invoke 收敛到 gateway。

**Tech Stack:** TypeScript, Vue/Pinia stores, vitest.

## Global Constraints

- 只动 `apps/desktop/src/services/`（新增 gateways 目录 + 改 fs.ts/ai.ts）+ `stores/settings.ts` 的 key invoke。消费方（tabs/refs/export/plugins/FileTree/SettingsPanel）的 import 名不变。
- **不改** Rust 命令/契约；**不做** gateway 之外的架构重构；A+F 在 gateway 之上下一轮做。
- 英文 commit message；`pnpm -r test` 全绿（220 保持）+ typecheck/lint；E2E 2/2。
- pnpm 命令需 `PNPM_STORE_DIR=/tmp/pnpm-store-test/v11`。

---

### Task 1: Gateway 接口 + Tauri 实现 + getGateways 选择器

**Files:**
- Create: `apps/desktop/src/services/gateways.ts`（接口）
- Create: `apps/desktop/src/services/gateways/tauri.ts`
- Create: `apps/desktop/src/services/gateways/index.ts`（getGateways）
- Create: `apps/desktop/src/services/gateways/index.test.ts`
- Modify: `apps/desktop/src/services/fs.ts`（转发到 `getGateways().fs`）

**Interfaces:**
- Consumes: 现有 `fs.ts` 的 invoke/listen 逻辑、`ai.ts` 的 invoke、`settings.ts` 的 key invoke。
- Produces (EXACT — Task 2/3 依赖):
  - `services/gateways.ts`: `FileEntry`/`FsChangeEvent` 类型（与现 fs.ts 一致）；`FsGateway`/`AiGateway`/`KeyGateway`/`AppGateways` 接口（spec §3.1）。
  - `services/gateways/tauri.ts`: `tauriFsGateway`/`tauriAiGateway`/`tauriKeyGateway` —— 命令名/参数与原 `invoke` 完全一致（read_file/write_file/list_dir/watch_folder/open_folder_dialog/save_file_dialog/fs-change/ai_complete/ai_cancel/store_ai_key/load_ai_key）。
  - `services/gateways/index.ts`: `getGateways(): AppGateways` —— `typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__ ? tauri : memory`（memory 在 Task 2 实现；先存占位或同步实现）。

- [ ] **Step 1: 写失败测试（选择器）**

`apps/desktop/src/services/gateways/index.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from 'vitest'
import { getGateways } from './index'

describe('getGateways', () => {
  afterEach(() => { vi.stubGlobal('window', undefined); vi.unstubAllGlobals() })

  it('returns tauri gateways when Tauri internals are present', () => {
    ;(globalThis as any).window = { __TAURI_INTERNALS__: {} }
    expect(getGateways().fs.read).toBeTypeOf('function')
    expect((getGateways() as any).__source).toBe('tauri')
  })

  it('returns memory gateways when running in a plain browser', () => {
    ;(globalThis as any).window = {}
    expect(getGateways().fs.read).toBeTypeOf('function')
    expect((getGateways() as any).__source).toBe('memory')
  })
})
```

> `__source` 调试字段用于测试可判定；若你不想加，改用「memory fs 的 list 返回虚拟根且无 invoke 依赖」来断言。**推荐**：`AppGateways` 接口内不放 `__source`（纯接口），用 `getGateways().fs.list('memoir://demo','.')` 在 memory 下成功、tauri 下（无 mock invoke）会 reject——以此区分。测试按最终方案调整。

- [ ] **Step 2: 跑测试确认失败 → 实现**
- `gateways.ts` 接口。
- `gateways/tauri.ts`（迁移现 fs.ts 的 invoke/listen；ai/key 的 invoke 照抄参数）。
- `gateways/index.ts` getGateways 选择器（模块级单例缓存）。
- `fs.ts` 改为 `export const fsService = getGateways().fs`（保留类型 `FileEntry`/`FsChangeEvent` re-export 以不破坏消费方 import）。检查既有 `fs.test.ts`（mock `../services/fs` 为 `{ fsService: {...} }`）是否仍兼容——若 mock 的是 fsService 对象整体，转发不破坏；若有测试断言 fsService 的具体 invoke 行为，需调整（tauri gateway 下行为相同）。

- [ ] **Step 3: 跑测试 + Commit**
Run: `pnpm --filter @nekowite/desktop test` 全绿 → typecheck/lint → `pnpm -r test` 不回归 → E2E 2/2。
```bash
git add apps/desktop/src/services
git commit -m "feat(desktop): add gateway interfaces and tauri implementation"
```

---

### Task 2: 浏览器内存 gateway 实现（memory.ts）

**Files:**
- Create: `apps/desktop/src/services/gateways/memory.ts`
- Create: `apps/desktop/src/services/gateways/memory.test.ts`
- Modify: `apps/desktop/src/services/gateways/index.ts`（挂 memory 选择）

**Interfaces:**
- Consumes: 接口（Task 1）。
- Produces (EXACT): `memoryFsGateway`/`memoryAiGateway`/`memoryKeyGateway`——
  - `memoryFsGateway`：内存 `Map<string, string>`（相对路径 → 内容），可选种子（`createMemoryFsGateway(seed?: Record<string,string>)`）；`read(vault, path)` 取 map；`write` set；`list(vault, dir)` 从 map 的 key 推导虚拟目录树（返回 `FileEntry[]`，is_dir 由「是否有子 key 前缀」判定，is_mdx 按扩展名）；`watch`/`onFsChange` no-op（onFsChange 返回空 unlisten）；`openFolderDialog` 返回 `'memoir://demo'`；`saveFileDialog` 返回 `null`。
  - `memoryAiGateway`/`memoryKeyGateway`：no-op/内存 map。
  - `getGateways()` 的 memory 分支返回这些。

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/services/gateways/memory.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createMemoryFsGateway } from './memory'

describe('memoryFsGateway', () => {
  it('reads and writes to an in-memory map', async () => {
    const fs = createMemoryFsGateway({ 'welcome.md': '# hi' })
    expect(await fs.read('memoir://demo', 'welcome.md')).toBe('# hi')
    await fs.write('memoir://demo', 'new.md', 'x')
    expect(await fs.read('memoir://demo', 'new.md')).toBe('x')
  })

  it('lists a virtual directory tree', async () => {
    const fs = createMemoryFsGateway({
      'welcome.md': '# hi',
      'docs/a.md': 'a',
      'docs/sub/b.md': 'b',
    })
    const root = await fs.list('memoir://demo', '.')
    const names = root.map((e) => e.name)
    expect(names).toContain('welcome.md')
    expect(names).toContain('docs')
    const docs = await fs.list('memoir://demo', 'docs')
    expect(docs.map((e) => e.name)).toEqual(['a.md', 'sub'])
  })

  it('openFolderDialog returns the demo root', async () => {
    const fs = createMemoryFsGateway()
    expect(await fs.openFolderDialog()).toBe('memoir://demo')
  })
})
```

- [ ] **Step 2: 跑测试确认失败 → 实现**
- `memory.ts` 按上述实现（list 目录推导：扫描所有 key，找 dir 前缀的直接子项）。
- `index.ts` memory 分支接线。

- [ ] **Step 3: 跑测试 + Commit**
Run: `pnpm --filter @nekowite/desktop test` 全绿 → `pnpm -r test` 不回归。
```bash
git add apps/desktop/src/services/gateways
git commit -m "feat(desktop): add browser memory gateway for demo mode"
```

---

### Task 3: 收敛 ai/key invoke 到 gateway + 纯浏览器演示验证

**Files:**
- Modify: `apps/desktop/src/services/ai.ts`（invoke → `getGateways().ai`）
- Modify: `apps/desktop/src/stores/settings.ts`（key invoke → `getGateways().keys`）
- Modify: `apps/desktop/src/services/fs.ts` 已由 Task 1 完成（复查）
- Modify: `apps/desktop/README` 或注释（可选：`pnpm dev` 浏览器演示说明）

**Interfaces:**
- Consumes: `AppGateways`（Task 1）。
- Produces: 组件/store 零直接 `invoke`（grep `invoke\(` 仅剩 gateways/tauri.ts 一处）。

- [ ] **Step 1: 写失败测试 / grep 前置**
`ai.test.ts`、`settings` 相关测试若 mock 了 invoke 的模块，需确认经 gateway 后仍 mock 生效（gateway 内部仍调 invoke，mock `@tauri-apps/api/core` 应继续拦截）。跑既有测试确认不破；若有破，调整 mock 指向 gateway 层。

- [ ] **Step 2: 实现收敛**
- `ai.ts`：把 `invoke('ai_complete'...)` 等换成 `getGateways().ai.complete(config, prompt)` / `.cancel(id)`（内部 tauri 实现保留原 invoke 签名）。
- `settings.ts`：`invoke('store_ai_key'...)` → `getGateways().keys.storeAiKey(...)`；`loadAiKey` 同理。
- grep 校验：`rg "invoke\(" apps/desktop/src` 只命中 `gateways/tauri.ts`。

- [ ] **Step 3: 浏览器演示验证 + Commit**
- `pnpm dev` 纯浏览器（无 mock）：应能「打开 demo vault」→ 文件树出现（种子或空）→ 新建/编辑/保存到内存。若种子为空，给一个默认 `welcome.md` 种子便于演示。
- Run: `pnpm -r test` 全绿、typecheck/lint、E2E 2/2。
```bash
git add apps/desktop/src/services apps/desktop/src/stores
git commit -m "feat(desktop): route ai and key calls through gateways"
```

---

## Self-Review

**Spec 覆盖：** 接口三件套 ✅（Task 1）、tauri 实现契约不变 ✅（Task 1）、memory 实现 + 目录树 ✅（Task 2）、getGateways 选择器 ✅（Task 1/2）、fs.ts 转发零消费方改动 ✅（Task 1）、ai/key invoke 收敛 + grep 仅 tauri 一处 ✅（Task 3）、浏览器演示 ✅（Task 3）。
**占位符：** 无 TBD；两处明确判定（`__source` vs 行为断言、fs.test mock 兼容性检查）。
**类型一致：** `getGateways(): AppGateways`、`AppGateways.fs/ai/keys` 各接口方法签名（read/write/list/watch/openFolderDialog/saveFileDialog/onFsChange; complete/cancel; storeAiKey/loadAiKey）Task 2/3 消费一致。