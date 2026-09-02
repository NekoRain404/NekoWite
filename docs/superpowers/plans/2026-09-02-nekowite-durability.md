# NekoWite A+F 项：数据耐久与自动保存 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 原子写入 + 历史版本快照（可配 maxHistory、可恢复）+ 删除进回收站 + 可配间隔的自动保存 + 历史版本面板 + 崩溃恢复提示。对标 Memoir 数据耐久。

**Architecture:** Rust 层改造 `write_file` 为原子写（tmp+fsync+rename）并前置历史快照（`.nekowite/history/`，maxHistory 修剪），新增回收站命令（`delete_file`/`list_trash`/`restore_from_trash`）与历史命令（`list_history`/`read_history`/`restore_history`）。前端 `FsGateway` 扩展 6 方法（tauri + memory 双实现）；tabs store 加 `scheduleAutosave`（防抖定时）+ 删除联动 + `restoreHistory`；RenderedPane 接防抖；FileTree 删除入口；新 `HistoryPanel.vue` 列出/恢复/刷新。设置并入 `useSettingsStore`（autosaveInterval / maxHistory）。

**Tech Stack:** Rust（std fs）、TypeScript/Vue/Pinia、vitest、gateway（B 轮）。

## Global Constraints

- 只动 `apps/desktop/src-tauri`（fs.rs/lib.rs/Cargo 不新增 crate）+ `apps/desktop/src`（gateways/stores/ui/services）。
- **不引入新依赖**（Rust 与前端均无）。
- 复用 B 轮 gateway：`FsGateway` 增 6 方法，tauri + memory 双实现；消费方不直接 invoke。
- `resolve_within` 沙箱（C 轮）必须在写/删/恢复前校验路径。
- 英文 commit message；`pnpm -r test` 全绿（228 保持）+ typecheck/lint；cargo test/build/clippy 无新警告；E2E 2/2。
- pnpm 命令需 `PNPM_STORE_DIR=/tmp/pnpm-store-test/v11`。
- 手动保存语义不变（仍 onSave/onSaved 生命周期）；自动保存复用 `saveActive`。

---

### Task 1: Rust 原子写 + 历史快照 + 回收站命令

**Files:**
- Modify: `apps/desktop/src-tauri/src/fs.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/tests/fs_test.rs`

**Interfaces:**
- Consumes: `resolve_within`（C 轮）、`should_skip_entry`、现有命令注册。
- Produces (EXACT — Task 2 依赖):
  - `pub fn atomic_write(resolved: &Path, content: &str) -> Result<(), String>`（tmp+fsync+rename，失败清 tmp）。
  - `pub fn snapshot_history(vault_root: &str, path: &str, old_content: &str, max: usize) -> Result<(), String>`（写 `.nekowite/history/<encoded>/<ms>.<ext>`，修剪超 max 的最旧）。
  - `pub fn encode_rel_path(p: &str) -> String`（`/`→`__` 等，防穿越；纯函数可测）。
  - `write_file` 改造：resolve → 读旧内容（若有）→ 若旧≠新且旧非空 → snapshot_history → atomic_write。**若 resolve 后文件不存在（新建），旧内容为空则跳过快照**。
  - `#[tauri::command] delete_file(vault_root, path) -> Result<String, String>`（resolve → rename 到 `.nekowite-trash/<encode(path)>`，冲突加时间戳）。
  - `#[tauri::command] list_trash(vault_root) -> Result<Vec<TrashEntry>, String>`（TrashEntry `{ name, trash_path, original_path }`，解析 `.nekowite-trash/` 下条目）。
  - `#[tauri::command] restore_from_trash(vault_root, trash_path) -> Result<String, String>`（rename 回原路径，占用加 `-restored-<ts>` 后缀返回新路径）。
  - `#[tauri::command] list_history(vault_root, path) -> Result<Vec<HistoryEntry>, String>`（`{ id: String, size: u64, mtime: u64 }` 倒序）。
  - `#[tauri::command] read_history(vault_root, path, id) -> Result<String, String>`。
  - `#[tauri::command] restore_history(vault_root, path, id) -> Result<String, String>`（读快照 → atomic_write 主文件 → 返回内容）。
  - 常量/命令注册进 `generate_handler!`；`.nekowite-trash/` 由 `should_skip_entry` 隐藏（确认 `.` 开头已隐）。

