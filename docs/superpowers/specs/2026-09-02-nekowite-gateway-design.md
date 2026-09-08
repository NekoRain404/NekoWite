# NekoWite B 项：Gateway 分层（浏览器/Tauri 双实现）Design

- 日期：2026-09-02
- 状态：已确认
- 前置：UI 优化已合并。现状前端 `services/fs.ts` 等直接 `invoke` Tauri；`fsService` 被 tabs/export/refs/plugins/FileTree/SettingsPanel 使用；ai.ts 与 settings.ts 也直接 `invoke`。

## 1. 目标

引入 Memoir 式 **gateway 分层**：把所有 Tauri 调用收敛到接口化 gateway，并提供**浏览器内存实现**，使 UI 可脱离真实文件系统在浏览器中演示（`pnpm dev` 纯前端模式），同时保持桌面 Tauri 模式行为不变。组件/store 不再直接 `invoke`。

## 2. 现状（读文件定稿）

- `services/fs.ts`：`fsService` 直连 `invoke`（read/write/list/watch/openFolderDialog/saveFileDialog/onFsChange）。
- 直接 `invoke` 的其他文件：`services/ai.ts`（ai_complete/ai_cancel）、`stores/settings.ts`（stronghold key 命令）。
- `fsService` 消费方：tabs store、refs store、export service、plugins service、FileTree.vue、SettingsPanel.vue（及其测试 mock 了 `../services/fs`）。
- 编辑器/数学/引用/导出/AI/浮动/生命周期均不依赖 fsService 的「组件内 invoke」——编辑器 core 无 Tauri 依赖。
- **浏览器内存演示现状**：无。`pnpm dev` 启动后打开 vault 会因 `invoke` 不存在而失败（除了 E2E 的注入 mock）。

## 3. 设计

### 3.1 Gateway 接口（`services/gateways.ts`）

```ts
export interface FileEntry { name: string; path: string; is_dir: boolean; is_mdx: boolean }
export interface FsChangeEvent { path: string; kind: string }

export interface FsGateway {
  read(vault: string, path: string): Promise<string>
  write(vault: string, path: string, content: string): Promise<void>
  list(vault: string, dir: string): Promise<FileEntry[]>
  watch(vault: string): Promise<void>
  openFolderDialog(): Promise<string | null>
  saveFileDialog(defaultName: string, startDir?: string): Promise<string | null>
  onFsChange(cb: (e: FsChangeEvent) => void): Promise<() => void>
}

export interface AiGateway {
  complete(config: unknown, prompt: string): Promise<void>   // 触发，结果经事件
  cancel(id: string): Promise<void>
}

export interface KeyGateway {
  storeAiKey(provider: string, key: string): Promise<void>
  loadAiKey(provider: string): Promise<string | null>
}

export interface AppGateways {
  fs: FsGateway
  ai: AiGateway
  keys: KeyGateway
}
```

### 3.2 两套实现

- `services/gateways/tauri.ts`：现有 `invoke`/`listen` 逻辑迁移至此（`tauriFsGateway`、`tauriAiGateway`、`tauriKeyGateway`），行为与现在完全一致（命令名/参数 snake_case 契约不变）。
- `services/gateways/memory.ts`：浏览器内存实现——
  - `memoryFsGateway`：内存 `Map<path, string>` + 种子文件（可选 `MEMOIR_DEMO_FILES` 或空 vault）；`read/write` 操作内存 map；`list` 从 map 的 key 推导目录树（虚拟目录，非真实 fs）；`watch/onFsChange` no-op（返回空 unlisten）；`openFolderDialog` 返回 `null` 或固定虚拟根 `'memoir://demo'`；`saveFileDialog` 返回 `null`（或一个虚拟名，前端后续处理）。
  - `memoryAiGateway`/`memoryKeyGateway`：no-op / 内存 map。
- **选择器**：`services/gateways/index.ts` 导出 `getGateways()`——运行时判断 `window.__TAURI_INTERNALS__` 是否存在（与 E2E mock 一致）→ tauri : memory。存模块级单例。

### 3.3 收敛调用

- `services/fs.ts`：改为薄封装 `export const fsService = getGateways().fs`（或删除 fs.ts，调用方改用 `getGateways().fs`——**推荐保留 fsService 名字但内部转发**，最小改动，消费方不动）。
- `services/ai.ts`、`stores/settings.ts`：AI/key 的 invoke 改走 gateway。
- 消费方（tabs/refs/export/plugins/FileTree/SettingsPanel）**不改 import**——继续用 `fsService` / 各自的 service，只是底层走了 gateway。
- 组件/store 零直接 `invoke`（grep 校验）。

### 3.4 浏览器演示可用

- `pnpm dev` 纯浏览器：能「打开 vault」（memory 空/种子 vault）→ 文件树可见 → 新建/编辑/保存到内存 → 三态视图/工具栏/设置都可用（除真实 fs/stronghold/网络 AI）。
- E2E 的 Tauri-internals mock 仍工作（tauri gateway 读到 mock）。

## 4. 实现范围

1. `services/gateways.ts`（接口）+ `services/gateways/tauri.ts` + `services/gateways/memory.ts` + `services/gateways/index.ts`（getGateways）。
2. `services/fs.ts` 转发到 gateway；`services/ai.ts`、`stores/settings.ts` 的 invoke 收敛。
3. 消费方保持 import 不变（仅底层变化）。
4. 测试：memory gateway 单测（read/write/list 目录推导）；tauri gateway 保持既有 mock 行为（fs.test.ts 等照旧）；getGateways 选择器测试。

## 5. 范围红线

- **不改** Rust 命令/契约。
- **不做** gateway 之外的架构重构（不动 store 内部逻辑、不动编辑器内核）。
- A+F（原子写/回收站/自动保存）在 gateway 之上做（下一轮），本轮只搭 gateway 骨架 + 收敛。
- 浏览器 memory gateway 只满足演示，不追求真实 fs 等价（如并发/目录元数据）。

## 6. 测试策略

- memory gateway：list 目录推导（嵌套 key）、read/write 往返、空 vault、watch no-op。
- tauri gateway：既有的 fs.test.ts/plugins.test.ts/refs.test.ts/tabs.test.ts 继续绿（它们 mock `../services/fs` —— 需确认 mock 路径是否随转发调整）。
- 选择器：`getGateways()` 在无 Tauri-internals 时返回 memory、有时返回 tauri（stub window）。
- 全 220 JS + E2E 2/2 保持绿。

## 7. 依赖

- 无新依赖。