# NekoWite v1.0.0 Release Optimization Report

日期：2026-09-02
分支：`opt/release`（worktree: `.worktrees/opt-release`）

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `README.md` | 「路线图」→「功能总览」，列出 v1.0–v1.6 全部已实现功能（✅）；移除「（当前）」措辞；补充项目状态句（功能完整、单测 196 个、适合自用/学习）；其余技术栈/快速开始/测试/插件开发节保留，仅微调措辞 |
| `CHANGELOG.md` | 新建，Keep a Changelog 风格，首个完整发布 `[1.0.0] - 2026-08-29` |
| `package.json`（根） | `version` `0.1.0` → `1.0.0` |
| `apps/desktop/package.json` | `version` `0.1.0` → `1.0.0` |
| `packages/editor-core/package.json` | `version` `0.1.0` → `1.0.0` |
| `packages/plugin-host/package.json` | `version` `0.1.0` → `1.0.0` |

未改任何源代码行为。

## CHANGELOG 内容概览

- 标题：`## [1.0.0] - 2026-08-29`，注明「NekoWite 的首个完整发布，涵盖 v1.0–v1.6 全部计划功能」。
- `### Added` 分列 v1.0 核心体验 / v1.1 数学 / v1.2 引用 / v1.3 导出 / v1.4 AI / v1.5 浮动元素 / v1.6 深度插件。
- 文件头部声明遵循 Keep a Changelog 与 SemVer（中文）。

## lockfile 处理

- workspace 包在 `pnpm-lock.yaml` 中以 `link:` 形式记录（不含版本号字段），version bump 不影响依赖解析。
- 实测 `pnpm install --frozen-lockfile`：`Lockfile is up to date, resolution step is skipped`，**lockfile 无需更新**，未改动 `pnpm-lock.yaml`。

## 验证

- `pnpm -r test`：editor-core 80 + plugin-host 20 + desktop 96 = **196 tests 全过**，无回归。
- 全仓库基线测试在文档改动前/后各跑一次，结果一致。
- 文档改动后通读确认无错别字/占位符。

## Commit

（见 git log）

## Concerns

- 无功能性担忧。注意 README 中「单测 196 个」的数字来自 `pnpm -r test` 的 vitest 汇总（不包含 Rust cargo 测试与 Playwright E2E 计数）。
- Cargo.toml / tauri.conf.json 等 Rust 侧版本仍为 0.1.0，未在本次收束范围内（任务只指定四个 package.json）；如后续做桌面安装包版本对齐需另行处理。
- CHANGELOG 中的 v1.3 条目补充了「KaTeX 字体内嵌 data URI」细节、v1.4 补充「加密密钥存储」、v1.6 补充「活动编辑器追踪」，均为 git log 可证实的已实现点，属忠实描述。