- [ ] **Step 1: 写失败测试（Rust）**

`tests/fs_test.rs` 增：

```rust
use nekowite_lib::fs::{atomic_write, snapshot_history, encode_rel_path, write_file, delete_file, list_trash, restore_from_trash, list_history, read_history, restore_history, resolve_within};

#[test]
fn atomic_write_replaces_and_fails_safely() {
    // temp dir: write target -> atomic_write -> content updated
    // simulate: target dir missing? atomic_write create_dir_all
    // failure: make tmp path collision or unwritable? 至少验证 rename 成功 + 内容正确
}

#[test]
fn encode_rel_path_is_safe() {
    assert_eq!(encode_rel_path("docs/a.md"), "docs__a.md");
    assert!(!encode_rel_path("../etc").contains('/'));
    assert!(!encode_rel_path("../etc").contains(".."));
}

#[test]
fn history_snapshot_and_max_prune() {
    // write_file with maxHistory=2: save 3 times -> list_history len==2, newest retained
}

#[test]
fn trash_delete_and_restore_roundtrip() {
    // write_file a.md -> delete_file -> list_trash contains it -> restore_from_trash -> read_file ok
}
```

> 按实际签名与错误处理调整；`write_file` 签名需带 maxHistory 参数（或从某处读默认）——**决定：`write_file(vault_root, path, content, max_history: u32)`**，前端传 settings.maxHistory；`snapshot_history` 内部修剪。

- [ ] **Step 2: 跑测试确认失败**
Run: `cargo test` → FAIL（函数/命令不存在）。

- [ ] **Step 3: 实现**
- `fs.rs`：atomic_write/snapshot_history/encode_rel_path + write_file 改造 + 6 命令（delete/list_trash/restore_from_trash/list_history/read_history/restore_history）。
- `lib.rs`：注册命令。
- 确保 `.nekowite/` 与 `.nekowite-trash/` 目录创建用 `create_dir_all`，且 `should_skip_entry` 隐藏（`.nekowite` 已隐；`.nekowite-trash` 以 `.` 开头也已隐——确认 list_trash 不走 list_dir 过滤、直接读目录）。

- [ ] **Step 4: 跑测试 + 回归 + Commit**
Run: `cargo test` 全绿 → build → clippy → `pnpm -r test`（228 不回归，因命令签名变了？——**write_file 增参会破坏前端 invoke？**前端 `fsService.write` 传 `{vault_root,path,content}`；若 Rust 期望多一个 `max_history` 参数，缺省会导致命令失败。**处理：`write_file` 保持 3 参（max_history 从配置/默认 10），或前端同步传 4 参。**本任务先定：**前端 Task 2 同步更新 fsService.write 传 max_history**；Rust 侧 `max_history: Option<u32>` 兼容缺省。在 report 说明选哪个。
```bash
git add apps/desktop/src-tauri
git commit -m "feat(tauri): atomic writes, history snapshots, and trash commands"
```

---

### Task 2: Gateway 扩展 + 前端 settings 配置

**Files:**
- Modify: `apps/desktop/src/services/gateways/contracts.ts`（接口 + 新类型）
- Modify: `apps/desktop/src/services/gateways/tauri.ts`（6 方法 + write 传 max_history）
- Modify: `apps/desktop/src/services/gateways/memory.ts`（6 方法最小实现）
- Modify: `apps/desktop/src/stores/settings.ts`（autosaveInterval/maxHistory 持久化）
- Modify: `apps/desktop/src/ui/SettingsPanel.vue`（保存组配置）

