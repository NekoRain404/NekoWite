# NekoWite OpenCode ACP Integration Implementation Plan

> For agentic workers: 实施时使用 `subagent-driven-development` 或 `executing-plans`，逐项验证。仅在用户授权开发后执行；本次交付仅为方案。实现子代理禁止修改本文件、AGENTS.md、路线图及设计文档，进度通过任务报告提交给主代理。

**Goal:** 在 Linux NekoWite 内建立支持多个外部智能体的 ACP 宿主，首期默认集成随包提供的 OpenCode，以自有 UI 提供命令、模型、Skills、文件变更审阅和运行时管理。其他外置 Agent 为可选项，不增加普通用户的安装前置条件。

**Architecture:** Vue 界面通过中立应用契约调用 Rust 运行时，Rust 按 Agent 注册项启动 ACP 子进程，默认使用内置 `opencode acp`。业务 UI 不依赖具体 CLI 输出格式；Agent 专属配置由适配器处理，原生高级命令由独立 PTY 入口承接。保留现有 AI 补全和聊天回退，分阶段替换，不移植官方 WebUI。

**Tech Stack:** 现有 Vue 3、Pinia、TypeScript、Tauri 2、Rust/Tokio；候选 ACP SDK、PTY、终端组件及 JSONC 编辑库须在兼容性验证后另行审批依赖。

**状态:** 待评审的总体设计与开发任务分解，不代表能力已实现或兼容性已实测。协议细节、固定二进制版本及新增依赖由 P0 验证锁定；P0 之前禁止直接按猜测实现适配器。

## 1. 范围与决策

### 1.1 推荐方案

```text
NekoWite 编辑器 / 右侧智能体面板 / 设置
                    |
         应用契约 + 会话状态 + 笔记上下文
                    |
              Tauri IPC（类型化）
                    |
       Rust Agent 注册表、运行时与权限桥接
          |                         |
     ACP / stdio               独立 PTY
          |                         |
    选定 Agent 的 ACP        原生命令 / TUI
    默认 OpenCode
    可选其他外置 Agent
          |
    模型、工具、Skills、MCP
```

