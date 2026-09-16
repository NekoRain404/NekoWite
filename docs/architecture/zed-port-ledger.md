# Zed 源码参考登记（移植台账）

**维护者:** 主代理（方案 §2.3）。实现子代理只提交证据，不修改本文件。
**对应方案:** `docs/superpowers/plans/2026-09-16-opencode-acp-integration.md` §2.1–§2.3

本文件记录 `zed-main/` 参考源码的来源、许可证与**允许的使用方式**。它存在的理由是：设计参考是许可中性的，源码复制不是——两者必须能一眼区分，否则某次「顺手抄一段」会悄悄把 GPL 代码带进 MIT 产品。

## 1. 来源固定

| 项 | 值 |
| --- | --- |
| 目录 | `zed-main/`（**已 gitignore，不得进入构建输入、sidecar 或发布包**） |
| 版本标识 | Cargo workspace `version = "0.62"`（`zed-main/Cargo.toml`） |
| 提交标识 | **无**——该目录不带 `.git`，无法给出 commit id。下方逐文件 sha256 前 16 位即本台账的固定依据 |
| 根许可证文件 | `LICENSE-GPL`（GPLv3 全文）、`LICENSE-APACHE`（Apache-2.0） |
| 官方说明 | `zed-main/README.md`：「Zed source code is licensed primarily under GPL-3.0-or-later, with Apache-2.0 components where marked.」 |

因为拿不到 commit id，**核对必须落到文件哈希**。若某文件哈希与下表不符，说明本地参考目录被换过版本，此前依据它的任何结论都要重新确认。

## 2. 许可证与使用规则

本项目根许可证为 **MIT**（`LICENSE`）。§2.1 点名要参考的 crate 逐个核对声明如下——**全部是 `GPL-3.0-or-later`，无一例外**：

| crate | 声明 |
| --- | --- |
| `agent_servers`、`agent_ui`、`agent_skills`、`acp_thread` | `GPL-3.0-or-later` |
| `agent`、`agent_settings`、`project`、`terminal`、`terminal_view` | `GPL-3.0-or-later` |

由此分出两条路，不要混：

- **允许（许可中性，无需任何决定）：读懂它的职责划分、状态机、边界与失败处理，然后按 NekoWite 的技术栈独立实现。** §2.1 的映射表、§2.3 的移植清单指的都是这条路。这是当前唯一在进行的使用方式。
- **受限（需要维护者先做分发决策）：把源码复制、改写或逐段翻译进产品源码。** GPL-3.0-or-later 是强 copyleft，落入产品即改变整个分发物的许可条件。维护者已表示「可以后续更改许可证」——那**解除的是时间压力，不是当下的许可状态**：在许可证真的改完之前，复制仍属未清理。

方案 §2.3 的兜底规则照常适用：无法确认来源或分发条件时，暂停源码复制，按协议独立实现——**这不会阻塞任何任务**，因为 §2.3 的每一条约束本身都能用独立实现满足。

### 2.1 关键更正：ACP 协议层不是 Zed 的代码

方案 §2.1 把 `acp.rs` 映射到 `agent_runtime/acp_transport.rs`，容易被读成「要把 acp.rs 搬过来」。**实测不是这样。** Zed 在 workspace `Cargo.toml` 里声明：

```toml
agent-client-protocol = { version = "=2.1.0", features = ["unstable"] }
```

它解析到 `registry+https://github.com/rust-lang/crates.io-index`——**crates.io 上的独立官方 ACP Rust SDK**（`github.com/agentclientprotocol/rust-sdk`），**Apache-2.0**，2026-09-04 发布，未被 yank，要求 Rust ≥1.88.0（本机 1.95.0）。

| 项 | 值 |
| --- | --- |
| crate | `agent-client-protocol` **2.1.0**（features: `unstable`，与 Zed 同版本锁定） |
| 许可证 | **Apache-2.0**——与 MIT 兼容，**可作为普通依赖直接使用，无需任何许可证决策** |
| TS 对应物 | `@agentclientprotocol/sdk` 1.4.0，同为 Apache-2.0（本项目 TS 侧按 §6.1 不碰 JSON-RPC，暂不使用） |

**推论：分帧、JSON-RPC、请求/响应关联、超时、`Lines`/`Responder`/`Client`/`Agent`/`ConnectionTo` 与 `schema` 类型，全部来自该 SDK。** Zed 的 `acp.rs`（5119 行）只是该 SDK 与 GPUI/`Project`/`terminal::TerminalBuilder` 之间的胶水，而 §2.2 本来就禁止我们照搬这些依赖。

这条是本台账目前最有价值的结论：**「照搬 Zed 的 ACP」的正确层次是「依赖同一个 SDK」，而不是移植源码**——既不触碰 GPL，也不需要手写传输层。