**Interfaces:**
- Consumes: Task 1 的 Rust 命令。
- Produces (EXACT — Task 3/4 依赖):
  - `contracts.ts`: `TrashEntry { name, trash_path, original_path }`、`HistoryEntry { id, size, mtime }`；`FsGateway` 增 `deleteFile(vault,path): Promise<string>`、`listTrash(vault): Promise<TrashEntry[]>`、`restoreFromTrash(vault,trashPath): Promise<string>`、`listHistory(vault,path): Promise<HistoryEntry[]>`、`readHistory(vault,path,id): Promise<string>`、`restoreHistory(vault,path,id): Promise<string>`；`write` 增可选 `maxHistory?: number`。
  - `tauri.ts`：对应 invoke（`delete_file` 等 snake_case）；`write` 传 `{ vault_root, path, content, max_history }`。
  - `memory.ts`：6 方法最小内存实现（delete→标记数组、listTrash→返回、restore→换名、history→内存快照列表、read/restore→快照内容）。
  - `settings.ts`：`autosaveInterval: 'off'|5000|15000|30000|60000`（默认 15000）、`maxHistory: number`（默认 10），持久化 `nekowite.settings` 或现 settings key；暴露 setter。
  - `SettingsPanel.vue`：加「保存」组——自动保存间隔 select、最大历史版本 number input。

- [ ] **Step 1: 写失败测试**
`memory.test.ts` 增：memory gateway 的 delete/listTrash/restore 与 history 方法行为（最小）；`settings` store 测试增 autosaveInterval/maxHistory 默认与持久化。

- [ ] **Step 2: 跑测试确认失败 → 实现**
按上述实现；确保消费方（fsService）现有 6 方法不变，仅增方法。

- [ ] **Step 3: 跑测试 + Commit**
Run: `pnpm --filter @nekowite/desktop test` 全绿 → `pnpm -r test` → typecheck/lint → E2E。
```bash
git add apps/desktop/src/services apps/desktop/src/stores apps/desktop/src/ui
git commit -m "feat(desktop): extend gateway with history/trash and add save settings"
```

---

### Task 3: 自动保存（防抖）+ 删除联动 + 崩溃恢复提示

**Files:**
- Modify: `apps/desktop/src/stores/tabs.ts`（scheduleAutosave/删除联动/restoreHistory 更新）
- Modify: `apps/desktop/src/view/RenderedPane.vue`（onContentChange 接防抖）
- Modify: `apps/desktop/src/ui/FileTree.vue`（删除入口）
- Modify: `apps/desktop/src/components/AppToast.vue` 或新提示（崩溃恢复提示——用 Toast 或对话框）

**Interfaces:**
- Consumes: Task 2 的 gateway/settings。
- Produces:
  - `tabs.scheduleAutosave(id): void`（per-tab 防抖定时：内容变化重置，间隔到调 saveActive；`autosaveInterval==='off'` 跳过）
  - `tabs.cancelAutosave(id): void`（手动保存/关 tab 清定时器）
  - `tabs.deleteTabFile(id): Promise<void>`（deleteFile → 关 tab）
  - `tabs.restoreHistoryToActive(id, versionId): Promise<string | null>`（restoreHistory → 更新 content/savedContent/dirty=false）
  - `tabs.checkCrashRecovery(id): Promise<HistoryEntry | null>`（openTab 后：listHistory 最新 vs 主文件——若历史 mtime > 主文件，返回条目）
  - RenderedPane：`onContentChange` 里调用 `scheduleAutosave(active.id)`。
  - FileTree：行悬停/右键「删除」按钮 → `deleteTabFile`；确认弹窗（复用 ConflictDialog 或 window.confirm——**用简单 confirm 对话框**，非阻塞）。
  - 崩溃恢复提示：openTab 成功后 `checkCrashRecovery`，有则 AppToast 提示「检测到未保存的更改，恢复最近版本？」带「恢复」按钮。

