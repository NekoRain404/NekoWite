# NekoWite A+F 项：数据耐久与自动保存 Design

- 日期：2026-09-02
- 状态：已确认
- 前置：UI 优化 + C（沙箱加固）+ B（gateway 分层）已合并至 master。现状：`write_file` 直接覆盖写（非原子）；前端无删除文件能力；三态保存点已有（UI 轮）；gateway 分层就位（B 轮）。

## 1. 目标

把数据安全与保存体验提升到可日常使用的水平（对标 Memoir 的数据耐久）：

1. **原子写入**：写文件不损坏原文件（tmp + fsync + rename）。
2. **双写 + 历史版本**：每次保存（手动/自动）前置快照旧版本到历史目录，可恢复到之前的版本；最大备份数量可配置。
3. **回收站**：删除文件进 `.nekowite-trash/`（可恢复），不物理删除。
4. **自动保存**：可配置间隔的防抖自动保存（写主文件），崩溃后可提示恢复最近版本。
5. **历史版本面板**：列出当前文档历史版本，可查看/恢复/删除。

## 2. 现状（读文件定稿）

- Rust `apps/desktop/src-tauri/src/fs.rs`：`write_file(vault_root, path, content)` 用 `std::fs::write` 直接覆盖；`resolve_within` 已含沙箱加固（C 轮）。`lib.rs` 注册 read/write/list/watch/dialogs/save_file_dialog。
- 前端 `services/fs.ts` → `gateways/fs.ts`（B 轮）：`fsService` 转发到 `getGateways().fs`；`FsGateway` 接口含 read/write/list/watch/openFolderDialog/saveFileDialog/onFsChange。memory + tauri 双实现。
- `stores/tabs.ts`：`OpenTab { id,path,content,savedContent,dirty }`，`saveActive()`（emitLifecycle onSave→写→onSaved + 三态 markSaving/markSaved + saveStateOf），无删除。
- `ui/TabBar.vue` 已有 `.save-dot` 三态（saved/dirty/saving）。
- 无 `delete`/`history`/`trash` 相关代码。

## 3. 设计

### 3.1 原子写入（Rust）

`write_file` 改造为原子写：
- 目标目录 `create_dir_all`；写 `.<name>.<nonce>.tmp` → `file.write_all` → `file.sync_all` → `fs::rename(tmp, target)`（原子替换）；失败 `remove_file(tmp)`。
- 复用 C 轮 `resolve_within` 沙箱校验（写前 resolve 后写 resolve 结果路径）。
- 测试：写坏/中断不影响旧文件（模拟 tmp 写失败后 target 仍原样）。

### 3.2 历史版本快照（双写）

- 历史目录：`{app_data_dir}/.nekowite/history/`（**注意**：用 app data dir 而非 vault 内？——**决定：放 vault 根下 `.nekowite/history/`**，随 vault 走、可被 gitignore，符合「.nekowite/ 是 app 元数据」约定。与 C 轮 `.nekowite/` 隐藏目录一致）。路径：`.nekowite/history/<encode(path)>/<unix_ms>.<ext>`（encode 把 `/`→`__`，`.`→`_d` 等，保证无目录穿越；或直接用相对路径扁平化）。
- **保存前置快照**：`write_file` 内部，若磁盘当前内容（旧）≠ 写入内容（新）且旧内容非空，则先快照旧内容到历史，再原子写。max-history 修剪（超 `maxHistory` 删除最旧）。
- **命令**：
  - `list_history(vault, path) -> Vec<HistoryEntry>`（`{ id(毫秒), size, mtime }`，按时间倒序）
  - `read_history(vault, path, version_id) -> String`
  - `restore_history(vault, path, version_id) -> String`（读快照 → 原子写主文件 → 返回新内容；前端可同时更新编辑器与 store）
- **配置**：`maxHistory: number`（默认 10，范围 1-100），存 `nekowite.appearance` 或单独 settings——**决定：并入现有 `useSettingsStore`（AI 设置旁加「保存」组）**。

### 3.3 回收站（删除进 trash）

- 回收站目录：`.nekowite-trash/`（vault 根下，隐藏，C 轮 `should_skip_entry` 已隐 `.` 开头目录——确认 trash 也在隐藏之列）。
- **命令**：
  - `delete_file(vault, path)`：resolve 后 `fs::rename(path, .nekowite-trash/<encode(path)>)`（若目标已存在加时间戳后缀）。返回 trash 相对路径。
  - `list_trash(vault) -> Vec<TrashEntry>`（`{ name, trash_path, original_path }`）
  - `restore_from_trash(vault, trash_path)`：rename 回原路径（若原路径被占用，加 `-restored-<ts>` 后缀并返回新路径）。
  - `empty_trash(vault)`：清空（可选，V1 提供）。
