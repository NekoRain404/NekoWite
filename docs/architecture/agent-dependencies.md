# ACP 集成的依赖决策记录

**对应方案:** `docs/superpowers/plans/2026-09-16-opencode-acp-integration.md` §10.1——「必要的依赖与许可证先报批，未批准不改 lockfile」。

本文件是**审批记录**：哪些依赖已决定、依据是什么、还有什么未定。方案本身只读，依赖结论记在这里。

**本项目根许可证为 MIT。**

> **许可证审查暂缓（维护者决定，2026-09-16）**：「先忽略许可证的问题，这个最后解决」。下表「许可证」一列**不在实施阶段作为闸门**——实施代理可自由选用下列库，不必先取得许可结论。逐项许可事实仍然记录在案，收尾阶段一次性处理分发与通知义务。见 `docs/architecture/zed-port-ledger.md` §2.2。

即便如此，本文档仍把许可证逐项写明，因为**收尾阶段的决策需要这些事实**，而事后重新调研的成本远高于顺手记录。建议（非阻塞）：DOMPurify 直接选 Apache-2.0（免费且干净）；git 若引入选 `gix` 而非 `git2`。

## 1. 已决定并已落地

| 依赖 | 版本 | 许可证 | 用途 | 状态 |
| --- | --- | --- | --- | --- |
| `agent-client-protocol` | `=2.1.0`（features: `unstable`） | **Apache-2.0** | ACP 协议层：分帧、JSON-RPC、`Lines`/`Responder`/`Client`/`Agent`、schema | **已加入** `apps/desktop/src-tauri/Cargo.toml`（T2） |
| `tokio-util` | `0.7` + 新增 **`compat`** feature | **MIT/Apache-2.0** | 已有依赖，仅加 feature：用于在 SDK 的 `Lines` 之外套一层**有界**适配器 | **已批准**（T2 实施） |

版本锁定 `=2.1.0` 与 Zed 完全一致（见移植台账 §2.1）。官方 SDK，`github.com/agentclientprotocol/rust-sdk`。TS 侧对应物 `@agentclientprotocol/sdk` 1.4.0 同为 Apache-2.0，但按 §6.1「features/agent 不直接处理 JSON-RPC」，**TS 侧不使用**。

`tokio-util` 已是依赖，加 feature 不引入新的供应链条目，也不扩大许可证面，是能达成目标的**最小改动**。

### 1.1 实测推翻的方案假设（T2）

| 方案原文 | 实测 | 后果 |
| --- | --- | --- |
| §6.2「分帧、UTF-8 分段、**消息体上限**由所选协议库正确处理」 | **SDK 的 `Lines` 没有任何大小上限**（源码中无任何 `MAX_*`）。9 MiB 无换行帧既不被接受也不被拒绝——它永远不会成为一条消息 | §6.2 同一段又要求「超限则中止任务并报告，禁止静默丢弃数据」，**该要求无人满足**。超时只约束时间不约束内存，1 秒内 9 MiB 仍是 9 MiB。故需自带有界适配器 |
| （我的派发指令）「SDK 不管进程，spawn / 进程组 / 组 kill 都归你」 | **错**：`AcpAgent` 自己 spawn、设 `process_group(0)`、并用 `rustix::process::kill_process_group` 杀整组。`process.rs` 因此从 419 行降到 98 行 | 该判断来自读 import 列表而未核实，已由 T2 纠正 |
| （同上）「超时由 SDK 提供」 | **错**：SDK 内 `grep timeout` 无结果，**完全没有超时** | 本层所有超时均需我们自己实现 |
| — | **SDK 只用 `SIGKILL`** 清理 | §6.2「先正常取消/退出再限时终止」在**信号层**无法满足。若「先 cancel、关 stdin、设宽限、再让组 kill 落地」的顺序成立则协议层已足够；顺序待 T2 实测 |

## 2. 契约扩展（非方案原文，需保持两侧同步）

| 项 | 说明 |
| --- | --- |
| `certificate-untrusted` | **第 11 个 failure code**。方案 §6.2 的 `AgentFailureCode` 只有 10 个，但 P0 §2.4 要求证书类失败自成一类（否则退化为 `unknown certificate verification error` 这类用户看不懂的原文）。Rust 侧（T2）已实现，**TS 侧（T1）必须同步加入**，否则分类会在边界丢失 |


## 2. 调研结论：**不要新增**的依赖

调研（`.superpowers/sdd/roadmap/ports/dep-proposals.md`，325 行）逐项核对了仓库现状，纠正了两个会导致返工的预设：

| 需求 | 错误预设 | 实测 |
| --- | --- | --- |
| 文件 diff（§7.2） | 需要引入 diff 库 | **仓库已有** `apps/desktop/src/services/diff.ts`（156 行，`lineDiff`/`compareDocuments`/`diffStats`，含 `DIFF_MAX_LINES = 2000` 的有界截断与整篇 identity 判定）。**不加任何 diff 库**；仅词级 diff 是缺口，建议暂不加 |
| JSONC 语法高亮（§8.1） | `@codemirror/lang-json` 可用 | 该包（lock 中已有 6.0.2）的 lezer 语法是 `@skip { whitespace }`，**注释会直接变成 parse error**，不能用于 JSONC。需要一个真正支持注释的解析器 |