- [ ] **Step 1: 写失败测试**
`tabs.test.ts` 增：scheduleAutosave 用 fake timers（间隔内多次调用只存一次；间隔到调用 saveActive）；deleteTabFile 关 tab；restoreHistoryToActive 更新内容；checkCrashRecovery 判定（历史比主文件新 → 返回）。

- [ ] **Step 2: 跑测试确认失败 → 实现**
按上述实现（fake timers 用 `vi.useFakeTimers()`）。

- [ ] **Step 3: 跑测试 + Commit**
Run: `pnpm --filter @nekowite/desktop test` 全绿 → `pnpm -r test` → typecheck/lint → E2E。
```bash
git add apps/desktop/src
git commit -m "feat(desktop): autosave debounce, delete-to-trash, and crash recovery prompt"
```

---

### Task 4: 历史版本面板 HistoryPanel

**Files:**
- Create: `apps/desktop/src/ui/HistoryPanel.vue`
- Modify: `apps/desktop/src/App.vue`（挂 HistoryPanel，与 ReferencesPanel 并列）
- Modify: `apps/desktop/src/ui/HistoryPanel.test.ts`（或并入引用测试）

**Interfaces:**
- Consumes: gateway listHistory/restoreHistory、tabs store（active tab）。
- Produces: `HistoryPanel.vue`——列当前活动文档历史（时间/大小/id），「恢复」按钮调 `tabs.restoreHistoryToActive`，刷新按钮；空态；监听 active tab/content 变化自动刷新。

- [ ] **Step 1: 写失败测试**
HistoryPanel 行为可测部分：给定 mock gateway 返回历史列表 → 渲染条目；点恢复 → 调 restoreHistoryToActive。happy-dom 组件测试或提取纯逻辑。

- [ ] **Step 2: 跑测试确认失败 → 实现**
`HistoryPanel.vue` 实现 + `App.vue` 挂载（底部与 ReferencesPanel 并列，可折叠或并排）。

- [ ] **Step 3: 跑测试 + Commit**
Run: 全量 → typecheck/lint → E2E。
```bash
git add apps/desktop/src/ui apps/desktop/src/App.vue
git commit -m "feat(desktop): add history version panel with restore"
```

---

### Task 5: 全量回归 + 冒烟（收尾）

**Files:**
- Run: `pnpm -r test`（228 + 新增）、`pnpm -r typecheck`、`pnpm -r lint`、`pnpm --filter @nekowite/desktop build`、`cargo test`/`build`/`clippy`、`pnpm test:e2e`。
- 冒烟（若可 launch）：编辑 → 15s 自动保存 → 历史面板出现版本 → 恢复旧版 → 删除文件进回收站 → 重启检查崩溃恢复提示。若不可 launch，记录精确清单。
- Commit（若有修复）。

---

## Self-Review

**Spec 覆盖：** 原子写 ✅（Task 1）、历史快照 + maxHistory ✅（Task 1）、回收站 3 命令 ✅（Task 1）、自动保存防抖 + 配置 ✅（Task 2/3）、崩溃恢复提示 ✅（Task 3）、历史面板 ✅（Task 4）、Gateway 6 方法 + memory ✅（Task 2）、红线（无 trash 恢复 UI/无 diff/无独立 draft/无全局历史）未实现 ✅。
**占位符：** 无 TBD；两处明确判定（write_file 增 max_history 参数兼容方式；崩溃恢复用 AppToast 带按钮）。
**类型一致：** `FsGateway` 6 方法签名（Task 2）→ Task 3/4 消费；`tabs.scheduleAutosave/deleteTabFile/restoreHistoryToActive/checkCrashRecovery`（Task 3）→ RenderedPane/FileTree/AppToast/HistoryPanel 消费；`HistoryEntry/TrashEntry`（Task 2）→ Rust 与前端一致。