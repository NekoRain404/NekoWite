# P0 — OpenCode ACP 兼容性报告（Linux x86_64）

**日期:** 2026-09-16 · **方案:** `docs/superpowers/plans/2026-09-16-opencode-acp-integration.md` §10.1
**执行者:** 主代理 · **本报告不回写方案文件**（方案只读）

本报告只记录**实测**。每条都给出可复现的命令与原始输出要点；没有测到的部分在 §4 明确列出，**不得**在后续任务里当作已验证。

---

## 1. 固定制品

| 项 | 值 |
| --- | --- |
| 包 | `opencode-linux-x64@1.18.29`（npm 平台包，对应主包 `opencode-ai@1.18.29`） |
| 来源 | `https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-1.18.29.tgz` |
| 许可证 | **MIT**（`opencode-ai@1.18.29`；分发时的 NOTICE 义务见 §4） |
| 注册表声明摘要 | `sha512-X8/wS/8mzL7Ko0zYYF6RzKax39KkxXDRoimhmzXuo0gPrZX4DQjqBNpPAByBwUjFapk73ZGSVsjDGvoNapBa1Q==` |
| 下载包实测 sha512 | **与声明一致**（脚本内校验，不一致则拒绝安装） |
| 安装后二进制 sha256 | `ca6c0e1f42be3120595bf6848937e7586ec862c87fa7aa111e89c7cc6e9a4650` |
| 大小 / 类型 | 184,666,240 字节 · ELF 64-bit LSB executable, x86-64, dynamically linked |
| 最低依赖 | `ldd` 缺失项 **0** —— 自带运行时，符合「无需 Node/npm」前提 |
| 安装位置 | `apps/desktop/src-tauri/binaries/opencode-x86_64-unknown-linux-gnu`（**已 gitignore**，176 MB 不进提交） |
| 获取方式 | `scripts/fetch-opencode-linux.sh`（版本与摘要内嵌在脚本里；`--tarball` 可校验已下载文件） |

`opencode --version` → `1.18.29`，与包版本一致。**不使用**系统安装的 `/usr/bin/opencode`；上述 P0 全部针对将被内置的那份制品。

## 2. 实测的 ACP 行为

传输：`opencode acp` 在 stdio 上收发**换行分隔的 JSON-RPC**（`--cwd` 指定工作目录；另有 `--pure/--print-logs/--log-level`）。探针：`.tmp-p0/acp-live-prompt.mjs`（仓库内临时 profile，`--pure` 未使用）。

### 2.1 initialize（协议协商）

请求 `{protocolVersion: 1, clientCapabilities: {}}` → 应答：

```json
{"protocolVersion":1,
 "agentCapabilities":{"loadSession":true,
   "mcpCapabilities":{"http":true,"sse":true},
   "promptCapabilities":{"embeddedContext":true,"image":true},
   "sessionCapabilities":{"close":{},"fork":{},"list":{},"resume":{}}},
 "authMethods":[{"id":"opencode-login","name":"Login with opencode",
   "description":"Run `opencode auth login` in the terminal"}],
 "agentInfo":{"name":"OpenCode","version":"1.18.29"}}
```

**结论：方案假设的 ACP v1 成立**；`loadSession`（会话恢复）、`resume/close/fork/list`、`embeddedContext`、`image` 都是引擎自报能力。`authMethods` 只有交互式终端登录一种——**非交互授权必须走供应商配置**（见 2.3）。

### 2.2 会话与命令

`session/new {cwd, mcpServers: []}` **无需任何凭据即可成功**，返回 `sessionId` 与 `configOptions`（一个 `model` 选择项，`currentValue` 默认 `opencode/big-pickle`，选项为引擎内置大目录）。随后引擎主动下发一条通知：

```json
{"method":"session/update","params":{"update":{"sessionUpdate":"available_commands_update",
  "availableCommands":[{"name":"customize-opencode",...},{"name":"init",...},{"name":"review",...}]}}}
```

**结论：方案 §4.1「按完整列表替换、不追加」的动态命令模型有实测支撑**；命令在 `session/new` 后随通知到达，不是同步返回。

### 2.3 模型选择与真实调用

`session/set_config_option {sessionId, configId: "model", value: "iapp/deepseek-v4-flash"}` → **接受**，回传的 `configOptions[model].currentValue` 即为所选值。**会话内切换模型可用**（方案 §4.2 设想的「缺少会话内切换时提示新会话生效」在本版本不适用）。

供应商配置（仓库内临时 profile 的 `opencode.json`）：

