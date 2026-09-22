# ACP 管理与权限交互设计草案

状态：用户确认继续实施；功能已实现，最终验证结果记录于实施计划。

## 目标与现状

让用户能从智能体面板选择 ACP Agent、添加和删除注册项，并在设置中修改有实际执行依据的权限规则。保留现有明暗主题与强调色，仅面向 Linux。

已阅读原方案 `../plans/2026-09-16-opencode-acp-integration.md` 的多 Agent 注册、生命周期、权限与配置所有权章节，以及现有注册 IPC、启动 IPC、权限页和授权表实现。

当前缺口：

- `AgentRegistrySettings.vue` 和注册 IPC 只提供添加、启停，没有删除入口。
- `agent_start` 只接收 `vault_id`，没有选择 Agent/profile 的公共启动参数。
- `AgentPermissionSettings.vue` 主要展示规则和来源，没有结构化规则编辑。
- `permission_grants.rs` 已记录：内置 OpenCode 的 ACP 临时始终允许不等同于 HTTP 持久授权表。不能把删除持久记录呈现为撤销全部授权。

## Zed 源码依据

2026-09-22 阅读上游，并复核固定提交 `b54cc1d0acc8fe3f7581721ee1195516e7581f9d`：

- [agent_panel.rs](https://github.com/zed-industries/zed/blob/b54cc1d0acc8fe3f7581721ee1195516e7581f9d/crates/agent_ui/src/agent_panel.rs#L5986)：新建菜单从 external_agents 生成、按显示名排序；选择项调用 new_external_agent_thread；底部 Add More Agents 打开 AcpRegistry。
- [acp.rs](https://github.com/zed-industries/zed/blob/b54cc1d0acc8fe3f7581721ee1195516e7581f9d/crates/agent_servers/src/acp.rs#L4571)：handle_request_permission 按 session 查找 thread，传递引擎给出的权限选项，并绑定请求取消。

借鉴交互及责任分层，不引入 GPUI，也不假设 Zed 原生 Agent 的工具权限规则适用于所有外部 ACP。

## 方案比较

1. 推荐：面板快捷新建菜单，加统一 Agent 管理和权限编辑页，同时补齐后端注册和启动链路。覆盖截图中的主工作流，改动范围涉及 Vue、gateway 和 Rust。
2. 只改设置页：成本较低，但创建会话仍无法方便选择 Agent，不能解决主要使用问题。
3. 完整复制 Zed 扩展市场与安装更新体系：涉及分发、校验和受管卸载，超出本轮需要。已有目录可继续复用，不在本轮自动下载执行第三方程序。

## 交互与行为

### 新建会话

- 面板标题栏使用带 tooltip 的 Plus 图标按钮，打开菜单。
- 菜单区分内置和外部 Agent，显示名称、当前选择和不可启动原因，底部提供“添加 Agent”和“管理 Agent”。
- 列表来自后端注册表；添加、删除和启停成功后刷新，失败保留明确错误与重试入口。
- 选择 Agent 创建属于它的新会话，后端验证注册状态及 profile 归属；默认调用兼容现有内置 OpenCode。
- 本轮保持现有单运行实例架构。切换前若有运行任务或待授权请求，阻止直接切换，提供停止当前任务的操作。停止完成后再启动目标 Agent。
- 旧历史保留原 Agent/profile 身份；未完成草稿保留。启动失败不得把界面标记为目标 Agent 已就绪。
- 菜单支持键盘导航、Escape 关闭、点击外部关闭及焦点返回。

### 添加与删除

- 管理页用紧凑列表显示名称、来源、启动状态和操作。添加入口支持已有目录预填与自定义本地程序。
- 表单保留名称、可执行文件和逐项参数；普通 ACP 默认选 generic 适配器，专用适配器由受验证的模板选择。ID 自动给出可编辑的合法建议，后端仍验证唯一性。
- 可执行文件与参数数组分离，不解释 shell 命令字符串。提交期间禁止重复提交；错误保留输入。
- 删除的含义是持久删除应用注册项，保留外部程序、用户配置、凭据和历史。确认框明确显示目标名称与保留内容。
- 内置默认项不能删除。正在启动、运行或等待授权的项由后端拒绝删除，UI 展示先停止操作；不因列表显示过期而绕过校验。
- 注册表变更必须持久化，写入失败恢复原内存状态。实施前核对现有持久化路径；若缺失，增加受注入存储端口与原子提交。
- 删除后历史可读；需要该 Agent 的恢复操作提示重新添加。关联 profile 保留且不能被其他 Agent 冒用。

### 权限管理

- 区分三类信息：引擎配置规则、当前进程临时授权、引擎可查询的持久授权。
- 对已验证适配器和应用受管 profile 提供结构化的工具规则编辑：询问、允许、拒绝。首批支持现有 OpenCode 工具权限格式；复杂已有规则保留原结构，不能被简单表单覆盖。
- 默认保持写入与命令执行需要询问。对不支持编辑的 Agent 显示来源和可用配置入口，不提供无效开关。
- 使用现有配置编辑服务的版本检查及原子写入，保留无关字段；外部修改冲突时要求刷新，不能覆盖。
- 保存后显示“待重启生效”；后端不可将旧进程标记为使用新规则。运行任务期间不自动重启，停止完成后可显式重启。
- 权限请求继续使用引擎下发的 option ID 和选项类型；展示操作、路径、参数或 diff，取消、超时、退出和旧会话响应不得批准请求。
- 持久授权撤销只宣称撤销对应表记录。当前 OpenCode 的临时授权通过结束并重启所属进程清除，并在实现验证后提供相应操作；不承诺所有第三方 Agent 都采用同样机制。
- ACP 权限交互不等于操作系统沙箱；不新增未验证的隔离状态。

## 实施任务与验收

每项开始和结束检查 git status，保留无关变更。实际拆分遵循业务文件 400 行即拆分、不得继续扩张超过 500 行文件的规范。

| 任务 | 文件范围 | 验收 | 测试命令 | 回滚风险 |
| --- | --- | --- | --- | --- |
| 注册删除与持久化 | Rust registry、registry_access、commands/agent_registry；对应 gateway、policy、IPC 测试 | 重启后增删有效；默认项、活跃项拒绝；写入失败回滚；并发启动无法绕过 | cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml agent_registry | 配置格式需向后兼容，不回滚用户注册数据 |
| 指定 Agent 新建 | commands/agent/lifecycle、state 启动链路、gateway session、app/agent-rail、对应测试 | Agent/profile 身份真实生效；切换失败与旧状态不混淆 | npx --yes pnpm exec vitest run apps/desktop/src/app/agent-rail.test.ts apps/desktop/src/platform/gateways/tauri-agent-gateway.test.ts | 保留旧默认参数和历史身份 |
| 管理与快捷入口 | AgentSessionBar、独立新建菜单、agent-settings 注册组件、组合层、i18n | 添加后可选；删除后消失；键盘、窄面板、失败和取消可用 | npx --yes pnpm exec vitest run apps/desktop/src/features/agent/components/AgentSessionBar.test.ts apps/desktop/src/features/agent-settings | 仅界面回滚不删除持久记录 |
| 权限规则与生效状态 | profile 权限服务、配置 IPC、权限组件、gateway、i18n、Rust IPC 测试 | 写入规则真正被新进程使用；保留复杂规则；冲突拒绝；临时和持久授权语义准确 | cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml agent_permission；npx --yes pnpm exec vitest run apps/desktop/src/features/agent-settings | 收紧权限不能被配置迁移或旧进程掩盖 |

实施时先核实测试脚本及测试筛选名称，确保实际执行了目标测试。缺失行为先写失败回归测试；安全场景必须通过 IPC 边界覆盖。注入文件系统、时钟、网络等依赖；测试取消、并发、持久化失败与过期响应。

完成后运行 typecheck、lint、完整 test 和 build，保留新鲜退出码。额外运行受影响 Rust 测试及桌面/窄面板视觉检查。没有实际执行 AppImage/deb/rpm 打包时，不声称已验证发布制品。

## 评审结论

用户确认后按推荐方案实施。权限页显示磁盘配置和启动加载范围，保存后刷新摘要，不将磁盘规则声称为当前进程已生效权限。永久显示启动加载说明，避免重新打开页面丢失生效边界。

注册表新增 `agent-registry.json` v1，仅存外部程序定义和 profile 归属，不存环境变量或凭据。文件缺失兼容原内置默认项，损坏时报告读取失败，不覆盖原文件。删除保留 profile 归属；重新添加同一 ID 可继续使用原归属。

启动与停止共享最终安装屏障，停止会使尚未完成的启动失效；握手在途时不会立即结束，但其迟到结果不能安装为当前运行实例。切换前检查所有已服务会话的运行与待授权状态；跨窗口的新任务与停止不构成一个原子操作，仍沿用既有单运行实例架构。

行数例外：`src-tauri/src/lib.rs` 既有 560 行，本轮仅在已有 Tauri command 清单增加一条删除命令注册，不增加业务逻辑；避免为此改动整个应用组合入口。其余本轮业务文件均低于 400 行。
