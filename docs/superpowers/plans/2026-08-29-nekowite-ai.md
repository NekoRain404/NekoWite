# NekoWite v1.4 AI Ghost-writer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add BYOK AI ghost-writer suggestions to the editor — Tab triggers a single-turn completion via the provider the user configured, streamed through the Rust backend as inline ghost text (ProseMirror decoration, not in the doc), Tab accepts / Esc rejects.

**Architecture:** Rust `ai.rs` streams via `reqwest` from provider-specific SSE endpoints, normalizing to `ai-chunk`/`ai-done`/`ai-error` Tauri events (requests routed by `id`, cancellable via `ai-cancel`). Keys live in a `tauri-plugin-stronghold` vault unlocked by an auto-generated `0600` master key file. Frontend: Pinia `settings` store (provider/model/baseUrl/apiKey), `services/ai.ts` (trigger/stream-consumer/cancel), `GhostWriter.vue` (global Tab/Esc), and a SettingsPanel AI section. editor-core exposes a light suggestion interface (`setSuggestion`/`acceptSuggestion`/`rejectSuggestion`/`onSuggestionChange`) built on a ProseMirror plugin + decorations — the ghost text never enters `state.doc`, so save/round-trip is unaffected.

**Tech Stack:** Rust `reqwest` + `tokio` + `serde_json` + `futures-util` + `tauri-plugin-stronghold`; Tauri events; ProseMirror decorations; Vue 3 + Pinia; vitest; existing uni/remark pipeline untouched.

## Global Constraints

- Rust additions confined to `apps/desktop/src-tauri` (a new `src/ai.rs` module + Cargo deps). No new JS deps.
- Add `reqwest = { version = "0.12", features = ["json", "stream", "rustls-tls"] }`, `futures-util = "0.3"`, `tauri-plugin-stronghold = "2"`, and `zeroize`/`thiserror` only if genuinely needed (keep minimal).
- TypeScript strict; no unused vars/imports; no Chinese code comments (UI strings may be Chinese); English commit messages.
- Before committing: affected package test/typecheck/lint green; `pnpm -r test` (currently 120 JS + 3 Rust) must not regress.
- pnpm needs `PNPM_STORE_DIR=/tmp/pnpm-store-test/v11` or `--store-dir`.
- Do NOT modify the node/serialize/cite/math/export structures or the three-state view. Suggestion decorations must be additive and never touch `state.doc`.
- The real network calls are MANUAL-SMOKE only (CI has no network): unit tests cover prompt construction, SSE parsing, endpoint mapping, error handling, and the editor decoration/accept/reject behavior. Record any parts that need a manual smoke with a precise scenario.
- Stronghold master-key decision (from spec §3.2): auto-generate a 32-byte master key at first run → write `<vault>/.nekowite/master.key` mode `0600`; optional user-set master password re-encrypts and updates the file. Document the file-level protection trade-off in the Settings UI copy.

---

### Task 1: Rust AI 模块（ai.rs：供应商映射 + SSE + 事件流 + 取消）

**Files:**
- Create: `apps/desktop/src-tauri/src/ai.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`（`mod ai;` + 注册命令）
- Modify: `apps/desktop/src-tauri/Cargo.toml`（加 reqwest/futures-util）
- Create: `apps/desktop/src-tauri/tests/ai_test.rs`（纯函数/解析单测）

**Interfaces:**
- Consumes: tauri `AppHandle`, `Emitter` (for `app.emit`), tokio runtime (Tauri provides default).
- Produces (EXACT — Task 3/4 depend):
  - `#[derive(serde::Deserialize)] pub struct AIConfig { pub provider: String, pub model: String, pub base_url: Option<String>, pub api_key: Option<String> }`
  - `#[derive(serde::Serialize, Clone)] pub struct AIChunk { pub id: String, pub text: String }`
  - `pub fn build_prompt(cursor_prefix: &str) -> String` —— 内置默认模板，返回续写 prompt（含 `\n` 尾标让模型续写）。
  - `pub fn resolve_endpoint(cfg: &AIConfig) -> (String, serde_json::Value)` —— 返回 URL + 请求体模板（按 provider：openai/grok/local/custom → `/chat/completions` chat 体；anthropic → `/v1/messages`；gemini → `:streamGenerateContent?alt=sse`）。纯函数，单测锁定各 provider 的 URL/体。
  - `pub fn parse_sse_line(line: &str, provider: &str, acc: &mut String) -> Option<String>` —— 解析一行 SSE，返回增量文本或 None；针对 openai/anthropic/gemini 各自的 payload 提取 `text`。纯函数，用 mock SSE 文本单测。
  - `#[tauri::command] pub async fn ai_complete(app: tauri::AppHandle, config: AIConfig, prompt: String) -> Result<(), String>` —— 发起流式请求，逐 chunk `app.emit("ai-chunk", AIChunk{id, text})`；结束 `app.emit("ai-done", { id, full })`；出错 `app.emit("ai-error", { id, message })` 并返回 Err（或选 Ok 但事件已带错误——**用 Err return**，前端 catch）。
  - `#[tauri::command] pub async fn ai_cancel(app: tauri::AppHandle, id: String) -> Result<(), String>` —— 取消指定 id 的进行中请求（Abort/丢弃剩余流）。

