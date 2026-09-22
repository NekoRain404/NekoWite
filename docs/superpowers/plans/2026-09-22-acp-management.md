# ACP Management Implementation Plan

**Goal:** 实现已确认设计中的 ACP 添加、删除、选择与权限编辑。

**Architecture:** Vue 组件通过注入的服务调用 gateway；Rust 注册表和配置服务负责身份、事务与持久化。沿用现有单进程实例生命周期。

**Tech Stack:** Vue 3、TypeScript、Vitest、Tauri 2、Rust。

设计：`../specs/2026-09-22-acp-management-design.md`。用户已于本轮确认继续实施。采用 subagent-driven-development，主代理复核所有修改。

## 任务 1：持久化注册删除

- [x] 先补注册删除及持久化失败回归，确认失败。
- [x] 在 `agent_runtime/registry`、`state/app_state/registry_access.rs` 和 `commands/agent_registry.rs` 增加持久增删事务及 IPC。保留默认项、运行中和启动中保护，保留 profile 归属。
- [x] 前端 `agent-registry-ipc.ts`、`agent-registry-policy.ts`、`platform/gateways/tauri-agent/registry.ts` 接入 `delete(agentId)`；管理组件提供确认和忙碌状态。
- [x] 添加表单默认 generic-acp 适配器，自动建议合法 ID，保留错误输入；拆分超预算组件。

验收：注册项重启后存在，删除重启后仍消失；保存失败恢复内存；旧 profile 不能被另一 Agent 占用。回滚不删除用户程序或历史。

测试：`npx --yes pnpm --filter @nekowite/desktop test src/features/agent-settings`；`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml agent_registry`。

## 任务 2：Agent 新建入口

- [x] 写指定 Agent 启动和面板选择回归，确认旧入口不能传递身份。
- [x] 修改 `commands/agent/lifecycle.rs`、`state/app_state/agent.rs`、`platform/gateways/tauri-agent/ipc.ts`、`app/agent-composition.ts`、`app/agent-rail.ts`，传递可选 Agent 身份，默认行为兼容。
- [x] 新增独立 Plus 菜单，接入 `AgentSessionBar.vue`、`AgentPanel.vue`、`AgentRailBody.vue` 和 shell，复用既有 popup 键盘和焦点策略。
- [x] 验证注册变化刷新、错误重试、禁用项、切换前停止、旧请求和失败启动。

验收：选择的 Agent 真正启动；旧历史不换身份；单实例和待授权约束继续有效。回滚保留默认启动参数。

测试：`npx --yes pnpm --filter @nekowite/desktop test src/app/agent-rail src/platform/gateways/tauri-agent src/features/agent/components`。

## 任务 3：结构化权限编辑

- [x] 先写规则读写、复杂规则保留、冲突和失败回归。
- [x] 新增 `agent-permission-editor.ts` 与 `AgentPermissionEditor.vue`，复用 `AgentConfigClient`，仅修改 `permission` 成员；支持 JSONC 时使用已有结构化解析能力。
- [x] 在 `AgentSettingsSection.vue` 将配置客户端传入权限页；只给受验证受管配置显示可编辑控件。
- [x] 保存成功明确待重启生效；运行中不自动重启；临时授权与持久授权文案分别陈述实际范围。

验收：询问、允许和拒绝写入真实配置，未知字段保留，复杂权限规则不被简单表单覆盖；过期 revision 不写入。回滚不重置用户权限。

测试：`npx --yes pnpm --filter @nekowite/desktop test src/features/agent-settings src/features/settings/components/SettingsPanel.agents`；受影响 Rust IPC 测试。

## 最终复核

- [x] 复核安全 IPC、代码分层、行数、原始用户改动与文档归属。
- [x] `npx --yes pnpm typecheck`
- [x] `npx --yes pnpm lint`
- [x] `npx --yes pnpm test`
- [x] `npx --yes pnpm build`
- [x] Rust 相关测试和桌面/窄面板视觉检查；启动开发服务器供用户查看。

## 验证记录（2026-09-22）

- 最终上述四条命令均退出 0。前端测试：editor-core 965、plugin-host 132、desktop 4902，共 5999 项。
- Rust 七个相关集成目标共 148 项通过，另 `--lib selected_agent` 3 项通过，退出 0。
- `agent-registry.spec.ts` 与 `acp-management.spec.ts` 共 14 项浏览器测试通过；1280px/390px 截图人工检查通过。
- lint 0 errors，415 warnings，低于仓库允许的 462；构建保留既有大 chunk 提示。
- 评审修复启动/停止安装竞态、保存后权限摘要陈旧、重新打开页面丢失生效边界说明。未跟踪进程生效 revision，因此只报告磁盘规则，始终显示启动加载范围。
- `git diff --check` 通过；无依赖或锁文件改动；未验证 AppImage/deb/rpm 发布包。
- 浏览器预览 `http://127.0.0.1:1420/` 已返回 HTTP 200；实际启动本地 ACP 需要 Tauri 桌面环境。