```json
{"provider":{"iapp":{"npm":"@ai-sdk/openai-compatible","name":"iApp Gateway (P0 test)",
  "options":{"baseURL":"https://ai.iapp.dpdns.org/v1","apiKey":"{env:NWK_TEST_KEY}"},
  "models":{"deepseek-v4-flash":{"name":"DeepSeek V4 Flash"}}}}}
```

**实测结论：`{env:VAR}` 替换生效**；凭据只经子进程环境传入，不需要 `auth login`，不写进任何仓库文件。

真实一轮（`session/prompt`，文案 `Reply with exactly: PONG`）：

```json
{"stopReason":"end_turn",
 "usage":{"inputTokens":8717,"outputTokens":3,"totalTokens":8732,"thoughtTokens":12}}
```

线上观察到的事件类型：`agent_message_chunk`、**`agent_thought_chunk`**、`available_commands_update`。用量随结果回传，来源可靠（方案 §5.1「用量只有来源可靠时展示」在此成立）。

> `agent_thought_chunk` 不在方案 §6.2 的 `AgentEventKind` 里。契约需要为它留位置或显式丢弃——**不能让它落进 `unknown` 直接交给组件**（§6.2 的要求）。

### 2.4 阻断级发现：TLS 证书校验

**未设置 `NODE_EXTRA_CA_CERTS` 时，任何一次 prompt 都以不可理解的错误失败：**

```
{"code":-32603,"message":"Internal error: unknown certificate verification error",
 "data":{"service":"session","errorName":"UnknownError"}}
```

链本身没有问题——OpenSSL 实测 `Verify return code: 0 (ok)`：叶 `CN=iapp.dpdns.org` → `Let's Encrypt YE1` → `ISRG Root YE` / `ISRG Root X2`。这是 Let's Encrypt **2025 年新层级**，而 Bun 编译产物自带 CA 集合里没有它。

**实测修复：** 子进程环境加 `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` → 同一轮立刻成功（§2.3 的结果就是这么取得的）。

**对集成的要求（必须落进运行时）：**
1. Rust 启动引擎时传入可用的 CA 包；或者
2. 至少把这一类错误识别出来，给用户「证书不受信任 / 可能是系统 CA 缺失」而不是 `unknown certificate verification error`。
3. **禁止**以关闭校验（`NODE_TLS_REJECT_UNAUTHORIZED=0`、insecure 选项）作为绕过。UI 也不得显示「已完全隔离/已加密」来掩盖。

这条对**自签/企业 CA/新根**的用户是普遍问题，不是这个网关的特例。

## 3. 凭据与临时数据（执行方式）

- 测试 key 仅存于**仓库外** `/tmp/nkw-test-key`（0600），只经环境变量传给被测进程：不进 argv、不进仓库、不进 profile 配置、不进日志。
- opencode 的临时 profile 在**仓库内** `.tmp-p0/profile/`（方案 §3.2 要求），其 `opencode.json` 只含 `{env:NWK_TEST_KEY}` 引用，**不含密钥**。
- **建议轮换该测试 key**：它已出现在对话记录中。
- 一个真实调用的花费：8,732 tokens（一轮问答）。

## 4. 明确**未**验证（不得声称）

- **权限请求（permission-request）**：探针的提示词不触发工具，线上未出现授权帧。T3/T7 的契约不能以「已验证」开头。
- **取消**（`session/cancel`）、**会话恢复**（`session/load`）、`fork`/`close`/`list`：能力自报存在，**未逐一实测**。
- **客户端 fs 能力**（`readTextFile`/`writeTextFile`）：只用 `{}` 能力集跑过；带 `fs` 的握手发过一次、未使用。
- **profile 隔离完整性**：设置了 `HOME`/`XDG_*`，但方案点名的 `OPENCODE_CONFIG_DIR`、父目录 `.opencode`、兼容技能目录**未验证**；「关闭了所有全局发现」目前**没有证据**。
- **ACP 与 TUI 的会话/数据库并发**：未测；方案要求「没证据就禁止双写」。
- **架构变体**：仅 x86_64-gnu。musl/baseline/arm64 未测。
- **许可证通知义务**：MIT 已确认，但**分发时的 NOTICE/依赖通知清单未编制**（方案 §3.3 要求进发布清单）。
- **本机系统包 `/usr/bin/opencode 1.18.29-1`**（Arch）与之行为是否逐字一致：未比对；不作为依据。

## 5. 下一步（按方案 §10.3 依赖主线）

`P0 ✅ → T1（契约与内存适配）→ T2/T3（进程与协议、权限与 IPC）→ T4（注册与真实适配）→ …`

T2 的验收清单里应加入本报告 §2.4：**进程启动环境必须带 CA 包，且有一例针对「证书不受信任」的失败路径测试**。