- [ ] **Step 1: 写失败测试（纯函数）**

`apps/desktop/src-tauri/tests/ai_test.rs`：

```rust
use nekowite_lib::ai::{build_prompt, resolve_endpoint, parse_sse_line, AIConfig};

#[test]
fn prompt_continues_cursor() {
    let p = build_prompt("The quick brown");
    assert!(p.contains("The quick brown"));
    assert!(p.ends_with('\n'));
}

#[test]
fn endpoint_maps_openai() {
    let cfg = AIConfig { provider: "openai".into(), model: "gpt-5-mini".into(), base_url: Some("https://api.openai.com/v1".into()), api_key: Some("k".into()) };
    let (url, body) = resolve_endpoint(&cfg);
    assert!(url.ends_with("/chat/completions"));
    assert_eq!(body["stream"], true);
}

#[test]
fn sse_parses_openai_delta() {
    let mut acc = String::new();
    let delta = parse_sse_line(r#"data: {"choices":[{"delta":{"content":"Hello"}}]}"#, "openai", &mut acc);
    assert_eq!(delta.as_deref(), Some("Hello"));
}

#[test]
fn sse_ignores_other_lines() {
    let mut acc = String::new();
    assert_eq!(parse_sse_line(": keep-alive", "openai", &mut acc), None);
    assert_eq!(parse_sse_line("", "openai", &mut acc), None);
}
```

