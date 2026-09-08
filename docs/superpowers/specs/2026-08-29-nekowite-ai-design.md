# NekoWite v1.4 AI Ghost-writer Design

- 日期：2026-08-29
- 状态：已确认
- 前置：v1.0–v1.3 已合并至 master（编辑器/三态视图/插件/数学/引用/导出）

## 1. 目标

在编辑器中提供 AI 补全（ghost-writer）：光标处按 `Tab` 触发单轮建议 → 渲染为 inline 幽灵文本（grey，未插入文档）→ 再按 `Tab` 接受 / `Esc` 拒绝。BYOK：用户自带 API 键，直连 OpenAI / Anthropic / Google Gemini / xAI Grok / 本地 LM Studio 或 Ollama（OpenAI-compatible）。键不落明文 localStorage。

## 2. 技术选型

| 项 | 选型 | 理由 |
|---|---|---|
| 请求路径 | **Rust 后端代理**（`reqwest` + `tauri::command` + 事件流） | 彻底绕开浏览器 CORS（OpenAI/Anthropic 均禁浏览器直连）；支持流式 |
| 流式回传 | Tauri 事件 `ai-chunk` / `ai-done` / `ai-error`；前端 `ai-cancel` 命令 | 类型化、低延迟、可取消 |
| 键存储 | **tauri-plugin-stronghold**（加密 vault） | 纯文件加密，不依赖系统 keyring，跨平台一致 |
| 编辑器集成 | editor-core 轻量建议接口（inline decoration，不动节点模型） | 与三态视图/保存路径解耦，ghost text 不进入 markdown |
| 前端 | Pinia `settings` store（provider/model/key）+ `ai.ts` 服务 + `GhostWriter.vue` | 模块化，可单测 |

## 3. 核心设计

### 3.1 Rust 后端（`apps/desktop/src-tauri/src/ai.rs`）

- `AIConfig = { provider: 'openai'|'anthropic'|'gemini'|'grok'|'local'|'custom', model: string, base_url?: string, api_key?: string }`
- `ai_complete(app, config, prompt): Result<(), String>` —— 启动一次流式请求，按供应商映射 endpoint：
  - openai/grok/local/custom：`POST {base}/chat/completions`（OpenAI-compatible），`stream: true`，SSE。
  - anthropic：`POST {base}/v1/messages`，`stream: true`，SSE（anthropic 的 message_start/content_block_delta）。
  - gemini：`POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse`。
  - **统一归一**：各供应商 SSE 解析出纯文本增量 → `app.emit('ai-chunk', { id, text })`。
- `ai_done(id)` / `ai_cancel(id)` —— 完成/取消（Abort），完成后 `app.emit('ai-done', { id, full })`；错误 `ai-error`。
- 并发：允许多个并发请求，按 `id` 路由（与前端流关联）。

### 3.2 键存储（stronghold）

- `store_key(app, provider, key)` / `load_key(app, provider) -> Result<Option<String>>`。
- **主密码决策（已定）**：v1.4 首启动自动生成一个 32 字节随机主密码，写入 vault 目录 `.nekowite/master.key`（权限 `0600`，仅本用户可读），用它解锁 stronghold。设置面板可选「设置自定义主密码」（更改后用新密码重加密 vault 并更新密钥文件）。文档明确：本机绑定、无主密码保护的文件级防护，适合 BYOK 个人工具；若需强防护请设自定义主密码。

### 3.3 前端

- `apps/desktop/src/stores/settings.ts`（Pinia）：`provider/model/baseUrl/apiKey`，`saveKey()` 调 stronghold 命令，`loadKeys()` 启动时恢复。
- `apps/desktop/src/services/ai.ts`：
  - `triggerSuggestion()` —— 取 active tab 光标前文本 → 构造 prompt（内置默认模板：续写光标处）→ `invoke('ai_complete', { config, prompt })` → 订阅 `ai-chunk`/`ai-done` → 给 editor-core `setSuggestion(text)`。
  - `acceptSuggestion()` / `rejectSuggestion()`。
  - `cancel()` —— `invoke('ai_cancel', { id })`。
- `apps/desktop/src/components/GhostWriter.vue`：全局 `keydown` 监听 `Tab`（无建议时插入普通 Tab？——Tab 语义：编辑器内默认 Tab 是焦点移动；v1.4 用 Tab 触发/Accept，需在 EditorPane 层拦截 `event.preventDefault()`，Esc 拒绝）。挂载于应用根。
- editor-core：
  - `setSuggestion(text: string | null): void`、`acceptSuggestion(): void`、`rejectSuggestion(): void` —— 通过 ProseMirror Plugin/Decoration 在光标处插入 ghost text（`Widget` 或 `InlineDecoration`），accept 时把该文本插入 doc，reject 时清除。**关键**：ghost text 是 decoration，不进 `state.doc` → 保存/往返不受影响。
  - `onSuggestionChange(cb)`（接受/拒绝后通知，供 AI 服务复位）。

### 3.4 设置面板

`SettingsPanel.vue` 增「AI」区：供应商下拉 + model 输入 + base_url（local/custom 显示）+ API key 输入（password type）+「保存」（调 stronghold）+ 测试连接按钮（可选，v1.4 用「触发一次补全」隐式测试）。

## 4. 实现范围（v1.4）

1. Rust：`ai.rs`（供应商映射 + SSE + 事件流 + 取消）、stronghold 键存储、注册命令。
2. editor-core：建议 decoration 接口（set/accept/reject + 事件）。
3. 前端：settings store（provider/model/key）、ai.ts（触发/流消费/取消）、GhostWriter.vue（Tab/Esc）。
4. SettingsPanel AI 区。
5. 依赖：`reqwest`（rust）、`serde_json`、`tauri-plugin-stronghold`；无前端新依赖。

## 5. 范围红线（v1.4 不做）

- 不做多轮对话 / 长期记忆 / RAG。
- 不做建议选择列表（多候选 UI）。
- 不做 prompt 模板编辑器（内置默认 prompt）。
- 不做用量计费/额度管理。
- 不做代理设置 / 自定义 TLS 异常处理（custom endpoint 直连，遇证书问题报错明示）。

## 6. 测试策略

- **Rust 单测**：prompt 构造、各供应商 endpoint 映射、SSE 行解析（用 mock 响应体字符串测解析函数）、错误处理。真实网络请求不写单测（CI 无网），留手动冒烟。
- **editor-core 单测**：setSuggestion 在 doc 上产生 decoration（不修改 doc.textContent）；acceptSuggestion 插入文本 → doc 长度增加；rejectSuggestion 无痕。
- **desktop 单测**：settings store 字段/save/load；ai.ts 的 prompt 构造 + 事件订阅/取消逻辑（mock invoke + listen）。
- **E2E/手动**：配置本地 Ollama → Tab 触发 → 流式显示 → Tab 接受 → 文档出现文本；Esc 拒绝 → 无痕；保存/重开往返无 ghost 残留。

## 7. 依赖

- Rust：`reqwest`（features json, stream, rustls-tls）、`serde_json`、`tauri-plugin-stronghold`、`tokio` 已有、`futures-util`。
- 前端：无新依赖。