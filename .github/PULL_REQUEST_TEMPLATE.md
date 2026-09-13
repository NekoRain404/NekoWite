<!-- 请用中文或英文填写；与本次改动无关的条目可以删除。 -->

## 改了什么，为什么

<!-- 描述改动本身，以及背后的原因。看起来绕的取舍请写清楚否掉了哪条更直接的路线。 -->

## 自查清单

- [ ] `pnpm -r typecheck`
- [ ] `pnpm -r lint`
- [ ] `pnpm -r test`
- [ ] Rust 命令层（在 `apps/desktop/src-tauri/`）：`cargo test --locked` / `cargo clippy --all-targets -- -D warnings` / `cargo fmt --all --check`
- [ ] `pnpm -r build`
- [ ] `pnpm test:e2e`

## 用户可见的改动

<!-- 用户可见的改动需要重新打包便携版：bash scripts/package-win.sh -->
- [ ] 这是用户可见的改动，已重建便携版 exe（附路径与 SHA-256）；或本次不涉及用户可见行为

## 覆盖这次改动的测试

<!-- 仓库要求行为改动带测试：列出新增或更新的测试文件与用例。没有测试时说明原因。 -->

## 备注

<!-- 已知限制、兼容性影响、需要 reviewer 特别关注的地方。 -->
