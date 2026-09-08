# NekoWite C 项：路径沙箱加固 Design

- 日期：2026-09-02
- 状态：已确认
- 前置：UI 优化已合并。现有 Rust 层有 `resolve_within`（绝对/相对、`..` 拒绝、canonicalize 验证 containment）与 `is_mdx_path`（node_modules 排除）；前端 `fsService` 直连 Tauri invoke。

## 1. 目标

加固 Rust 文件系统沙箱：在现有 vault 边界（`resolve_within`）基础上，补齐 Memoir 式防护——**拒绝符号链接逃逸、过滤隐藏目录与构建产物目录**，确保通过 `list_dir` / `read_file` / `write_file` 只能触达用户显式纳入 vault 的真实文件。

## 2. 现状（读文件定稿）

`apps/desktop/src-tauri/src/fs.rs`：
- `canonicalize_loose(path)`：即使目标不存在也能 canonicalize（canonicalize 最近祖先 + 重新拼接尾部），用于写前校验。**但 canonicalize 会解析符号链接** —— 若 vault 内有一个指向 vault 外（如 `/etc`）的 symlink，`canonicalize_loose` 会解析它然后 `starts_with(canonical_base)` 拒绝 → 看起来已防护。**需验证**：读路径（目标存在）与写路径（目标不存在，父目录含 symlink）在 `resolve_within` 下是否都拒绝 symlink 逃逸；若有漏（例如 canonicalize 之后 `starts_with` 前缀误判、或目录项遍历 `list_dir` 时把 symlink 当目录递归进 vault 外），需修复。
- `is_mdx_path` 只查 `node_modules`，不隐藏 `.git` / `.nekowite` / 点文件点目录 / `dist`/`build`/`target` 等构建产物。

## 3. 设计

### 3.1 符号链接逃逸防护（`resolve_within` 加固）

- `resolve_within(base, requested)`：在 canonicalize 前后都校验；对 `canonicalize_loose` 的路径逐段检查：**每一个中间目录都必须是 vault 内的真目录**（canonicalize 后 `starts_with(canonical_base)`），且**不跟随产业链中的 symlink 出界**。实现时用 canonicalize 的天然行为（解析 symlink）+ 最终 `starts_with` 校验即可，但需补一个明确的 `is_symlink` 前检：若 `requested` 本身或任一父段是 `symlink_metadata` 判定的 symlink，且 canonical 后跳出 base，拒绝。
- 新增 `pub fn reject_symlink_escape(path: &Path, canonical_base: &Path) -> bool`（真则拒绝），在 `resolve_within` 的 canonical 结果上调用，逻辑 = `!path.starts_with(canonical_base)` 或路径中任一祖先是指向出界的 symlink。
- **tests**：`fs_test.rs` 增——vault 内 symlink→`/etc/passwd` 的读取被拒；symlink 目录的 `list_dir` 不递归出界；写路径父段含 symlink 被拒。

### 3.2 隐藏/构建目录过滤（`list_dir`）

- `list_dir(vault, path)` 返回条目时过滤：
  - `.` 开头的隐藏文件/目录（`.git`、`.nekowite`、`.DS_Store`、`.*`）
  - 构建产物：`node_modules`（已有）、`dist`、`build`、`target`、`out`（作为**目录名**匹配，非前缀，避免误伤 `build.md`）
  - 符号链接本身（`symlink_metadata().file_type().is_symlink()`）——不显示、不可打开，避免循环与逃逸
- 新增 `pub fn should_skip_entry(entry: &std::fs::DirEntry) -> bool`（name 隐藏/构建外 + symlink），`list_dir` 用它过滤。
- **tests**：`.git`/`.nekowite`/`target`/`node_modules`/symlink 不出现在 `list_dir` 结果；`dist` 目录被过滤但 `dist.md` 文件保留。

### 3.3 保持兼容

- 现有 vault 相对/绝对两种路径语义不变（Task 6 的 `resolve_within` 契约）。
- `open_folder_dialog` 返回的绝对 vault 根仍直接可用。
- 前端调用方不变（仍走同一批 command 名）；仅 Rust 侧加固。

## 4. 实现范围

1. `fs.rs`：`reject_symlink_escape`（或内联）+ `resolve_within` 补 symlink 前检；`should_skip_entry` + `list_dir` 过滤；导出两个新纯函数（可测）。
2. `tests/fs_test.rs`：新增上述测试（真实 temp dir + symlink 场景，`std::os::unix` symlink；Windows 不跑该组或 cfg(unix) 注记）。
3. lib.rs 命令不变（list_dir 内部过滤，外部契约不变）。

## 5. 范围红线

- 不改命令签名、不回写文件逻辑、不做 gateway/前端改动（B 项负责）。
- 不引入新 Rust crate（`std::os::unix` 够用）。
- 深层递归 `list_dir` 目前就是单层（`read_dir` 非递归）——保持。

## 6. 测试策略

- `cargo test`：新增 6-8 个用例（symlink 读拒、symlink 目录列出拒、隐藏目录过滤、构建目录过滤、`dist.md` 保留、相对/绝对路径仍通、node_modules 仍隐）。
- 全部既有 220 JS 测试 + Rust 全绿不回归。
- 手动冒烟（可选）：建一个含 symlink/.git/target 的 vault，`list_dir` 检查。

## 7. 依赖

- 无新 crate。