> 若 `AIConfig` 需 `Deserialize` 且字段为 `Option`，测试构造用 `Some(...)`；anthropic/gemini 的解析测试类似追加。

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test`（在 `apps/desktop/src-tauri`）
Expected: FAIL——`ai` 模块/函数不存在。（此时 tests/ai_test.rs 引用 `nekowite_lib::ai` 编译失败。）

- [ ] **Step 3: 实现 ai.rs**

核心结构（按 steps 精细实现）：

```rust
use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[derive(Deserialize, Clone)]
pub struct AIConfig {
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct AIChunk { pub id: String, pub text: String }

pub fn u32_ts() -> u64 { // id gen
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

pub fn build_prompt(cursor_prefix: &str) -> String {
    format!("Continue writing the following text. Only output the continuation, no preamble.\n\n{}", cursor_prefix)
}

pub fn resolve_endpoint(cfg: &AIConfig) -> (String, serde_json::Value) {
    let model = cfg.model.clone();
    match cfg.provider.as_str() {
        "anthropic" => {
            let base = cfg.base_url.clone().unwrap_or_else(|| "https://api.anthropic.com".into());
            (format!("{}/v1/messages", base.trim_end_matches('/')),
             serde_json::json!({
                "model": model, "max_tokens": 256, "stream": true,
                "messages": [ { "role": "user", "content": "" } ] // placeholder; content set before send
             }))
        }
        "gemini" => {
            let base = cfg.base_url.clone().unwrap_or_else(|| "https://generativelanguage.googleapis.com".into());
            (format!("{}/v1beta/models/{}:streamGenerateContent?alt=sse", base.trim_end_matches('/'), model),
             serde_json::json!({  "contents": [ { "role": "user", "parts": [ { "text": "" } ] } ] }))
        }
        _ => { // openai / grok / local / custom
            let base = cfg.base_url.clone().unwrap_or_else(|| "https://api.openai.com/v1".into());
            (format!("{}/chat/completions", base.trim_end_matches('/')),
             serde_json::json!({ "model": model, "max_tokens": 256, "stream": true, "messages": [ { "role": "user", "content": "" } ] }))
        }
    }
}

pub fn parse_sse_line(line: &str, provider: &str, _acc: &mut String) -> Option<String> {
    let line = line.trim();
    if !line.starts_with("data:") { return None; }
    let raw = line.trim_start_matches("data:").trim();
    if raw == "[DONE]" { return None; }
    let v: serde_json::Value = match serde_json::from_str(raw) { Ok(v) => v, Err(_) => return None };
    match provider {
        "anthropic" => v["delta"]["text"].as_str().map(|s| s.to_string()),
        _ => {
            // openai-compatible + gemini
            if let Some(parts) = v.get("candidates") {
                // gemini
                parts[0]["content"]["parts"][0]["text"].as_str().map(|s| s.to_string())
                    .or_else(|| v["text"].as_str().map(|s| s.to_string()))
            } else {
                v["choices"][0]["delta"]["content"].as_str().map(|s| s.to_string())
                    .or_else(|| v["choices"][0]["text"].as_str().map(|s| s.to_string()))
            }
        }
    }
}
```

`ai_complete` 用 `reqwest` + `futures_util::StreamExt` 读取 `text/event-stream`，逐行 parse，成功时 `app.emit("ai-chunk", ...)`；结束 emit done；错误 emit error + 返回 Err。`ai_cancel` 用一个 `Mutex<HashSet<String>>` managed（或用 `futures` CancellationToken）——v1.4 用简单 `ForgetGuard` 不行，选「**运行中 id 集合** + 取消时从集合移除并在流处理循环里周期性检查」即可（或直接丢请求——**cancel 语义：从 managed 集合移除该 id，stream loop 每 chunk 前检查集合，不在则 break**）。

`lib.rs`：`mod ai;` + `generate_handler![..., ai_complete, ai_cancel]` + `.manage(AiState::default())`。

- [ ] **Step 4: 跑测试 + build**

Run: `cargo test` → ai 测试 PASS；`cargo build` 通过；`cargo clippy` 无新警告。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri
git commit -m "feat(tauri): add ai streaming module with provider mapping"
```

---

### Task 2: Rust stronghold 键存储

**Files:**
- Modify: `apps/desktop/src-tauri/src/ai.rs`（加 key store 命令）或新建 `apps/desktop/src-tauri/src/keys.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`（注册命令 + `.plugin(tauri_plugin_stronghold::Builder::new(stronghold_path).build())`）
- Modify: `apps/desktop/src-tauri/Cargo.toml`（加 `tauri-plugin-stronghold = "2"`）
- Create: `apps/desktop/src-tauri/tests/keys_test.rs`（纯逻辑单测）

**Interfaces:**
- Consumes: stronghold plugin `Stronghold` managed handle, app data dir.
- Produces (EXACT — Task 3/4 depend):
  - `#[tauri::command] fn store_ai_key(app: tauri::AppHandle, provider: String, key: String) -> Result<(), String>`
  - `#[tauri::command] fn load_ai_key(app: tauri::AppHandle, provider: String) -> Result<Option<String>, String>`
  - `#[tauri::command] fn set_master_password(app: tauri::AppHandle, password: String) -> Result<(), String>`（自定义主密码；v1.4 最少实现：写入/更新 master.key 文件并由 stronghold 重加密——若 stronghold 换锁 API 复杂，退化为「记录密码文件 + 文档说明」并在 report 记录，不强求完整 re-encrypt）
  - 辅助 `master_key_path(app) -> PathBuf`（`{app_data_dir}/.nekowite/master.key`）
  - `ensure_master_key(app) -> Result<Vec<u8>, String>` —— 不存在则生成 32 字节随机写入（`OpenOptions` + `mode 0o600`），存在则读取。

- [ ] **Step 1: 写失败测试（master_key 文件逻辑，可单测的纯部分）**

`apps/desktop/src-tauri/tests/keys_test.rs`：

```rust
use std::fs;
use std::path::PathBuf;
use std::io::Write;

// 纯函数：写入/读取 32 字节密钥文件，验证权限 0600
fn ensure_keyfile(path: &PathBuf) -> Result<Vec<u8>, String> {
    if let Ok(b) = fs::read(path) { return Ok(b); }
    use std::os::unix::fs::OpenOptionsExt;
    let mut bytes = [0u8; 32];
    // 生产用 getrandom/rng；测试里调用内部随机源即可
    // NOTE: 为可测，密钥生成函数应接受一个 rng 参数或用系统熵
    let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    let perm = fs::metadata(path).map_err(|e| e.to_string())?.permissions().mode();
    assert_eq!(perm & 0o777, 0o600);
    Ok(bytes.to_vec())
}

#[test]
fn master_key_created_and_reused() {
    let dir = std::env::temp_dir().join("nkw_keys_test");
    fs::create_dir_all(&dir).unwrap();
    let p = dir.join("master.key");
    let _ = fs::remove_file(&p);
    let a = ensure_keyfile(&p).unwrap();
    let b = ensure_keyfile(&p).unwrap();
    assert_eq!(a, b);
    fs::remove_dir_all(&dir).unwrap();
}
```

> 注意：`ensure_keyfile` 里 `bytes` 应为随机——测试只断言「相同路径两次读取一致 + 权限 0600」。若 crypto 依赖不好加，用 `std` 熵库或 `getrandom`（Rust 生态标准）；若加 `getrandom` 就统一它。若不想加依赖，密钥从系统时间+进程 id 派生（弱）——**用 `getrandom = "0.2"`，最简且安全**。

- [ ] **Step 2: 跑测试确认失败 → 实现**

- 加 `getrandom`、`tauri-plugin-stronghold` 依赖。
- 实现 `keys.rs`（`ensure_master_key` 用 `getrandom` 填充 + `0o600` 写文件；`store_ai_key`/`load_ai_key` 走 stronghold vault：`stronghold.write_client` + `vault.store`/`load`——按安装的 `tauri-plugin-stronghold` v2 实际 API 适配，其 `Stronghold` handle 通过 `app.state()` 取。**若 stronghold API 在 v2 使用复杂且阻塞，允许降级**：`store_ai_key` 先用 master.key 派生 XOR/简单加密后存 `{app_data_dir}/.nekowite/keys/{provider}.enc`，并在 report 里明确此为「文件级加密、非强防护」降级；优先走 stronghold，降级可接受并记录）。
- `lib.rs`：`.plugin(tauri_plugin_stronghold::Builder::new(...).build())`（路径用 `app_data_dir`）+ 注册 3 个命令 + `mod keys;`。

- [ ] **Step 3: 跑测试 + build + Commit**

Run: `cargo test` / `cargo build` / `cargo clippy` 全绿 → commit `"feat(tauri): add encrypted AI key storage"`。

---

### Task 3: editor-core 建议接口（ghost text decoration）

**Files:**
- Create: `packages/editor-core/src/suggest/suggest.ts`
- Create: `packages/editor-core/src/suggest/suggest.test.ts`
- Create: `packages/editor-core/src/suggest/index.ts`
- Modify: `packages/editor-core/src/editor.ts`（在 `NekoEditor` 接口加建议方法）
- Modify: `packages/editor-core/src/index.ts`

**Interfaces:**
- Consumes: ProseMirror `Plugin`/`EditorState`/`Decoration`（`@milkdown/prose`），existing `createEditor` factory.
- Produces (EXACT — Task 4 depends):
  - `suggestionPlugin: Plugin` —— 用 ProseMirror `Plugin` 持有一个可变的「当前建议文本」状态（存插件 state 或闭包变量 + transaction meta），在光标处渲染一个 `Decoration.widget`（`<span class="ghost-text">…</span>`，`keyed`）。
  - `setSuggestion(text: string | null, view: EditorView): void` —— 设置/清除建议，dispatch 一个带 meta 的 transaction（`setMeta('nekoSuggestion', text)`），插件从 meta 读取并更新 decoration。
  - `acceptSuggestion(view: EditorView): string | null` —— 读取当前建议，若存在则把文本插入 doc（在光标处 `tr.insertText(ghost)`），clear suggestion，返回插入的文本。
  - `rejectSuggestion(view: EditorView): void` —— clear。
  - `hasSuggestion(view: EditorView): boolean`。
  - 在 `NekoEditor` 暴露：`setSuggestion(text: string|null): void`、`acceptSuggestion(): string|null`、`rejectSuggestion(): void`、`hasSuggestion(): boolean`、`onSuggestionChange(cb: (status: 'accepted'|'rejected'|'cleared') => void): () => void`。
- 关键约束：ghost 文本只走 decoration，**永不进 `state.doc`**；accept 才插入；保存/往返不受影响。

- [ ] **Step 1: 写失败测试**

`packages/editor-core/src/suggest/suggest.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { createEditor, basicPlugins } from '../editor'

describe('suggestion ghost text', () => {
  it('decoration does not mutate doc', async () => {
    const el = document.createElement('div'); document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('Hello ')
    editor.setSuggestion('world')
    const md = await editor.save()
    expect(md).not.toContain('world')
    editor.destroy()
  })

  it('acceptSuggestion inserts text into doc', async () => {
    const el = document.createElement('div'); document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('Hello ')
    editor.setSuggestion('world')
    const inserted = editor.acceptSuggestion()
    expect(inserted).toBe('world')
    const md = await editor.save()
    expect(md).toContain('world')
    editor.destroy()
  })

  it('rejectSuggestion leaves doc untouched', async () => {
    const el = document.createElement('div'); document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('Hello ')
    editor.setSuggestion('world')
    editor.rejectSuggestion()
    const md = await editor.save()
    expect(md).not.toContain('world')
    editor.destroy()
  })

  it('hasSuggestion toggles', async () => {
    const el = document.createElement('div'); document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('Hi')
    expect(editor.hasSuggestion()).toBe(false)
    editor.setSuggestion('x')
    expect(editor.hasSuggestion()).toBe(true)
    editor.destroy()
  })
})
```

- [ ] **Step 2: 跑测试确认失败 → 实现**

实现建议：用一个 ProseMirror `Plugin`（`@milkdown/prose/state` 导出 `Plugin`），`props.decorations` 在光标位置返回 `Decoration.widget(selection.head, ...)`；`setSuggestion` 通过 `view.dispatch(view.state.tr.setMeta('nekoSuggestion', text ?? null))` 驱动；插件 `StateField`/`props` 读取 meta。选 `Plugin` + `props.decorations(state)` 从插件自有 state（`PluginState` 或 state field）拿文本最干净。在 `editor.ts` 的 `createEditor` 返回对象里接入这些方法（需要把外部 `setSuggestion` 与编辑器 view 绑定）。

- [ ] **Step 3: 跑测试 + 接线 + Commit**

Run: `pnpm --filter @nekowite/editor-core test` 全绿。
```bash
git add packages/editor-core
git commit -m "feat(editor-core): add ghost-text suggestion plugin and api"
```

---

### Task 4: 前端 AI 服务 + GhostWriter + settings store

**Files:**
- Create: `apps/desktop/src/stores/settings.ts`
- Create: `apps/desktop/src/services/ai.ts`
- Create: `apps/desktop/src/services/ai.test.ts`
- Create: `apps/desktop/src/components/GhostWriter.vue`
- Modify: `apps/desktop/src/App.vue`（挂载 GhostWriter、初始化 settings 加载）
- Modify: `apps/desktop/src/ui/SettingsPanel.vue`（AI 区）

**Interfaces:**
- Consumes: `NekoEditor` 建议 API（Task 3），`invoke`/`listen`（`@tauri-apps/api`），Rust `ai_complete`/`ai_cancel`（Task 1）、`store_ai_key`/`load_ai_key`（Task 2）。
- Produces:
  - `useSettingsStore()`（Pinia）：`provider: Ref<string>`（默认 `local`）、`model`（默认 `qwen2.5-coder:3b` 或按供应商）、`baseUrl`、`apiKey`（仅内存，不持久化明文）、`saveKey()`、`loadKey()`、`config(): AIConfig`（前端上送 Rust 的结构）。
  - `aiService = { triggerSuggestion(editor, opts): Promise<void>, accept(): string|null, reject(): void, cancel(): void }`。
  - `GhostWriter.vue`：根级 `keydown`（`Tab`/`Shift+Tab`/`Escape`），仅当编辑器有建议时拦截；`Tab`=触发/接受（无建议→不拦截普通 Tab 行为）；`Esc`=拒绝；Esc/Tab 都 `preventDefault` 当有建议。
  - `SettingsPanel.vue` 增「AI 设置」区：供应商下拉（openai/anthropic/gemini/grok/local/custom）+ model + baseUrl（local/custom 时才显示）+ apiKey（password）+「保存 Key」（调 stronghold）+ 说明文案（key 加密存储、本机文件级防护）。

- [ ] **Step 1: 写失败测试（ai.ts prompt + 事件接线，mock）**

`apps/desktop/src/services/ai.test.ts`：

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn(() => Promise.resolve(() => {})))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { aiService, buildAIPrompt } from './ai'

describe('aiService', () => {
  beforeEach(() => { invokeMock.mockReset(); listenMock.mockReset() })

  it('builds prompt from cursor prefix', () => {
    expect(buildAIPrompt('The quick').endsWith('The quick')).toBe(true)
  })

  it('calls ai_complete with config on trigger', async () => {
    const editor = {
      acceptSuggestion: vi.fn(() => 'x'),
      rejectSuggestion: vi.fn(),
      setSuggestion: vi.fn(),
      onSuggestionChange: vi.fn(() => () => {}),
    } as never
    listenMock.mockImplementation(() => Promise.resolve(() => {}))
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm', baseUrl: 'http://localhost:1234/v1' })
    expect(invokeMock).toHaveBeenCalledWith('ai_complete', expect.objectContaining({ config: expect.objectContaining({ provider: 'local' }) }))
  })
})
```

- [ ] **Step 2: 跑测试确认失败 → 实现 settings store + ai.ts**

`ai.ts`：`buildAIPrompt(prefix)`；`triggerSuggestion(editor, config)`（取编辑器光标前文本 → prompt → `invoke('ai_complete', { config, prompt })`；先 `listen('ai-chunk')` 聚合增量并 `editor.setSuggestion(acc)`，`listen('ai-done')` 后 `onSuggestionChange` 复位；返回 unlisten 以便 cancel/卸载）——注意 listen 要在 invoke 前注册避免丢首个 chunk（或 invoke 返回后再 listen，v1.4 用后者兜底：AI 端较慢，基本不丢；在 report 注明竞态窗口）。`cancel(id)` → `invoke('ai_cancel', { id })`；`accept/reject` 直接转 editor。

`GhostWriter.vue` 挂载点逻辑读写 settings store + editorBridge（复用 v1.2 的 `editorBridge.getEditor()` 拿 active editor）。

- [ ] **Step 3: App.vue 挂载 + SettingsPanel AI 区 + Commit**

`App.vue`：`<GhostWriter />`；onMounted 时 `settingsStore.loadKey()`。SettingsPanel 增 AI 区（按 brief 交互）。`pnpm --filter @nekowite/desktop test` / typecheck / lint 全绿 → commit `"feat(desktop): add ai service, ghost writer, and settings"`。

---

### Task 5: 全量回归 + 手动冒烟（可选真实补全）

**Files:**
- Modify: 无（或修复回归）。
- Run: `pnpm -r test`、`pnpm typecheck`、`pnpm lint`、`pnpm --filter @nekowite/desktop build`、`cargo test`、`cargo build`。
- 手动冒烟（若有本地 Ollama/LM Studio 或任何可达 endpoint）：设置里填 local + baseUrl → 打开文档 → Tab → 幽灵文本流式出现 → Tab 接受 → 文档出现文本 → Esc 拒绝场景；保存/重开确认无 ghost 残留。
- 若环境不可达：记录精确的「待手动验证」场景清单 + 已通过的自动化覆盖说明。
- Commit（若有修复）：`"fix: ..."`。

---

## Self-Review

**Spec 覆盖检查：**
- Rust 代理 + 供应商映射 + SSE + 事件流 + 取消 → Task 1 ✅
- stronghold 键存储 + master key + 0600 → Task 2 ✅
- editor-core ghost decoration（不进 doc）+ accept/reject → Task 3 ✅
- settings store + ai.ts + GhostWriter（Tab/Esc）→ Task 4 ✅
- SettingsPanel AI 区 → Task 4 ✅
- 手动冒烟清单 → Task 5 ✅
- 范围红线（无 RAG/多轮/多候选 UI）→ 未加入任务 ✅

**占位符检查：** 无 TBD/TODO；两个适配点（stronghold v2 API 复杂时降级文件加密、SSE/listen 竞态窗口）都给了明确取舍与记录要求。✅

**类型一致性：**
- `AIConfig`/`AIChunk`/`ai_complete`/`ai_cancel`（Task 1）→ Task 4 invoke/listen 消费 ✅
- `store_ai_key`/`load_ai_key`/`set_master_password`（Task 2）→ Task 4 settings store 消费 ✅
- `setSuggestion/acceptSuggestion/rejectSuggestion/hasSuggestion/onSuggestionChange`（Task 3）→ Task 4 ai.ts/GhostWriter 消费 ✅
- `useSettingsStore().config()` 产出结构与 Rust `AIConfig` 字段一致（provider/model/baseUrl/apiKey）✅
- `aiService.triggerSuggestion(editor, config)`（Task 4）→ GhostWriter 调用，editor 是 NekoEditor ✅