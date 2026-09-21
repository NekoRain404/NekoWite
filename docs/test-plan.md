# NekoWite Test Plan (execution, separate from docs/debug.md)

> 执行用测试矩阵（与 `docs/debug.md` 的方法论互补：这里按功能域列出**要验证的用例** + 现有测试 + 缺口 + 修复）。AI 相关（AI/Chat/GhostWriter/模型请求）暂不执行。
> 质量门禁：`pnpm -r typecheck` / `pnpm -r lint`（0 errors，warnings 不为 0，且不会让命令失败）/ `pnpm -r test` / `cargo test`（在 `apps/desktop/src-tauri` 下，或加 `--manifest-path`）/ `pnpm build` / `pnpm --filter @nekowite/desktop e2e`（不要直接调 playwright，它会和 app 抢 1420 端口）/ `pnpm perf`。
> 权威清单是 `.github/workflows/ci.yml`：它还包含 `check:export-css`、`cargo clippy` 与 `cargo fmt --all --check`。
> 修复后 ≥10 次循环验证。

## 覆盖清单（用例 → 现有测试 → 状态）
| 域 | 用例 | 现有测试 | 状态 |
|---|---|---|---|
| Vault | A1 打开/恢复/无效切换/截断提示 | vaultSession/fileTree/coordinator tests | |
| 编辑器 | B1 三视图/键入/保存/关闭保存/单撤销 | app.spec, lifecycle.spec, editorPersistence | |
| MDX | C1-C4 round-trip/unknown-JSX/math/边界 | editor-core mdx + roundtrip.test | |
| 图片 | D1-D5 paste/drop→落盘→显示/属性面板/守卫/失败恢复 | useImagePasteDrop, attachments | |
| 表格 | E1-E3 行列/剪贴板/列宽/往返 | table ops/clipboard tests | |
| 搜索索引 | F1-F4 全文/增量/持久化/取消 | searchIndex + vaultIndexCoordinator | |
| 图谱 | G1-G4 全量/解析/自动重建/过滤器 | linkGraph + GraphPanel | |
| 插件 | H1-H4 授权前不执行/超时/审计路径/CSP | plugin-host trust/governance + security-regression | |
| 安全 | I1-I3 vault 绑定/key mask/KDF/路径 | src-tauri tests | |
| 持久化/窗口 | J1-J2 PersistencePort 版本迁移/窗 | persistence + windowState | |
| 导出 | K1-K2 HTML/PDF | exportRenderers | |
| 恢复/无障碍 | L1-L2 .tmp/未命名dirty/live-region/焦点 | recoveryClosedLoop + announcer | |

## 已知重点复查（docs/debug.md §4）
- runtime.dispose 是否真被调用（App unmount = lifecycle.unmount → disposeRuntime）
- 编辑器销毁是否单所有权（destroy 只一次）
- Vault 注册失败是否阻止切换
- 资源泄漏：ProseMirror/DOM/Worker/AbortController/timer/listener
- 图片 asset:// scope（_assets/.tmp）是否可显示
- 安全：插件真隔离（架构级 P0 残留）、key 不出 URL/日志、vault 绑定、路径返回拒绝

## 执行方式
1. 子代理审计：对 `docs/debug.md`（方法） + `docs/test-plan.md`（用例）核对现有测试，标 COVERED/PARTIAL/GAP + 找失败（=bug）。
2. 子代理补缺口 + 修 bug（Q 驱动，先失败测试再修）。
3. 全量循环验证 ≥10 次。