## 3. 待决策项

以下均为**新增**依赖（仓库当前无 `diff`/`dompurify`/`xterm`/`jsonc`/`pty` 任何一项），尚未安装。

| 需求 | 建议 | 版本 | 许可证 | 备注 |
| --- | --- | --- | --- | --- |
| PTY（§4.3） | `portable-pty` | 0.9.0 | **MIT** | 来自 wezterm。**必须从 crates.io 取，不得从 `zed-main/` 拷贝**——Zed 树内同名 crate 是 GPL-3.0-or-later |
| 终端渲染（§4.3） | `@xterm/xterm` | 6.0.0 | **MIT** | **见 §4 的 WebKitGTK 风险，这是本表最大风险项** |
| JSONC 编辑（§8.1） | `jsonc-parser` | 3.3.1 | **MIT** | 保留注释与未知字段 |
| SVG 消毒（§7.3） | DOMPurify | 3.4.15 | **MPL-2.0 OR Apache-2.0** | 双许可，**必须显式选 Apache-2.0** 以保持 MIT 兼容，不能默认接受 MPL |
| Git（用户追加） | **第一阶段不引入** | — | — | 见 §5 |

**明确不要用**：npm 上的 `wterm` 终端包是占位空壳（0.0.1，526 字节，描述仅 "TEST"），不要照名字添加。

## 4. 最大风险：WebKitGTK 上的终端渲染

**没有任何一手来源能确证 xterm.js 在 WebKitGTK 上可用**，且有两例已记录的失败：

1. **WebGL addon 在 WebKit 下直接起不来，并会把 `╔╗║╚╝` 这类 box-drawing 字符渲染错乱**——而 TUI 正是靠这些字符画界面的，这等于功能性失败。
2. **canvas + 透明在 WebKit 下产生绿色伪影**，WebKit bug 264268 明确复现于 **Tauri on Linux**（正是我们的运行环境）。

缓解办法很干净：**只用 DOM 渲染器，不加载任何 renderer addon**（v6 已移除 canvas renderer，不加载 addon 时 DOM 即默认）。但**这必须在 P0 阶段用真机 spike 验证，不能推迟到 T15**——否则终端功能可能在实现末期才暴露不可用。

另外两条仍未证实：xterm.js 的 CI 是否覆盖 WebKit（Playwright 配置路径 404）；以及**中文输入的修复只存在于 6.1.0-beta，不在 6.0.0 稳定版**（Linux IBus/fcitx 的 keyCode-229 陈旧 preedit 问题）。§4.3 明确要求终端支持中文输入，因此这一条直接影响版本选择：要么接受 6.0.0 的输入缺陷，要么评估 beta。**需要一次显式决策。**

## 5. Git 集成：建议第一阶段不引入

用户提出可以集成 git。调研给出了一个具体的反对理由，且它就藏在方案自己的归因规则里：

**用用户的 HEAD 做 diff，会把用户自己尚未提交的改动当成「智能体修改」。** 这直接违反 §7.2 的归因要求——「只有有可靠工具关联的变化标记为智能体修改；仅 watcher 发现的变化标记为外部变化，避免归因给错误会话」。

而 §7.2 真正需要的「基线哈希」用**已有的 `sha2` 0.10 + 现有 storage 层**即可满足，且非 git 仓库的 vault（这是常态）本来就用不上 git。

若后续确实要加速，结论是：
- 选 **`gix`**（纯 Rust，MIT OR Apache-2.0），避开 `git2`/libgit2 的 **GPL-2.0 WITH linking exception**（可用，但必须记入发布清单）；纯 Rust 对 AppImage/deb/rpm 打包也更友好。
- **只存 blob，不注册 worktree**——否则 `.gitignore` 会让被忽略文件的改动在审查中不可见。
- 绝不向用户仓库提交、不碰其 index、不假设其工作树是干净的。

## 6. 范围外发现（与 ACP 无关，另立任务）

`apps/desktop/src/plugins/callout.ts:23` 以 `innerHTML: props.children` 渲染 Callout 内容，而 `children` 来自笔记 MDX 中作者可自由填写的部分。**这是全仓库源码中唯一一处对笔记内容的未消毒注入点**（其余 `innerHTML` 命中全部是测试里的 `document.body.innerHTML = ''`）。

值得注意的是，同一功能在**导出侧已把该内容当作不可信**：`services/export-renderers.ts` 有 `Callout: (props, childrenHtml) => …`，且其测试用 `{ type: 'warn" onclick="x()' }` 验证过转义。**编辑器侧没有对应的处理**，两者不一致。

在 Tauri 下这不是普通 XSS：webview 持有指向文件命令的 IPC 通道，打开一份来自外部的 `.md` 即可触达。与 §7.3「不用正则假装消毒」「安全预览不通过随意放宽 CSP 或直接 `v-html`」属同一类问题，建议单独修复，不要并入 ACP 任务。
