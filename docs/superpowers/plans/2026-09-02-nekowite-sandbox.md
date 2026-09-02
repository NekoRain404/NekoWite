# NekoWite C 项：路径沙箱加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 加固 Rust 文件系统沙箱——拒绝符号链接逃逸、过滤隐藏目录/构建产物目录，使 `list_dir`/`read_file`/`write_file` 只能触达 vault 内真实文件。

**Architecture:** 在现有 `resolve_within`（canonicalize + starts_with 校验）基础上补 symlink 前检（拒绝跳出 vault 的 symlink 及中间祖先），新增 `should_skip_entry`（隐藏/构建目录/symlink）在 `list_dir` 过滤。纯 Rust 侧，命令签名不变，前端零改动。

**Tech Stack:** Rust (`std::os::unix` symlink), cargo test.

## Global Constraints

- 只动 `apps/desktop/src-tauri/src/fs.rs` 与 `tests/fs_test.rs`（lib.rs 命令签名/注册不变；如需把 helper 设为 pub 供测试，仅在 fs.rs 内）。
- 不引入新 crate；`cfg(unix)` 保护 symlink 测试（Windows 跳过，注明）。
- 英文 commit message；`cargo test` 全绿 + `cargo build` + `cargo clippy` 无新警告；既有 220 JS 不回归（Rust 改动不应影响前端）。
- pnpm 命令需 `PNPM_STORE_DIR=/tmp/pnpm-store-test/v11`。

---

### Task 1: 符号链接逃逸防护 + 隐藏/构建目录过滤

**Files:**
- Modify: `apps/desktop/src-tauri/src/fs.rs`
- Modify: `apps/desktop/src-tauri/tests/fs_test.rs`

**Interfaces:**
- Consumes: 现有 `resolve_within(base, requested)`, `list_dir`, `canonicalize_loose`.
- Produces (EXACT):
  - `pub fn should_skip_entry(name: &str, is_symlink: bool) -> bool` —— name 以 `.` 开头（隐藏）、或 `node_modules`/`dist`/`build`/`target`/`out`（精确目录名）、或 is_symlink → true。
  - `pub fn resolve_within(base, requested)` 强化：在 canonical 结果上，若任一祖先/本身是 symlink 且 canonical 后跳出 vault → 拒绝（现有 starts_with 已兜底，需补「中间祖先 symlink」场景的显式测试确认）。
  - `list_dir` 用 `should_skip_entry` 过滤条目（隐藏 + 构建 + symlink 不进结果）。

- [ ] **Step 1: 写失败测试**

`apps/desktop/src-tauri/tests/fs_test.rs` 增（`#[cfg(unix)]` 部分）：

```rust
use nekowite_lib::fs::{resolve_within, should_skip_entry, is_mdx_path};
use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;

#[test]
fn skips_hidden_and_build_dirs() {
    assert!(should_skip_entry(".git", false));
    assert!(should_skip_entry(".nekowite", false));
    assert!(should_skip_entry("node_modules", false));
    assert!(should_skip_entry("dist", false));
    assert!(should_skip_entry("target", false));
    assert!(should_skip_entry("build", false));
    assert!(should_skip_entry(".DS_Store", false));
    assert!(should_skip_entry("dist.md", false));  // 文件保留
    assert!(!should_skip_entry("hello.md", false));
    assert!(should_skip_entry("link", true));
}

#[cfg(unix)]
#[test]
fn rejects_symlink_escape_in_read_path() {
    let dir = std::env::temp_dir().join(format!("nkw_sandbox_{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("note.md"), "x").unwrap();
    symlink("/etc", dir.join("escape")).unwrap();       // symlink 指向 vault 外
    symlink(dir.join("note.md"), dir.join("alias.md")).unwrap(); // vault 内 symlink
    // 读取逃逸 symlink 下的文件 → 拒绝
    assert!(resolve_within(dir.to_str().unwrap(), "escape/passwd").is_err());
    // 读取 vault 内 symlink 指向的文件 → 允许
    assert!(resolve_within(dir.to_str().unwrap(), "alias.md").is_ok());
    // 列出目录时不出现 escape（symlink）与隐藏/构建
    let entries = nekowite_lib::fs::list_dir_entries(dir.to_str().unwrap()).unwrap();
    let names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
    assert!(!names.contains(&"escape".into()));
    assert!(!names.contains(&".git".into()));
    assert!(names.contains(&"note.md".into()));
    fs::remove_dir_all(&dir).unwrap();
}
```

> 注：若 `list_dir` 是 command（带 tauri AppHandle/State），测试需要可调用的纯 `list_dir_entries(path) -> Result<Vec<FileEntry>>`；要么把 `list_dir` 内部拆出纯函数供测试，要么测试直接走真实 temp dir + 命令层。**推荐拆 `list_dir` 的纯逻辑为 `pub fn list_dir_entries(dir: &Path) -> Result<Vec<FileEntry>, String>`**（fs.rs 内），`list_dir` command 调它。按此调整测试签名。

- [ ] **Step 2: 跑测试确认失败**
Run: `cargo test`（在 `apps/desktop/src-tauri`）
Expected: FAIL（`should_skip_entry`/`list_dir_entries` 不存在 / symlink 逃逸仍通过）。

- [ ] **Step 3: 实现**
- `fs.rs` 加 `should_skip_entry(name, is_symlink)`；拆 `list_dir_entries(dir)` 纯函数（含过滤）；`list_dir` command 调它；`resolve_within` 确认 symlink 场景（现有 starts_with 应已拒绝 escape/passwd——`canonicalize` 会把 symlink 解析到 /etc，`starts_with(base)` false → 拒绝；补测试证明；若中间祖先 symlink 场景有漏（如 vault 内目录本身是 symlink 指向 vault 内另一处，canonical 后仍在 base 内 → 允许，合理），记录行为）。
- `lib.rs` 若需 `pub use` 或模块可见性调整，最小处理。

- [ ] **Step 4: 跑测试 + 回归**
Run: `cargo test`（全绿）→ `cargo build` → `cargo clippy --all-targets` 无新警告 → `pnpm -r test`（220 不回归）→ `pnpm -r typecheck`/`lint`（前端未动，快速确认）。

- [ ] **Step 5: Commit**
```bash
git add apps/desktop/src-tauri/src/fs.rs apps/desktop/src-tauri/tests/fs_test.rs
git commit -m "fix(tauri): harden sandbox against symlink escape and hidden/build dirs"
```

---

## Self-Review

**Spec 覆盖：** symlink 逃逸拒绝 ✅（resolve_within 测试 + starts_with 兜底）、隐藏/构建目录过滤 ✅（should_skip_entry + list_dir_entries）、node_modules 保留既有行为 ✅、命令签名不变 ✅、无新 crate ✅、Windows cfg(unix) ✅。
**占位符：** 无 TBD；`list_dir_entries` 拆分是为可测性明确要求。
**类型一致：** `should_skip_entry(name: &str, is_symlink: bool) -> bool`、`list_dir_entries(dir: &Path) -> Result<Vec<FileEntry>, String>` 两纯函数供测试与 command 共用。