ACP 是协议，不是智能体引擎。使用本地 OpenCode ACP 时必须有可执行程序，但它可以由 NekoWite 内置，而不要求用户自行安装或打开终端。[OpenCode ACP 文档](https://opencode.ai/docs/acp/)

采用“随包内置基础版本 + 可选受管更新版本 + 高级外部路径”，不 fork OpenCode 主体，不复制它的模型调度与工具执行逻辑。内置 CLI 不等于内置模型，云端模型仍需相应授权和网络；第三方 MCP/Skills 的额外运行环境也不因内置 CLI 自动具备。

| 方案 | 适用性 | 决策 |
| --- | --- | --- |
| 内置 OpenCode + ACP + 自有 UI | 编辑器嵌入、进程解耦、不占用 HTTP 端口 | 主方案，先验证必需能力 |
| 内置 OpenCode + `serve` + 自有 UI | 需要 OpenCode 专属接口、与原生客户端共享服务 | ACP 关键能力不足时的备选，不默认双通道运行 |
| 官方 WebUI / iframe | 上手快，但难与笔记状态、焦点、主题和变更审阅深度结合 | 不采用 |

`attach` 面向 `serve/web` 服务，不是连接 ACP 标准输入输出的命令。不能承诺通过它无缝接管当前 ACP 会话。[CLI 文档](https://opencode.ai/docs/cli/)

### 1.2 本次包括与不包括

- 包括：Linux AppImage/deb/rpm、右侧智能体、命令入口、设置、变更审阅、SVG 插入、更新、故障恢复、测试与开发拆分。
- 保留：现有明暗主题和强调色、编辑器核心、普通笔记工作流、AI 补全能力。
- 排除：Windows、Flutter/GTK4 重写、官方 WebUI 搬运、自动迁移用户全局配置、无审核的全部权限默认放行。
- 不承诺：ACP 支持全部 TUI 交互、所有工具副作用可撤销、任何目录外访问都已被沙箱阻止。
- 本文是多个子项目的总入口。主代理应依次细化 P0 兼容性、运行时、编辑器集成、设置、发布五个实施子计划；不能一次性把整份文档交给单一代理全量改造。

## 2. 当前项目接入点

以下基于当前仓库读取结果，不是对所有模块的完整审计。

| 现有位置，相对仓库根目录 | 作用与接入原则 |
| --- | --- |
| `apps/desktop/src/features/chat/components/ChatPanel.vue` | 当前聊天面板；保留回退入口，不把进程生命周期放进组件卸载逻辑 |
| `apps/desktop/src/features/chat/composables/use-chat-send.ts` | 当前文本流处理；新智能体需要工具、权限、计划和文件事件，不直接继续扩张此文件 |
| `apps/desktop/src/features/chat/components/ChatTranscript.vue` | 当前滚动实现；新面板不能每个 token 无条件滚到底部 |
| `apps/desktop/src/features/ai/` | 现有 AI 服务；补全与智能体解耦，避免聊天替换误伤补全 |
| `apps/desktop/src/platform/gateways/` | 现有真实/内存 gateway 模式；新增 agent 契约与适配器沿用此模式 |
| `apps/desktop/src/stores/tab-write-preconditions.ts` | 已有磁盘内容冲突检查；不能绕开后直接写笔记 |
| `apps/desktop/src/features/editor/controller/editor-external-sync.ts` | 外部变更同步；接入智能体变更时保留光标、脏缓冲和冲突状态 |
| `apps/desktop/src/features/settings/components/SettingsPanel.vue` | 只增加设置导航与装配，具体页面放入独立 feature |
| `apps/desktop/src-tauri/src/commands/` | IPC 边界；校验请求归属、参数与权限，不承载协议实现 |
| `apps/desktop/src-tauri/src/state/app_state.rs` | 注册运行时状态，避免全局静态进程和跨库共享可变状态 |
| `scripts/package-linux.sh` | 增加 sidecar 制品验证；现有裸可执行文件发布方式不能假设会携带 sidecar |

历史 AI 设计文档不等于当前实现状态。本方案不覆盖已有路线图和历史方案；实现前重新读取相关文件和未提交变更。

### 2.1 已放入的 Zed 源码参考

当前仓库新增了 `zed-main/`。该目录只读，不整体加入 NekoWite 的运行时依赖、构建输入或发布包；经评审的局部源码移植单独登记。扫描到的相关实现映射如下：

| Zed 源码 | 可借鉴的设计 | NekoWite 的落地方式 |
| --- | --- | --- |
| `zed-main/crates/agent_servers/src/acp.rs` | ACP 连接、初始化能力、session config、权限反向请求、前台/后台工作切换 | Rust `agent_runtime/acp_transport.rs`、`session.rs`、`permissions.rs`；改用 NekoWite 的 Tokio/Tauri 生命周期 |
| `zed-main/crates/agent_servers/src/agent_servers.rs` | `AgentServer` 抽象和连接工厂 | 只借鉴接口分层；定义 NekoWite gateway，不引入 Zed `Project`/GPUI 类型 |
| `zed-main/crates/acp_thread/src/acp_thread.rs` | ACP 会话与消息、配置选项、线程事件的边界 | `agent_runtime/session.rs` + 前端 `agent-event-reducer.ts`，事件先经过运行时 envelope |
| `zed-main/crates/agent_ui/src/agent_connection_store.rs` | 连接状态、活动连接和状态变更 | Pinia `useAgentSessionStore`，身份额外绑定 vault/runtime epoch，防止旧会话污染 |
| `zed-main/crates/agent_ui/src/agent_panel.rs` | 面板编排、线程切换、工具状态与变更入口 | Vue `AgentPanel.vue` 只编排 props/events；协议和文件事务留在 service/platform |
| `zed-main/crates/agent_ui/src/conversation_view/thread_view.rs` | 消息分组、工具活动折叠、长线程导航 | `AgentTimeline.vue` + 专门的滚动 composable；不按 token 重建整棵 DOM |
| `zed-main/crates/agent_ui/src/message_editor.rs` | 多行输入、上下文、命令、发送/停止和焦点管理 | `AgentComposer.vue`、`AgentCommandMenu.vue`；适配中文 IME 和笔记上下文快照 |
| `zed-main/crates/agent_ui/src/agent_diff.rs` | 文件级/块级 diff、单独审阅与恢复入口 | `AgentChangesView.vue` + `agent-change-review.ts`；使用 NekoWite revision/conflict 规则而非 Git 假设 |
| `zed-main/crates/agent_skills/agent_skills.rs` | Skills 搜索路径、frontmatter 校验、大小/名称限制、排序及错误测试 | `agent_runtime/skills.rs`；先预览和隔离，绝不执行导入脚本 |
| `zed-main/crates/agent_settings/src/agent_profile.rs`、`agent_settings.rs` | Agent profile、工具许可、模型/模式选择的配置分层 | `agent-settings` feature + profile service；只序列化 NekoWite 认可的字段并保留未知字段 |
| `zed-main/crates/agent/src/thread_store.rs`、`zed-main/crates/agent_ui/src/thread_metadata_store.rs` | 线程元数据、归档、标题和持久化边界 | 应用侧会话索引；各引擎历史保持独立，不能直接共用数据库 |
| `zed-main/crates/project/src/agent_server_store.rs` | Agent 标识、启动参数、来源和更新状态；环境变量日志脱敏 | Rust `agent_runtime/registry.rs`；可执行路径与参数数组分离，外置安装不由宿主擅自更新 |
| `zed-main/crates/terminal/`、`terminal_view/` | 终端线程的生命周期和 PTY 展示 | 后期 `native_terminal.rs`；不把 PTY 控制字符送入 ACP JSON-RPC |

参考源码揭示的可迁移规则：连接、会话、UI、Skills 和终端是不同责任；连接状态需要明确的状态枚举；服务端反向请求必须由宿主处理；配置选项和能力是动态的；Skills 加载需要大小、名称、frontmatter 和排序测试。这些规则已反映到第 6、8、9、10、11 节。

### 2.2 不应直接照搬的部分

- Zed 依赖 GPUI 的单线程实体、窗口上下文、渲染树和事件调度；NekoWite 是 Vue/WebKitGTK + Tauri，不能复制 `Entity<T>`、`Context<T>` 或 GPUI timer 代码。
- Zed 的 `Project`、worktree、Git checkpoint、cloud provider、telemetry 和线程数据库不是 NekoWite 笔记模型；只能把“可审阅、可恢复、可追踪”转译为本地 revision 和 vault 约束。
- Zed 支持多个外部 agent，其 capability fallback 不能被简化成 OpenCode 必然支持；仍需按 P0 的实测能力矩阵显示按钮。
- 项目维护者允许考虑源码移植，但“双方开源”不替代许可证审查。当前 NekoWite 根许可证为 MIT；Zed 的 `agent_servers`、`agent_ui`、`agent_skills`、`acp_thread` 清单声明 `GPL-3.0-or-later`，其他部分可能不同。逐文件核对来源、许可证和依赖，由维护者确认兼容的分发方案与通知义务后才落入产品源码；本文不代替法律意见。
- `zed-main/AGENTS.md` 和 `.rules` 只约束 Zed 源码工作，不覆盖 NekoWite；NekoWite 的根 `AGENTS.md` 仍是本项目唯一开发规范。

参考目录不得进入 NekoWite 的打包、发布或 sidecar。CI 应明确排除 `zed-main/`，除非单独运行只读的架构对比脚本；这样可以防止 GPL 源码和无关依赖被误打进产品。

### 2.3 选择性移植清单

允许在许可证和依赖评审后移植小型、边界明确的实现；不把整个 Zed crate 搬入工程。UI 仅参考交互和布局，用现有 Vue 组件与主题重建。

| 优先级 | 已读源码中的具体机制 | 移植时的约束与回归用例 |
| --- | --- | --- |
| P0 | `acp.rs` 注册权限、文件和终端反向请求；授权响应绑定取消；加载期间保留 pending session | 只声明宿主真正实现的 capabilities；测试加载未结束先收到通知、取消与授权同时发生、未知会话请求 |
| P0 | `agent_connection_store.rs` 的 Connecting/Connected/Error、共享连接任务与过期结果保护 | 同一运行时并发启动去重；旧连接完成不能覆盖重启后的实例；界面收起不销毁连接 |
| P1 | `message_editor.rs` 的 SessionCapabilities、动态命令和 Skills 补全 | 不硬编码 OpenCode 命令；切换 Agent 清除旧候选；图片、上下文、Skills 分别按实际能力启用 |
| P1 | `agent_skills.rs` 的来源优先级、frontmatter 校验、容量与并发限制 | 借鉴限流与测试边界；不同引擎的目录、优先级、禁用语义由各自适配器定义，不套用 Zed 内置 Skills 规则 |
| P1 | `agent_diff.rs` 的逐文件/逐块审阅和恢复入口 | 复用 NekoWite revision/conflict 规则；“拒绝已落盘修改”实际是有冲突检查的恢复，不复制 MultiBuffer/Editor 依赖 |
| P2 | `thread_view.rs` 的滚动位置、草稿保存与延迟状态更新 | Vue 中保持滚动锚点、合并高频事件；测试上翻阅读、切换线程、恢复草稿，不移植 GPUI 借用或调度技巧 |

每个移植任务必须记录来源版本或源码哈希、路径与符号、许可证、引入依赖、适配差异、对应回归测试。主代理维护未来的 `docs/architecture/zed-port-ledger.md`；实现子代理只提交证据，不修改该记录或本方案。无法确认来源/分发条件时暂停源码复制，可继续按协议实现独立适配。

Zed 部分 UI/会话文件达到数千乃至上万行，不作为本项目文件体积的例外。按连接、会话、权限、命令、Skills、变更审阅拆成独立行为；不引入 Zed Cargo workspace、GPUI 或其全局状态设施。

## 3. 内置 CLI 与 Linux 交付

### 3.1 用户体验

1. 安装 NekoWite 后已经拥有经过验证的 OpenCode 基础版本。
2. 首次使用智能体时选择模型供应商并完成授权，不要求先安装 Node/npm/OpenCode。
3. Rust 按需启动 `opencode acp`；关闭面板不终止任务，退出应用才进入有提示的停止流程。
4. 设置显示当前版本、来源、实际路径、协议状态、更新状态，不把“进程就绪”显示为“模型可用”。
5. 高级用户可选择系统 CLI；此模式只检测兼容性，不擅自升级或替换用户安装。

“无需 Node/npm”须通过固定 Linux 制品的干净环境验证；某些工具、插件或 MCP 自身可能仍有依赖，分别提示。

### 3.2 包装与路径

Tauri 支持 `bundle.externalBin`；构建输入需要目标三元组后缀，不能把一个架构的二进制复制给所有平台。[Tauri sidecar 文档](https://v2.tauri.app/develop/sidecar/)

```json
{
  "bundle": {
    "externalBin": ["binaries/opencode"]
  }
}
```

这是对现有 `bundle` 的增量配置示例，不是替换整个 `tauri.conf.json`。例如 Linux x86_64 构建输入为 `apps/desktop/src-tauri/binaries/opencode-x86_64-unknown-linux-gnu`；运行时使用 Tauri 解析的资源/sidecar 位置，不硬编码开发路径。

发布时只声称支持实际验证的架构。需要 ARM64 时另做制品与兼容性验证，不把本次范围自动扩大。

```text
安装包（不可变）
  NekoWite 主程序
  OpenCode 基础版本与许可证

应用数据目录（由 Tauri/XDG 解析，不硬编码 HOME）
  agent-runtime/
    releases/<version>/<target>/opencode
    active.json                  # 当前受管版本指针
    downloads/                   # 未验证文件不得执行
  agent-profiles/<profile-id>/    # 配置、授权、会话数据的受管根
  agent-recovery/<vault-id>/      # 有范围和保留期限的恢复资料
```

上图是安装后的产品数据布局，不授权开发代理在仓库外创建文件。开发测试的临时 profile 必须放仓库内的测试临时目录，不能读写开发者真实凭据。

### 3.3 更新策略

- 初始版本优先随 NekoWite 一起更新；独立更新在验证迁移和回退后再开启。
- 下载固定版本和目标架构，验证可信发布清单及摘要；不能从同一不可信响应同时获取二进制和摘要便声称可信。
- 有上游签名则验证签名；若只有摘要，由 NekoWite 的可信发布流程锁定来源与摘要，记录供应链风险。
- 候选程序验证架构、执行权限、版本、ACP 初始化及基础契约测试，通过后才切换指针。
- 活跃会话期间不热替换进程，提示完成或停止任务后生效；下载中断不影响当前版本。
- 不执行 `sudo`，不写 AppImage 挂载目录或系统包目录，不替用户执行系统级 `opencode upgrade`。
- 不兼容版本保持旧版本可用；若新版本已迁移数据库，不得仅回退二进制。先验证格式兼容；必要时在进程停止后备份 profile，再进行有明确用户确认的数据恢复。
- 回退不得默默丢弃升级后产生的会话。恢复旧备份前导出/保留新数据，无法兼容时报告限制。
- 外部 CLI 模式中的更新按钮只提供版本提示与用户主动的原生入口。
- 第三方许可证和分发义务进入发布清单；不要仅复制程序而漏掉通知文件。

### 3.4 多 Agent 注册与可选外置

从第一阶段建立通用边界，但第一阶段只交付和验证 OpenCode。支持多个 Agent 是“可安装、可选择、可分别管理”，不意味着首期实现多智能体自动协作或同时修改同一笔记。

| 概念 | 所有权与规则 |
| --- | --- |
| Agent 注册项 | 稳定 `agentId`、名称、来源、可执行路径、参数数组、环境策略、启用状态、配置适配器标识；后端是权威来源 |
| 安装来源 | `bundled`、`managed`、`external`；OpenCode 默认 bundled，外置 Agent 不自动安装、不自动升级 |
| Profile | 绑定 agentId 的配置与授权选择；不在多个引擎间复制凭据、模型 ID 或配置文件 |
| 运行时实例 | 绑定 agentId、profileId、vaultId 和 runtimeEpoch；不能以一个全局 OpenCode 进程代表所有 Agent |
| 会话 | 持久化 agentId/profileId 与引擎会话 ID；不同 Agent 生成相同 sessionId 时仍须隔离 |
| 能力 | 安装声明仅用于启动提示；初始化/会话协商和实测决定运行期可用功能，重连和版本变化后重新检测 |

具体产品行为：

1. 新建会话默认 OpenCode；安装并启用其他 ACP Agent 后，新会话菜单才增加相应选项。OpenCode 内部的 agent/mode 与“选择运行时引擎”是不同层级，不能混成一个列表。
2. 切换引擎创建新会话；旧会话保留所属引擎、授权与历史。可以明确导出上下文后发起新任务，不把另一引擎会话 ID 当可恢复记录。
3. 设置增加 Agent 列表：添加本地可执行文件、启动参数、配置来源、版本、连接诊断、启用/停用。路径由后端验证，使用参数数组启动，禁止拼接任意 shell 命令。
4. 外置 ACP Agent 执行用户程序，需显式信任；注册不等于沙箱。校验文件存在和可执行只能证明可启动，不能证明程序安全。
5. 认证、模型、Skills、MCP 和原生命令保持引擎所有权。有已验证专用适配器则提供表单，否则提供路径、诊断和经确认的原生配置入口；不替未知 Agent 改 OpenCode 格式配置。
6. 不支持恢复、图片、命令、配置选项或变更信息的 Agent 显示具体限制；不能将“遵循 ACP”宣传为功能完全相同。未知扩展不透传为高权限应用操作。
7. 停用/删除注册项前处理活跃任务；默认只移除应用注册，不删除外部可执行文件、原始配置或历史。受管卸载另做明确确认。
8. 各引擎故障互不传播；退出应用仅清理宿主启动的进程。并发会话仍受笔记冲突规则约束，首期不允许未验证的同库多写入者。

禁止在组件中散落 `if (agentId === 'opencode')`；通用组件消费能力与结构化状态，引擎差异集中在明确命名的适配器。`binary_registry.rs` 只管理版本/路径，`registry.rs` 管 Agent 定义，二者不要合成万能 manager。

## 4. 完整命令：三层入口

“完整”定义为：固定受支持版本的原生命令有明确可达入口；不等于所有命令都成为 ACP RPC，也不等于所有命令都做专用表单。

本节命令清单专属于首期 OpenCode；其他 Agent 通过自己的能力和命令清单接入，不要求提供 OpenCode 同名命令。ACP 会话命令菜单可以共用，原生管理命令必须按引擎隔离。

### 4.1 会话命令

使用 ACP 的 `available_commands_update` 更新当前会话命令列表，按当前完整列表替换，不能只追加。协议提供命令名、描述及可选文本提示，不提供通用复杂参数表单；执行通过普通 `session/prompt` 发送 `/命令 参数`。[ACP slash commands](https://agentclientprotocol.com/protocol/v1/slash-commands)

- `/` 菜单支持过滤、描述、键盘选择、输入法 composition 保护、空态、加载失败与参数原样保留。
- 命令范围绑定当前运行时和会话；换会话时旧列表失效，不把 A 库命令显示到 B 库。
- 应用自己的“插入选区”“打开变更”等放独立命令面板，不抢占 OpenCode 的 `/` 命名空间。
- 自定义 OpenCode 命令仍由 OpenCode 发现和执行，不在 NekoWite 重新实现模板解释器。
- 未被公布的命令不伪装成支持；原始命令可经高级原生入口执行，显示实际错误。
- 当前官方 ACP 文档明确说明 `/undo`、`/redo` 不受支持。不得用本地聊天记录删除模拟引擎撤销。[OpenCode ACP 限制](https://opencode.ai/docs/acp/)

### 4.2 设置与管理操作

模型、认证、Skills、MCP、版本由专门设置页承接。结构化协议接口优先；仅在固定版本经过测试且有可靠输出契约时调用 CLI 管理子命令。不要把面向人类的彩色输出当稳定 JSON API。

| 原生能力组 | 自有 UI 入口 | 边界 |
| --- | --- | --- |
| `acp` | 运行时状态 | 由宿主管理，不让普通消息控制进程参数 |
| `agent`、模型选择、`models` | Agent/模型选择与设置 | 能力动态检测，缺少会话内切换时提示新会话生效 |
| `auth` | 供应商连接与断开 | 交互式流程可转原生终端；密钥不进入消息、日志或 localStorage |
| `mcp` | MCP 列表、配置、认证、诊断 | 启动本地 MCP 等于执行程序，需单独信任 |
| `session`、`export`、`import`、`stats` | 会话历史与高级操作 | 导出可能含敏感内容；引擎历史和本地 UI 缓存不能混为一谈 |
| `run`、无参数 TUI | 高级原生终端 | 不自动关联正在运行的 ACP 任务 |
| `serve`、`web`、`attach` | 高级原生入口或经评审的替代后端 | 不在普通会话后台静默开启网络服务 |
| `plugin` | 高级扩展入口 | 插件可执行代码，不与只展示 SKILL.md 的界面混淆 |
| `github`、`pr` | 原生高级入口 | 外部写入、发布、认证需用户明确发起 |
| `db`、`debug` | 诊断入口 | 日志脱敏；数据库写操作需停止相关运行时 |
| `upgrade`、`uninstall` | 受管版本设置 / 外部 CLI 原生入口 | 受管模式禁止破坏随包基线及系统安装 |
| Skills、自定义命令文件 | Skills/命令设置页 | 不是凭空构造 `opencode skills` 命令 |

命令清单以固定制品的 `--help` 和实测为准；上述分组依据当前官方 CLI 文档，不保证未来版本名称不变。[OpenCode CLI](https://opencode.ai/docs/cli/)

### 4.3 原生 PTY

- 使用成熟 PTY 库和终端渲染组件，独立于 ACP stdio。普通面板不解析 TUI 屏幕来拼接结构化事件。
- 由 Rust 启动确定的可执行程序，参数数组传递；默认不提供任意 `shell -c` IPC。
- 原生 TUI 本身具备工具执行能力，入口必须明确其权限和 profile，不得宣称它受普通按钮权限完全约束。
- 受管安装的 `upgrade/uninstall` 由宿主生命周期策略接管；完整命令访问不意味着允许破坏安装包。
- 支持 resize、中文输入、复制、长输出上限、退出状态、关闭确认；终端输出不自动写入会话记录。
- ACP 与 TUI 是否可以共享持久化会话由 P0 验证；验证前只允许独立会话，不同时操作同一运行中会话。
- 若没有实现原生入口，应标注“常用命令集成”，不能宣称“全部命令完整集成”。

## 5. 智能体面板与动画

借鉴 Zed 的“编辑器为中心、会话可见、工具可展开、变更可审阅”，不复制它所有内部能力。外部 agent 能提供的恢复、用量和会话能力存在差异。[Zed 外部 Agent](https://zed.dev/docs/ai/external-agents)

### 5.1 面板结构

```text
右侧面板
  顶部：会话 / 新建 / 历史 / 更多
  运行状态：运行中、等待授权、已停止、失败、完成
  时间线：用户消息 -> 活动/工具 -> 文件变更 -> 回复
  待处理授权：精确目标、动作、实际可用选项
  上下文：当前笔记、选区、手动附件，可移除
  输入区：多行输入、/ 命令、Agent、模型、发送/停止

变更视图
  路径列表 -> 单文件 diff -> 跳转编辑器 / 合并 / 恢复
```

- 不显示虚构百分比或模型未公开的内部思考；“正在读取/执行/等待”必须来自真实事件。
- 工具状态区分排队、运行、成功、失败、取消；长输出折叠并按需加载，仍能查看错误。
- 不自动打开所有工具涉及的笔记。跟随编辑位置默认关闭，用户滚动或编辑后暂停跟随。
- 任务可以在面板收起后继续；退出应用必须提示运行中的任务，不承诺退出后仍有守护进程。
- 每会话独立草稿、滚动位置和未读状态；错误不清空草稿，重试不默认重复有副作用的工具。
- 用量/费用只有来源可靠时展示；未知不显示为零。
- 等待授权时不锁死整个编辑器；危险操作没有响应时不自动批准。

### 5.2 顺滑原则

- 抽屉位移可用 350–450ms，整体稳定在约 500ms 内；淡入淡出约 140–220ms，允许部分重叠。
- 轻微弹性只用于抽屉终点或小控件反馈；正文、diff、滚动容器不反复弹跳。
- 优先 `transform/opacity`；布局宽度确需变化时只在容器层处理，避免逐帧触发全文排版。
- 每帧合并文本增量，不为每个 token 做动画；大 Markdown、代码高亮和 diff 增量更新或分块计算。
- 用户离开底部后不强制跟随；提供新内容提示。回到底部是明确动作，不抢阅读位置。
- 高度变化保持可见内容锚点，长工具输出展开不会把用户推到另一条消息。
- 支持 `prefers-reduced-motion`、键盘焦点、屏幕阅读器状态提示；不能每 token 都触发朗读。
- 在 Linux WebKitGTK 实机测量，不用 Chromium 测试通过替代桌面验证。帧率目标基于设备刷新率，同时记录长任务、输入延迟及掉帧。

### 5.3 以 Zed 为主要 UI 参考

用户已明确希望参考 Zed。采用其编辑器内面板的交互组织方式，而非复制品牌、配色或源码。Zed 官方面板将会话、工具活动、上下文和变更审阅放在编辑工作流中；部分历史恢复、检查点和用量功能依赖具体外部 agent，不能看到相同按钮就假定 OpenCode ACP 已提供对应能力。[Zed Agent Panel](https://zed.dev/docs/ai/agent-panel)

以下尺寸与行为是 NekoWite 的设计建议，不是对 Zed 像素尺寸的测量结果。

| 区域 | NekoWite 设计 | 不采用的做法 |
| --- | --- | --- |
| 面板标题栏 | 当前会话标题、历史、新建、更多、收起；标题允许改名 | 大标题、欢迎页、多个重复导航栏 |
| 会话切换 | 按笔记库归组，显示运行/等待/失败与未读状态 | 切换会话就停止任务、自动跨库发送 |
| 消息时间线 | 单列文档式排版；用户段落有轻背景，回复以可读正文为主 | 大头像、宽聊天气泡、每条消息套多层卡片 |
| 工具活动 | 紧凑的可展开行；名称、目标、状态，展开才看参数和输出 | 把完整工具 JSON 当聊天正文持续刷屏 |
| 文件变更条 | 输入区上方固定一行摘要，展开文件列表，单击进入 diff | 仅在最终回复里说“已修改”，找不到实际文件 |
| 上下文 | 输入框上方可移除的笔记/选区/附件项，清楚标出快照 | 默认悄悄附加整个库、把上下文写进用户正文 |
| 输入区底栏 | 附件图标、Agent/模式、模型菜单、发送或停止图标 | 把模型、权限、设置拆成多排抢占阅读空间 |
| 原生终端 | 在新建菜单提供明确的原生终端会话，外观保持一致 | 把 TUI 截图或控制字符混进普通消息 |

建议布局：

```text
+-----------------------------------------------+
| 会话标题                     历史  +  更多  收起 |
|-----------------------------------------------|
| 用户请求                                      |
|                                               |
| > 读取笔记                           已完成     |
| > 生成 diagram.svg                  进行中     |
|                                               |
| 回复正文 / 安全 SVG 预览                       |
|                                               |
| > 2 个文件发生变化                   查看变更   |
|-----------------------------------------------|
| 当前笔记  [移除]    选区快照  [移除]            |
|                                               |
| 输入消息                                      |
|                                               |
| 附件     Agent / 模式       模型          发送   |
+-----------------------------------------------+
```

线框中的工具操作文字是布局标注，落地使用现有 lucide 图标、tooltip 与可访问名称。发送使用箭头、停止使用方形；模式和模型使用菜单，不能把所有项都做成文字胶囊按钮。

- 默认面板宽约 400px，可拖拽；常用范围 360–560px，同时给主编辑器保留最小可用宽度。窗口不足时切到可展开覆盖面板或独立工作区视图，不硬挤成三列。
- 标题栏约 36–40px，工具行约 28–32px，图标点击区至少 28px；正文建议 14px 起，行高约 1.55，并尊重应用字体设置和缩放。
- 输入区初始约 96–120px，随内容增长到面板高度的约 35% 后内部滚动；短窗口仍必须看得到发送/停止与当前任务状态。
- 保持现有主题 token，使用细分隔线与克制的状态色；圆角不超过 8px，不加新的品牌色或装饰渐变。状态同时使用文字/图标，不只靠红绿区分。
- 查看变更在编辑器工作区打开专用审阅视图，右侧会话保留；窄窗口使用单列 diff。返回后恢复会话滚动位置和输入草稿。
- 普通文件列表与历史列表按需虚拟化；长消息高度动态变化时保持滚动锚点，不能为省 DOM 破坏文本选择、查找或焦点。
- 会话菜单提供复制、重命名和导出等真实可用动作；归档优先作为应用侧整理，删除引擎记录必须独立确认。重新发送有副作用的旧请求需要明确提示。
- “历史恢复”“压缩上下文”“检查点”“中途追加指令”“模式切换”只在对应能力通过验证时显示为可执行；尤其不能把普通消息排队当作引擎支持实时 steering。

新增验收落入 T6/T8/T10/T15/T16：1280x820 与 860x560、深浅主题、125%/150% 缩放、超长中文标题、长路径、菜单键盘导航、IME 输入和 reduced-motion。真实 UI 实现阶段必须截屏检查，无重叠、无按钮挤出、无工具输出撑宽面板。

## 6. 协议、状态与生命周期

### 6.1 边界

- `features/agent` 只理解应用事件，不直接处理 JSON-RPC 或导入 Tauri API。
- `platform/gateways/agent-contracts.ts` 定义跨边界契约；platform 不反向 import features。
- Rust `agent_runtime` 管进程、协议、权限回包；`commands/agent.rs` 只校验与委派。
- 各 Agent 管模型、工具循环及原生会话；NekoWite 管显示状态、编辑器上下文、用户交互和本地恢复资料。
- 运行时身份包含库、Agent、profile 和实例代次；多窗口共享同库时，P0 确定唯一会话写入者。未验证之前禁止多个宿主并发驱动同一会话。

### 6.2 建议的宿主事件契约

以下是 NekoWite 内部契约，不是宣称 ACP 原生含有这些字段；适配器负责映射和生成宿主序号。

```typescript
export type AgentEventKind =
  | 'text-delta' | 'tool-update' | 'permission-request'
  | 'commands-changed' | 'files-changed' | 'run-finished' | 'run-failed'

export interface AgentEventEnvelope<T = unknown> {
  agentId: string
  profileId: string
  runtimeEpoch: string
  vaultId: string
  sessionId: string
  runId: string | null
  sequence: number
  kind: AgentEventKind
  payload: T
}

export type AgentFailureCode =
  | 'runtime-unavailable' | 'protocol-incompatible' | 'authentication-required'
  | 'permission-denied' | 'cancelled' | 'session-stale' | 'buffer-conflict'
  | 'process-exited' | 'timeout' | 'invalid-response'
```

实现时给每种 kind 定义对应 payload 判别联合及运行时校验，不把 `unknown` 直接交给组件。会话外初始化、健康状态使用单独 runtime 事件，不能编造 sessionId。

状态机：`idle -> starting -> ready -> running -> waiting-permission -> running -> completed/cancelled/failed`。等待权限期间允许取消；进程退出使所有悬挂请求结束，旧授权按钮失效。

- 每轮只有一个主动生成任务；后续输入保存在草稿或显式队列，不偷偷并发调用同一会话。
- 会话恢复与跨会话浏览按协议能力检测；缺失恢复能力时显示中断记录，不自动重放原请求。
- 事件同时校验 agentId、profileId、runtimeEpoch、vaultId、sessionId、runId 和 sequence；取消后迟到文本不得复活任务。权限响应、快照和持久化索引使用相同的复合身份边界。
- UI 重挂载先获取宿主快照再接事件，避免订阅空窗；宿主维护快照版本和有界重放策略。
- 背压不能丢权限请求、错误或完成事件。文本可合并；超限则中止任务并报告，禁止静默丢弃数据。
- stdout 仅用于协议，stderr 独立限流和脱敏；分帧、UTF-8 分段、消息体上限由所选协议库正确处理。
- 初始化超时、认证等待、生成空闲超时分别配置，不用一个短超时误杀正常长任务。
- 子进程按 Linux 进程组清理，先正常取消/退出再限时终止；只处理宿主拥有的进程，不能杀用户系统 OpenCode。

### 6.3 权限

授权 UI 使用引擎提供的选项与 option ID，不能自行发明“永久允许”。请求绑定运行时、库、会话、任务和 request ID；重复点击幂等，过期响应拒绝。

ACP 不是安全沙箱。cwd、Tauri 文件白名单、提示词中的“只操作此库”，都不能限制 agent 自己的 shell、插件、MCP 或网络。首版应明确定位为“用户信任工作区内的智能体”，默认权限保守，不能宣传系统级隔离。

如需硬隔离，独立设计并验证 Linux sandbox：可写目录、只读挂载、网络、进程、MCP 子进程与符号链接边界。此能力未完成前，UI 不能展示“已完全隔离”。

## 7. 笔记一致性、文件审阅与 SVG

### 7.1 上下文

- 发送前固定 vaultId、笔记路径、文档 revision、选区及附件；异步阶段不重新读取“当前活动笔记”。
- 脏缓冲作为标记清楚的快照上下文；需要磁盘工具编辑该笔记时，明确选择保存后执行或先生成建议。
- 不自动上传整个笔记库、密钥文件或所有附件；上下文列表可查看和移除，模型能力不足时拒绝不支持的附件。
- 提示词不能可靠强制所有工具只读；“只生成建议”须匹配实际权限设置，未验证执行限制时说明边界。

### 7.2 外部写入与审阅

- 区分未落盘建议和已经写入的更改。前者可“应用/丢弃”，后者应“查看/恢复/合并”，不能误导用户以为尚未修改。
- 复用已有 tab 冲突检查与外部同步流程；脏缓冲遇到磁盘变化进入冲突状态，禁止自动覆盖任一侧。
- 会话开始前对明确相关的打开/附加笔记保存基线；工具事件和 watcher 结合记录变化，但不承诺所有未知文件都有写前快照。
- 只有有可靠工具关联的变化标记为智能体修改；仅 watcher 发现的变化标记为外部变化，避免归因给错误会话。
- diff 不要求库有 Git。记录基线哈希、结果哈希、来源、会话和时间；大文件与二进制分别展示摘要。
- 恢复前检查当前内容是否仍等于已记录结果；不一致则三方比较/人工合并，不能覆盖用户后续编辑。
- 应用内锁不能锁住外部 shell；普通“读取后检查再写入”不是跨进程原子比较替换。需要强保证时用隔离暂存工作区和受控发布，另立安全评审。
- 删除、重命名、附件变化均需要明确展示；没有基线时标记不可直接恢复，不伪造“撤销成功”。
- 网络调用、外部发布、数据库操作不能统一由“撤销文件修改”撤回；UI 必须区分副作用类型。

### 7.3 SVG 与笔记插入

1. 智能体生成到允许的附件暂存位置，等待文件写入完成，不逐 token 渲染不完整 SVG。
2. 使用成熟 sanitizer/解析器验证大小、复杂度、脚本、事件属性、外链、foreignObject 等风险，不用正则假装消毒。
3. 安全预览不通过随意放宽 CSP 或直接 `v-html` 执行原始内容实现；预览失败保留原文件并报错。
4. 用户确认插入后走现有附件保存和 Markdown 链接能力，处理相对路径、空格与同名冲突。
5. 插入绑定原文档 revision 和锚点；用户已经切换笔记或移动编辑位置时重新确认，不插到新活动文档。
6. 原始 SVG 与安全预览产物分开管理；插入内容仍需符合笔记渲染器的安全策略。

## 8. 设置、Skills 与配置所有权

设置分为运行时、供应商/模型、Skills、命令/Agents、MCP、权限、诊断，避免塞进现有 `AiSettings.vue`。

设置页明确显示当前管理的引擎与 profile。以下 OpenCode 规则不自动适用于其他 Agent；通用 ACP 不保证统一的 Skills 安装、MCP 管理或凭据管理接口。

### 8.1 配置模式

- 推荐应用受管 profile；已有 OpenCode 用户可显式选择复用其配置。切换模式不自动移动或覆盖旧文件。
- OpenCode 配置是多层合并，`OPENCODE_CONFIG_DIR` 不是完全隔离开关；必须实测全局配置、父目录、项目 `.opencode`、兼容技能目录和 Linux 管理配置的影响。[配置文档](https://opencode.ai/docs/config/)
- P0 验证 XDG/profile 环境策略，列出实际生效源；不能擅自重定义开发 shell 的 HOME 或假称所有全局发现已关闭。
- 凭据不放笔记库、不随云同步、不放 localStorage、不出现在命令行参数与诊断日志；受管目录和敏感文件使用最小文件权限。
- 凭据若由 OpenCode 原生文件保存，就如实显示存储方式，不宣称已经使用系统钥匙串或加密。供应商认证流优先交给引擎。
- 编辑 JSONC 使用结构化编辑器保留注释和未知字段；读取版本与保存版本冲突时重新载入/合并，不能整个文件重写。
- 运行中修改配置需标注立即生效、新任务生效或重启生效；禁止用户误认为权限已经收紧但旧进程仍有旧配置。

### 8.2 Skills

OpenCode 支持项目和全局 Skills，并兼容部分其他工具的技能目录；实际发现范围需要与固定版本一致。[Skills 文档](https://opencode.ai/docs/skills/)

- 展示名称、描述、来源目录、作用范围、冲突/覆盖关系和实际权限状态。
- 导入前预览 SKILL.md 与所带脚本；安装不执行脚本，不自动启动 MCP，不自动放开权限。
- 目录/压缩包导入检查路径穿越、符号链接逃逸、重名覆盖和大小上限；覆盖必须确认并保留可恢复副本。
- 启用/禁用只有在能影响引擎发现或权限时才提供；不能仅隐藏 UI 项目而声称已禁用。
- 项目 Skills 和应用受管 Skills 分开；删除按钮只删除用户明确选中的受管内容，不删除兼容扫描到的其他工具目录。
- 更新 Skills 展示差异、来源及新脚本，不自动信任远端新版本。

## 9. 文件拆分建议

下面是目标结构，按里程碑增量创建，禁止一次生成空目录/空文件。测试文件与行为同目录；示例树省略重复的 `.test.ts`，任务表给出关键测试入口。

```text
apps/desktop/
  src/
    app/
      agent-composition.ts           # 注入依赖、连接已有编辑器/库
    features/
      agent/
        index.ts                     # 公共入口，不透出内部实现
        components/
          AgentPanel.vue             # 编排，非协议处理
          AgentSessionBar.vue
          AgentTimeline.vue
          AgentToolActivity.vue
          AgentPermissionPrompt.vue
          AgentComposer.vue
          AgentCommandMenu.vue
          AgentChangesView.vue
          AgentNativeTerminal.vue
        composables/
          use-agent-session.ts
          use-agent-scroll.ts
          use-agent-commands.ts
        stores/
          agent-session.ts           # useAgentSessionStore
        services/
          agent-event-reducer.ts
          agent-context-snapshot.ts
          agent-change-review.ts
          agent-svg-insertion.ts
      agent-settings/
        index.ts
        components/
          AgentRegistrySettings.vue  # 可选外置 Agent 与连接诊断
          AgentRuntimeSettings.vue
          AgentProviderSettings.vue
          AgentSkillsSettings.vue
          AgentCommandsSettings.vue
          AgentMcpSettings.vue
          AgentPermissionSettings.vue
        services/
          agent-registry-policy.ts   # 注册表单校验；权威校验仍在 Rust
          agent-settings-policy.ts
    platform/gateways/
      agent-contracts.ts             # 中立契约，不 import features
      tauri-agent.ts
      memory-agent.ts
  src-tauri/
    binaries/                        # 发布流水线供应，不手工提交大制品
    src/
      commands/
        agent.rs                     # 会话与授权 IPC
        agent_settings.rs            # 配置与更新 IPC
      agent_runtime/
        mod.rs
        process.rs                   # 生命周期与进程组
        acp_transport.rs             # SDK/协议双向传输
        session.rs                   # 会话与任务关联
        events.rs                    # 规范化事件
        permissions.rs               # 待授权请求与过期
        registry.rs                  # Agent 定义与启动描述，不管理 UI
        binary_registry.rs           # 基线/更新/外部路径选择
        adapters/
          opencode.rs                # OpenCode 专属配置与能力兼容
          generic_acp.rs             # 外置 ACP 通用路径；不猜测配置格式
        update.rs                    # 下载校验与候选切换
        profile.rs                   # 配置根与环境策略
        config_edit.rs               # 保留未知字段的配置修改
        skills.rs                    # 发现、导入与范围
        native_terminal.rs           # 独立 PTY，不复用 ACP stdin
        recovery.rs                  # 基线与恢复资料，不冒充全盘事务
    tests/
      agent_runtime_test.rs
      agent_registry_test.rs
      agent_permission_ipc_test.rs
      agent_settings_ipc_test.rs
      agent_update_test.rs
      agent_native_terminal_test.rs
      fixtures/agent/                # 脱敏协议与配置样本
  e2e/
    agent-panel.spec.ts
    agent-changes.spec.ts
    agent-settings.spec.ts
    agent-registry.spec.ts
scripts/
  verify-opencode-linux.sh           # 固定制品与干净环境验证
  package-linux.sh                   # 增量接入 sidecar
```

拆分依据是责任，不是凑行数。单个业务文件 300 行规划拆分、400 行在当前改动拆分、500 行不再追加；测试超过 800 行按行为域拆分。协议帧、事件 reducer、权限状态、文件事务不能集中成一个 agent-manager。

装配文件只连接公开接口；feature 不跨目录抓其他 feature 内部文件。注释说明取消竞争、会话归属、凭据隔离、回退顺序等“为什么”，不逐行翻译代码。

## 10. 开发任务与门禁

### 10.1 P0：先证明可以接，再开发 UI

P0 交付固定版本兼容性报告，不进行全功能开发。报告由主代理写入独立审计记录，不回写本方案。

- [ ] 固定 Linux 制品版本、来源、架构、摘要、许可证；在仓库内临时 profile 运行 `--version`、`--help`，不加载用户真实配置。
- [ ] 记录初始化协商、认证、新会话、文本流、工具事件、权限、取消、会话恢复、命令更新、模型/模式切换的真实样本。
- [ ] 对每项标注“支持/不支持/需原生入口/需 serve 替代”，不能把官网描述当本地验证结果。
- [ ] 检查 Rust ACP SDK 与当前协议版本兼容性；必要的依赖与许可证先报批，未批准不改 lockfile。
- [ ] 检查 profile 隔离、父目录发现、授权落盘、网络需求、二进制独立运行与最低 Linux 系统依赖。
- [ ] 检查 ACP/TUI 会话兼容性和数据库并发限制；没证据就禁止双写。
- [ ] 用脱敏 fixture 建立自动测试；真实模型调用只在用户明确授权的测试凭据与费用范围内执行。
- [ ] 使用两个隔离的 fake ACP Agent，验证相同 sessionId 不串流、不串授权、不串模型/命令；外置功能发布前另选一个真实 ACP Agent 验证，不能仅凭 OpenCode 通过宣称多引擎兼容。
- [ ] 如采用 Zed 源码，完成来源固定、逐文件许可证/依赖评审和移植记录；未通过不复制，协议实现可独立推进。

阻断条件：授权请求无法可靠回传、取消不能结束任务、进程无法稳定托管或必要会话能力缺失。此时先提交 ACP/serve 对比结论，不通过 UI 掩盖缺口。

### 10.2 任务表

路径缩写：`S=apps/desktop/src`，`R=apps/desktop/src-tauri`，`E=apps/desktop/e2e`。下表每项是独立任务；分配时必须展开为完整文件白名单。已有共享装配点只能由指定集成者串行修改。

| 任务 | 允许修改/新增文件 | 验收与针对性测试 | 回退风险 |
| --- | --- | --- | --- |
| T1 契约与内存适配 | `S/platform/gateways/agent-contracts.ts`、`memory-agent.ts`、`memory-agent.test.ts` | 无真实进程可模拟成功、拒绝、取消、崩溃、迟到事件；运行 V1 | 低，仅新增 |
| T2 进程与协议 | `R/src/agent_runtime/{mod,process,acp_transport,events,session}.rs`、`R/tests/agent_runtime_test.rs`、对应 fixture | 拆包、非法包、超限、启动失败、退出、清理均可测；运行 R1 | 中，防进程泄漏 |
| T3 权限与 IPC | `R/src/commands/agent.rs`、`R/src/agent_runtime/permissions.rs`、`R/tests/agent_permission_ipc_test.rs` | 过期、跨库、重复响应在 IPC 层拒绝；运行 R2 | 高，安全边界 |
| T3a Agent 注册核心 | `R/src/agent_runtime/registry.rs`、`adapters/{opencode,generic_acp}.rs`、`R/tests/agent_registry_test.rs` | 默认内置 OpenCode；外置路径/参数独立校验；双 fake Agent 的同名会话隔离；运行 R8 | 中，启动与身份边界 |
| T4 注册与真实适配 | `R/src/lib.rs`、`R/src/commands/mod.rs`、`R/src/state/app_state.rs`、`S/platform/gateways/tauri-agent.ts`、`tauri-agent.test.ts`、`S/app/agent-composition.ts` | IPC 参数和事件解除订阅可测，运行 V2；旧聊天仍可用 | 中，共享装配 |
| T5 会话状态 | `S/features/agent/services/agent-event-reducer.ts` 及测试、`stores/agent-session.ts` 及测试、`composables/use-agent-session.ts` | 跨会话/旧进程事件不污染当前状态；运行 V3 | 中，事件竞争 |
| T6 面板与滚动 | `S/features/agent/index.ts`、`components/{AgentPanel,AgentSessionBar,AgentTimeline,AgentToolActivity,AgentComposer}.vue`、`composables/use-agent-scroll.ts` 及测试、`E/agent-panel.spec.ts` | 收起不中断、用户上翻不抢滚动、输入法不误发送；运行 V4/E1 | 中，UI 集成 |
| T7 权限 UI | `S/features/agent/components/AgentPermissionPrompt.vue` 及测试 | 选项与请求一致、失效后不可点击、键盘可操作；运行 V5 | 高，误授权 |
| T8 命令菜单 | `S/features/agent/components/AgentCommandMenu.vue`、`composables/use-agent-commands.ts` 及测试 | 动态替换、命令冲突、原样参数和 composition 覆盖；运行 V6 | 低，不重写引擎命令 |
| T9 上下文 | `S/features/agent/services/agent-context-snapshot.ts` 及测试、`S/app/agent-composition.ts` | 异步换库/换标签不改变已提交快照，附件可撤回；运行 V7 | 高，数据泄露 |
| T10 变更审阅 | `S/features/agent/services/agent-change-review.ts` 及测试、`components/AgentChangesView.vue`、`R/src/agent_runtime/recovery.rs`、`R/tests/agent_recovery_test.rs`、`E/agent-changes.spec.ts` | 脏缓冲不丢失、外部变化不误归因、恢复拒绝新冲突；运行 V8/R3/E2 | 高，数据恢复 |
| T11 SVG 插入 | `S/features/agent/services/agent-svg-insertion.ts` 及测试、`S/app/agent-composition.ts` | 恶意 SVG、半成品、超大文件、切换文档、锚点失效覆盖；运行 V9 | 高，渲染安全 |
| T12 profile/配置 | `R/src/agent_runtime/{profile,config_edit}.rs`、`R/src/commands/agent_settings.rs`、`R/tests/agent_settings_ipc_test.rs`、`S/features/agent-settings/services/agent-settings-policy.ts` 及测试 | 配置隔离证据、JSONC 保留、并发冲突、凭据脱敏；运行 R4/V10 | 高，用户配置 |
| T13 设置与 Skills | `S/features/agent-settings/index.ts`、树中除 AgentRegistrySettings 外六个设置组件、`R/src/agent_runtime/skills.rs`、`R/tests/agent_skills_test.rs`、`E/agent-settings.spec.ts` | 模型/MCP/命令来源明确，导入不执行脚本，禁用真实生效；运行 R5/E3 | 高，扩展执行 |
| T13a 可选外置设置 | `S/features/agent-settings/components/AgentRegistrySettings.vue`、`services/agent-registry-policy.ts` 及测试、`E/agent-registry.spec.ts` | 添加/停用、失败诊断、不擅自更新、切引擎新建会话；运行 V12/E4；共享导航由 T16 接线 | 中，配置所有权 |
| T14 内置制品与更新 | `R/src/agent_runtime/{binary_registry,update}.rs`、`R/tests/agent_update_test.rs`、`R/tauri.conf.json`、`scripts/verify-opencode-linux.sh`、`scripts/package-linux.sh` | 无系统 CLI 可启动，坏摘要不执行，迁移失败不破坏旧 profile；运行 R6/P1 | 高，供应链/迁移 |
| T15 原生完整入口 | `R/src/agent_runtime/native_terminal.rs`、`R/tests/agent_native_terminal_test.rs`、`S/features/agent/components/AgentNativeTerminal.vue` 及测试 | 中文、resize、取消、退出、受管升级限制；运行 R7/V11 | 高，任意工具能力 |
| T16 切换与发布 | `S/app/AppShell.vue`、`S/features/settings/components/{SettingsPanel,SettingsNavigation}.vue`、设置类型与明确列出的装配测试 | 新旧功能开关可回退，补全不回归，全套验证通过 | 高，共享入口 |

T13 必须再拆为“配置页面装配”和“Skills 文件操作”两个独立行为任务，禁止单人同时越界改所有设置。T6 若达到文件/行数上限，同样按时间线、输入区和滚动拆分。表中的花括号是白名单缩写，不授权修改同目录其他文件。

### 10.3 执行顺序与工作方式

依赖主线：`P0 -> T1 -> T2/T3/T3a -> T4 -> T5 -> T6/T7/T8 -> T9/T10/T11 -> T12/T13/T13a -> T14/T15 -> T16`。T14 的制品验证应在 P0 提前做小样；独立更新则在后期完成。T3a 首期只暴露默认 OpenCode，但契约先通用化；T13a 和第二个真实引擎验证可后续交付，不阻塞 OpenCode 首次集成。

每个执行子计划必须在主代理确认契约后写出具体测试代码、最小实现步骤与精确文件清单；本文不以未经验证的 SDK 方法签名冒充可直接粘贴的完整实现。

- [ ] 读取任务相关设计、当前代码、`git status --short`；记录用户未提交改动，不覆盖。
- [ ] 先写一个明确行为的失败测试，运行并确认不是环境错误或零测试造成的假结果。
- [ ] 实现最小行为，补上 IO 失败、取消、并发和旧状态测试。
- [ ] 跑最小测试，再 typecheck/lint，集成阶段运行全测和构建。
- [ ] 自查 diff、行数、注释、权限边界与依赖方向，报告结果和未验证项。
- [ ] 经主代理独立复核后交付；只有用户授权提交时才做单目的 `feat:`/`fix:`/`test:` 等提交。

### 10.4 子代理任务提示词

```text
你负责 NekoWite 的一个已明确编号的 Linux 行为任务。
开工前由主代理提供完整允许文件列表、输入契约、验收案例和测试命令；缺失则先报告，不自行扩大范围。
只修改白名单文件。AGENTS.md、本文、路线图、specs 和其他 plans 均为只读。
不得处理 NekoWite_win 或生成目录，不得覆盖用户变更，不得擅自更新依赖/锁文件。
按失败测试 -> 最小实现 -> 回归验证推进；安全逻辑必须覆盖 IPC 边界。
业务文件 300 行规划拆分、400 行执行拆分、500 行停止追加。
发现契约问题发消息给主代理，不通过修改文档或跨模块补丁自行解决。
报告必须包含：实际改动文件、测试命令与退出码、失败情况、剩余风险、需集成者处理的接线点。
未授权不得提交 Git，不得执行真实供应商付费任务，不得操作开发者真实 OpenCode profile。
```

## 11. 验证命令与用例

### 11.1 精确命令

所有命令从仓库根执行。下面的文件是任务应创建的测试入口，当前未创建；实施者不能在此刻宣称它们已通过。先确认测试被实际发现，当前 Vitest 脚本允许无测试通过，因此退出码本身不够。

```bash
# V1
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/platform/gateways/memory-agent.test.ts
# V2
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/platform/gateways/tauri-agent.test.ts
# V3
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/agent/services/agent-event-reducer.test.ts src/features/agent/stores/agent-session.test.ts
# V4
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/agent/composables/use-agent-scroll.test.ts
# V5
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/agent/components/AgentPermissionPrompt.test.ts
# V6
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/agent/composables/use-agent-commands.test.ts
# V7
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/agent/services/agent-context-snapshot.test.ts
# V8
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/agent/services/agent-change-review.test.ts
# V9
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/agent/services/agent-svg-insertion.test.ts
# V10
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/agent-settings/services/agent-settings-policy.test.ts
# V11
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/agent/components/AgentNativeTerminal.test.ts
# V12
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/agent-settings/services/agent-registry-policy.test.ts
# R1-R7 与 Skills 测试
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test agent_runtime_test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test agent_permission_ipc_test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test agent_recovery_test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test agent_settings_ipc_test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test agent_skills_test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test agent_update_test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test agent_native_terminal_test
# R8
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test agent_registry_test
# E1-E3：沿用隔离测试端口的 runner
npx --yes pnpm --filter @nekowite/desktop e2e e2e/agent-panel.spec.ts
npx --yes pnpm --filter @nekowite/desktop e2e e2e/agent-changes.spec.ts
npx --yes pnpm --filter @nekowite/desktop e2e e2e/agent-settings.spec.ts
# E4
npx --yes pnpm --filter @nekowite/desktop e2e e2e/agent-registry.spec.ts
# P1：脚本完成后在隔离的 Linux 发布环境执行
bash scripts/verify-opencode-linux.sh
npx --yes pnpm package:linux
```

测试 fixture 必须覆盖：UTF-8 跨片段、多个消息同次读取、错误 JSON、未知可选字段、超大输出、进程早退、初始化超时、权限等待时取消、取消后迟到事件、换库后迟到事件、IPC 伪造会话 ID、同请求重复响应、应用退出后的子进程清理。

文件测试必须覆盖：编辑中外部修改、保存与工具写入竞争、重命名/删除后旧路径、符号链接、SVG 恶意内容、插入前切换笔记、恢复前用户再次修改。不得仅测试正常读写。

多 Agent 测试必须覆盖：相同 sessionId/requestId 的隔离、伪造 agentId/profileId 的 IPC、重启后旧能力失效、一个进程崩溃不影响另一个、切换引擎不泄露凭据/上下文、不支持能力的降级、外置路径失效、参数含空格、环境变量脱敏、活跃时删除注册项以及同库文件修改冲突。

### 11.2 发布门禁

```bash
npx --yes pnpm typecheck
npx --yes pnpm lint
npx --yes pnpm test
npx --yes pnpm build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
git diff --check
```

以上前端 build 不等于 Linux 安装包验证。还需要 AppImage/deb/rpm 的实际安装启动、sidecar 定位、权限、卸载保留数据行为与最低系统依赖验证。

干净机器至少验证：无系统 OpenCode、无 Node、没有凭据、网络离线、供应商认证失效、配置损坏、更新中断、应用路径含空格、库路径含中文。离线启动成功只能证明运行时可用，不等于模型离线推理可用。

浏览器 E2E 使用 memory gateway 不会覆盖 Rust/ACP；必须另外执行原生 Tauri/WebKitGTK 与真实固定版本兼容性测试。所有真实调用不得使用个人未授权凭据。

动画验收使用目标 Linux 机器，固定记录分辨率、缩放、刷新率、WebKitGTK 版本与会话大小；测试抽屉反复开关、长消息流、大 diff、工具输出连续增长和编辑器同步输入。不得用增加时长掩盖主线程阻塞。

## 12. 交付里程碑与最终验收

| 里程碑 | 可交付状态 | 不得误报的能力 |
| --- | --- | --- |
| M0 | 固定版本兼容性报告、样本、依赖决策 | 不是“已完成接入” |
| M1 | 通用宿主契约、默认内置 OpenCode、基础面板、真实工具/权限/停止 | 不是“所有命令均支持”，不是“多个引擎已验证” |
| M2 | 笔记上下文、冲突保护、变更审阅、安全 SVG | 不是“全盘修改都可撤销” |
| M3 | 模型/Skills/MCP/命令设置、原生入口；可选外置 Agent 设置与第二引擎报告 | 外置接入可独立延期；只有对应引擎能力矩阵全覆盖后才称完整命令访问 |
| M4 | 更新恢复、Linux 三种包、性能与回归报告 | 不是“所有 Linux 发行版均已验证” |

新旧聊天通过明确的内部功能开关过渡；历史聊天只读保留，不自动转换成会执行工具的智能体任务。移除旧聊天是独立后续决策，不作为此次接入的前置条件。

最终验收：用户安装后不用单独安装 OpenCode；可以在自有 UI 完成常用智能体工作，并进入原生高级功能；能知道正在做什么、修改了什么、哪些行为等待授权；笔记编辑状态不被静默覆盖；版本、配置来源与能力限制可查。

多引擎验收单独记录：默认用户无需配置外置 Agent；高级用户能够添加经过验证的外置 ACP Agent；引擎切换不串会话、不串配置、不丢原有历史。未接入 ACP 的 CLI 只能作为独立终端入口或后续专用适配项目，不能直接冒充完整面板集成。

## 13. 资料与证据边界

桌宠为独立移植子项目，见 [DesktopPet 移植开发计划](2026-09-16-desktop-pet-port.md)。它复用本计划的 Agent 身份、任务状态和通知来源，设置合并进 NekoWite；不建立另一套 ACP 客户端或模型后端。优先移植主要本地功能，精简决策后置，不阻塞 ACP 核心接入。

官方资料核对日期：2026-09-16。官方文档是方案依据，不是本项目兼容性测试报告。

- [OpenCode ACP](https://opencode.ai/docs/acp/)：子进程接入及明确列出的限制。
- [ACP slash commands](https://agentclientprotocol.com/protocol/v1/slash-commands)：动态命令发现与文本调用。
- [OpenCode CLI](https://opencode.ai/docs/cli/)：原生命令边界。
- [OpenCode configuration](https://opencode.ai/docs/config/)：配置合并与发现。
- [OpenCode Skills](https://opencode.ai/docs/skills/)：技能发现与权限。
- [Tauri sidecar](https://v2.tauri.app/develop/sidecar/)：外部二进制包装。
- [Zed external agents](https://zed.dev/docs/ai/external-agents)：编辑器与外部引擎分工。
- [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel)：主要 UI 参考；本方案的具体尺寸为 NekoWite 设计建议。
- [OpenCode license](https://github.com/anomalyco/opencode/blob/dev/LICENSE)：分发前仍需针对固定版本核查许可证及依赖通知。

本次没有安装/运行 OpenCode、没有调用模型、没有修改业务代码或依赖。本方案中的测试项是开发验收要求，不是已通过的结果。