- **前端**：FileTree 行悬停/右键「删除」（`delete_file`）；删除后若该 tab 打开则关 tab。Trash 恢复 UI：**V1 不做独立 trash 面板**（历史面板优先），但 Rust 命令完整 + 前端 delete 入口可用；恢复通过手动命令/后续版本。**范围红线注明**。

### 3.4 自动保存（防抖定时）

- **配置**：`autosaveInterval: 'off' | 5000 | 15000 | 30000 | 60000`（默认 15000，即 15s）。
- **机制**：RenderedPane `onContentChange`（已有 → 写回 tab.content）之后，防抖到间隔：`tabs.scheduleAutosave(id)`——设置一个 per-tab 定时器，间隔到则 `saveActive()`。内容再次变化重置计时。
- 手动 Ctrl+S 立即 `saveActive()` 并清自动定时器。
- **崩溃恢复提示**：`openTab` 成功后，查该路径是否有「比主文件更新的历史版本」：`list_history` 取最新版本 mtime 与主文件 mtime 比；若历史更新，AppToast/提示条「检测到未保存的更改，恢复最近版本？」→ 点恢复调 `restore_history` 更新编辑器。

### 3.5 历史版本面板（恢复入口）

- 新 `ui/HistoryPanel.vue`：列出当前活动文档的历史版本（`list_history`），每项显示时间/大小；「恢复」按钮 → `restore_history` → 更新 active tab content + 编辑器；「删除版本」→ 可选（V1 可只读列表+恢复，删除走 maxHistory 自动修剪）。与 ReferencesPanel 并列在底部（可折叠）。
- 无活动文档或无历史：空态。
- 数据流：HistoryPanel 监听 `tabs.activeTab?.content` 变化 + 手动刷新按钮 + 保存后自动刷新。

### 3.6 Gateway 扩展（B 轮之上）

`FsGateway` 增加：
```ts
deleteFile(vault, path): Promise<string>
listTrash(vault): Promise<TrashEntry[]>
restoreFromTrash(vault, trashPath): Promise<string>
listHistory(vault, path): Promise<HistoryEntry[]>
readHistory(vault, path, versionId): Promise<string>
restoreHistory(vault, path, versionId): Promise<string>
```
- tauri 实现：对应新命令（snake_case）。
- memory 实现：内存版（delete→标记、listTrash→列表、restore→换名、history→内存快照列表）。**A+F 这轮 memory 实现做最小可用**（演示不 crash），真实能力以 tauri 为准。
- 消费方（FileTree/HistoryPanel/tabs store）用 gateway，不直接 invoke。

## 4. 实现范围

1. Rust：原子写改造 `write_file`；历史快照 + `list_history/read_history/restore_history` + maxHistory 修剪；回收站 `delete_file/list_trash/restore_from_trash`；`.nekowite-trash/` 目录处理。
2. Gateway：`FsGateway` 增 6 方法；tauri + memory 双实现。
3. 前端：settings store 加 autosaveInterval/maxHistory（持久化）；tabs store 加 `scheduleAutosave`/删除联动/`restoreHistory` 更新内容；RenderedPane 接防抖；FileTree 删除入口；HistoryPanel 组件（列表/恢复/刷新）。
4. 崩溃恢复提示（openTab 后检查）。

## 5. 范围红线（本轮不做）

- 不做独立 Trash 恢复面板 UI（命令完整 + 删除入口可用；恢复经命令/后续版本）。
- 历史版本不做 diff/压缩/去重（纯文本快照）。
- 不做自动保存的 `draft` 独立文件层（直接原子写主文件 + 历史快照兜底，即「双写」= 主文件 + 历史）。
- 不做全局历史浏览器（仅当前文档）。
- 不引入新 crate / 新依赖。
- 不改变手动保存的语义（仍触发 onSave/onSaved 生命周期）。

## 6. 测试策略

- **Rust**：原子写（tmp 失败保留旧文件）；历史快照链（保存 3 次 → 3 个历史 + 主文件最新）+ maxHistory 修剪（设 2 → 只留 2 个）；delete→trash→list→restore（含原路径占用加后缀）；list_history 倒序；`should_skip_entry` 对 `.nekowite-trash/` 隐藏。
- **前端**：autosave 防抖（fake timers：间隔内多次变化只存一次）；saveActive 仍手动可用；delete 关 tab；HistoryPanel 列表/恢复更新 active tab；gateway memory 实现 6 方法不 crash。
- **回归**：全 228+ JS + Rust + E2E 2/2 保持绿。

## 7. 依赖

- 无新 crate / npm 包。