### 2.2 维护者决策（2026-09-16）

维护者已就移植范围作出决定，记录如下：

- 「zed的acp是我们的重中之重，请你除了ui其他尽可能照搬或者略微修改，UI只作为参考」——**ACP 逻辑层尽量忠实移植**（照搬或轻改）；**UI 仅作参考**，用现有 Vue 组件与主题重建（与 §2.2「不复制品牌、配色」及 §5.3 一致）。
- 「我们可以后续更该许可证」——GPL 问题**解除时间压力，但不是当下的许可状态**：在许可证真的变更落地之前，逐段复制 Zed 源码仍属未清理，继续按 §2.3 的兜底规则处理。

即便如此，实际可行的做法仍然是**先用 SDK + 独立实现覆盖绝大多数需求**，只在确有必要时才走源码复制并逐条登记到 §4。原因不是保守，而是 §2.2 已经列明的那几条依赖（GPUI 单线程实体、`Project`、worktree、GPUI 定时器）在 Vue/WebKitGTK + Tauri 里没有对应物，搬过来无法编译，只能改写——改写后的产物本就该按本项目规范重新组织。

## 3. §2.1 参考文件清单

`sha256` 取前 16 位。全部文件在编写本台账时均存在。

| 文件 | sha256[:16] | 用途 | 状态 |
| --- | --- | --- | --- |
| `crates/agent_servers/src/acp.rs` | `05b6c74933380669` | 权限/文件/终端反向请求、授权绑定取消、加载期 pending session | 设计参考 |
| `crates/agent_servers/src/agent_servers.rs` | `a6098c7ae08212fc` | `AgentServer` 抽象与连接工厂分层 | 设计参考 |
| `crates/acp_thread/src/acp_thread.rs` | `b09dae4917041d34` | 会话/消息/配置选项/线程事件边界 | 设计参考 |
| `crates/agent_ui/src/agent_connection_store.rs` | `87c68918effbadf9` | Connecting/Connected/Error、共享连接任务、过期结果保护 | 设计参考（T5） |
| `crates/agent_ui/src/agent_panel.rs` | `b3e5212020cf582d` | 面板编排、线程切换、工具状态入口 | 设计参考（T6） |
| `crates/agent_ui/src/conversation_view/thread_view.rs` | `08b77337945ceb5d` | 消息分组、工具折叠、滚动锚点 | 设计参考（T6） |
| `crates/agent_ui/src/message_editor.rs` | `d242c47ed1c9b5cf` | 多行输入、上下文、命令、发送/停止、焦点 | 设计参考（T6/T8） |
| `crates/agent_ui/src/agent_diff.rs` | `10d789e75bdb2f14` | 文件级/块级 diff 与恢复入口 | 设计参考（T10） |
| `crates/agent_skills/agent_skills.rs` | `9ab67cedfeea9008` | Skills 来源优先级、frontmatter 校验、容量限制 | 设计参考（T13） |
| `crates/agent_settings/src/agent_profile.rs` | `c8744bf10d6ff180` | Agent profile 与工具许可配置分层 | 设计参考（T12） |
| `crates/agent_settings/src/agent_settings.rs` | `a1af83e4c5e50399` | 同上 | 设计参考（T12） |
| `crates/agent/src/thread_store.rs` | `44c97689232357b8` | 线程元数据与持久化边界 | 设计参考（T5） |
| `crates/agent_ui/src/thread_metadata_store.rs` | `8af0ab11263b30c7` | 归档/标题/持久化边界 | 设计参考（T5） |
| `crates/project/src/agent_server_store.rs` | `744931678ec66a62` | Agent 标识/启动参数/来源/更新状态；日志脱敏 | 设计参考（T3a） |

## 4. 逐文件移植记录

**目前为空——尚无任何 Zed 源码进入产品代码。**

需要登记时的格式（方案 §2.3）：来源文件与哈希、被移植的符号、许可证、引入的依赖、与参考的适配差异、对应回归测试、维护者对分发条件的确认。

## 5. 不得照搬的部分（方案 §2.2）

- GPUI 的 `Entity<T>`/`Context<T>`、单线程实体、渲染树、事件调度：NekoWite 是 Vue/WebKitGTK + Tauri，没有对应物。
- `Project`、worktree、Git checkpoint、cloud provider、telemetry、线程数据库：NekoWite 的模型是笔记与 vault，只能转译为本地 revision 与冲突规则。
- capability fallback 不能简化为「OpenCode 必然支持」：按 P0 实测能力矩阵显示按钮。
- `zed-main/AGENTS.md` 与 `.rules` 只约束 Zed 源码工作；NekoWite 的根 `AGENTS.md` 是唯一开发规范。
- Zed 部分文件数千至上万行，**不构成本项目文件体积的例外**：按连接、会话、权限、命令、Skills、变更审阅拆开。
