# NekoWite 开发整理与修复文档

> 本文是当前开发基线。范围排除右键菜单和对照模式滚动优化；`NekoWite_win` 永不参与扫描、重构或发布。

## 1. 开发原则

- 目标平台为 Linux，发布格式为 AppImage、deb、rpm。
- 保留现有浅色/深色主题和 accent 色，不在本轮改动视觉主题。
- 先修安全和数据一致性，再做目录重构，最后处理命名与体验细节。
- 每个行为变更先写回归测试，再改实现。
- 每次只迁移一个功能域，保持提交可回滚。
- 不覆盖用户已有未提交修改；重构前必须检查 `git status`。
- 注释只解释复杂原因、约束和事务边界，不写重复代码含义的注释。

## 2. 当前高风险问题

### P0：Vault 授权绕过

`register_vault` 不能仅信任 renderer 传入的绝对路径。必须要求路径来自原生目录选择器或已验证的用户手势，并确认目标是目录。注册成功后只允许当前 vault，切换 vault 时撤销旧 scope。补充 IPC 集成测试，验证不能注册 `/`、`/etc` 或任意父目录。

### P0：资源协议越权

- 切换到嵌套 vault 时撤销父 vault 的 scope。
- `asset://` 只允许媒体文件和当前笔记所需附件，不得允许整个 vault。
- 明确拒绝 `.env`、普通笔记、配置文件和元数据目录。
- 为父 vault、嵌套 vault、跨目录附件增加测试。

### P1：恢复和密钥一致性

- 重新加密前不得无条件删除已有 `master.key.old`。
- 失败打开或错误密码不能创建伪造的 `master.key.old`。
- snapshot/key 已提交后权限收紧失败时，返回状态必须与磁盘事实一致。
- 为崩溃恢复、重复重试和权限失败增加故障注入测试。

### P1：文件和元数据一致性

- 目录重命名必须迁移 history/trash 元数据。
- 附件命名检查和写入必须在同一锁或原子创建操作内完成。
- `rename_entry` 与写入使用同一进程锁，避免旧路径重建。
- trash restore 使用“不覆盖”原子语义，禁止覆盖并发新建文件。

### P1：AI 输入输出限制

- 限制 prompt、图片数量、单张图片大小和总请求体大小。
- 限制 SSE 缓冲区、模型列表响应和最终回答长度。
- 超限时返回明确错误，不允许无限 `push_str` 或 `response.text()`。
- 限制应位于 Rust IPC/HTTP 边界，不能只依赖前端校验。

### P1：网络安全

公共 HTTP Base URL 必须拒绝，只有 localhost 开发地址可以使用 HTTP；非本地地址强制 HTTPS。API key 不得发送到明文公共 endpoint。增加 URL 策略单元测试。

## 3. 目标目录结构

```text
apps/desktop/src/
├─ app/
│  ├─ App.vue
│  ├─ bootstrap.ts
│  ├─ lifecycle.ts
│  └─ providers.ts
├─ components/
│  ├─ ContextMenu.vue
│  ├─ Modal.vue
│  ├─ ConfirmDialog.vue
│  ├─ ToastHost.vue
│  ├─ IconButton.vue
│  └─ LoadingState.vue
├─ features/
│  ├─ notes/
│  │  ├─ components/
│  │  │  ├─ NoteCard.vue
│  │  │  ├─ NoteListPanel.vue
│  │  │  ├─ NoteListToolbar.vue
│  │  │  ├─ NoteSearch.vue
│  │  │  └─ NoteContextMenu.vue
│  │  ├─ composables/
│  │  │  ├─ useNoteActions.ts
│  │  │  └─ useNoteList.ts
│  │  ├─ services/
│  │  │  ├─ note-actions.ts
│  │  │  ├─ note-content-reader.ts
│  │  │  └─ note-list-query.ts
│  │  ├─ types.ts
│  │  └─ index.ts
│  ├─ editor/
│  │  ├─ components/
│  │  │  ├─ EditorPane.vue
│  │  │  ├─ SourcePane.vue
│  │  │  ├─ PreviewPane.vue
│  │  │  └─ SplitEditor.vue
│  │  ├─ composables/
│  │  │  ├─ useEditorSession.ts
│  │  │  ├─ useEditorSelection.ts
│  │  │  └─ useEditorShortcuts.ts
│  │  ├─ services/
│  │  │  ├─ editor-bridge.ts
│  │  │  ├─ editor-ownership.ts
│  │  │  ├─ editor-persistence.ts
│  │  │  ├─ editor-recovery.ts
│  │  │  └─ split-scroll-coordinator.ts
│  │  ├─ model/
│  │  │  └─ document-session.ts
│  │  └─ index.ts
│  ├─ vault/
│  │  ├─ components/
│  │  │  ├─ FileTree.vue
│  │  │  ├─ FileTreeRow.vue
│  │  │  ├─ FileTreeContextMenu.vue
│  │  │  └─ FolderPicker.vue
│  │  ├─ composables/
│  │  │  ├─ useVaultSession.ts
│  │  │  └─ useFileTree.ts
│  │  ├─ services/
│  │  │  ├─ vault-index.ts
│  │  │  ├─ vault-file-actions.ts
│  │  │  ├─ vault-rename.ts
│  │  │  └─ vault-delete.ts
│  │  └─ index.ts
│  ├─ export/
│  │  ├─ components/ExportDialog.vue
│  │  ├─ services/
│  │  │  ├─ export-html.ts
│  │  │  ├─ export-pdf.ts
│  │  │  ├─ export-renderers.ts
│  │  │  └─ export-name.ts
│  │  └─ index.ts
│  ├─ attachments/
│  │  ├─ components/
│  │  │  ├─ AttachmentsPanel.vue
│  │  │  └─ ImagePanel.vue
│  │  ├─ services/
│  │  │  ├─ attachment-library.ts
│  │  │  ├─ attachment-paths.ts
│  │  │  └─ attachment-import.ts
│  │  └─ index.ts
│  ├─ graph/
│  │  ├─ components/GraphPanel.vue
│  │  ├─ services/
│  │  │  ├─ graph-layout.ts
│  │  │  └─ link-graph.ts
│  │  └─ index.ts
│  ├─ references/
│  │  ├─ components/
│  │  │  ├─ ReferencesPanel.vue
│  │  │  └─ FrontmatterPanel.vue
│  │  ├─ services/reference-library.ts
│  │  └─ index.ts
│  ├─ chat/
│  │  ├─ components/ChatPanel.vue
│  │  ├─ services/
│  │  │  ├─ chat-session.ts
│  │  │  └─ chat-context.ts
│  │  └─ index.ts
│  ├─ settings/
│  │  ├─ components/
│  │  │  ├─ SettingsPanel.vue
│  │  │  ├─ GeneralSettings.vue
│  │  │  ├─ AppearanceSettings.vue
│  │  │  ├─ EditorSettings.vue
│  │  │  ├─ ExportSettings.vue
│  │  │  ├─ AiSettings.vue
│  │  │  └─ PluginSettings.vue
│  │  └─ index.ts
│  └─ plugins/
│     ├─ components/
│     ├─ services/
│     │  ├─ discovery.ts
│     │  ├─ permissions.ts
│     │  ├─ governance.ts
│     │  ├─ integrity.ts
│     │  ├─ trust-policy.ts
│     │  └─ audit-log.ts
│     └─ index.ts
├─ stores/
│  ├─ document-list.ts
│  ├─ tabs.ts
│  ├─ vault-session.ts
│  ├─ file-tree.ts
│  ├─ appearance.ts
│  ├─ settings.ts
│  ├─ references.ts
│  ├─ chat-session.ts
│  └─ view.ts
├─ services/
│  ├─ paths/
│  │  ├─ path-normalize.ts
│  │  ├─ path-policy.ts
│  │  └─ path-display.ts
│  ├─ search/
│  │  ├─ content-search.ts
│  │  ├─ search-index.ts
│  │  └─ search-query.ts
│  ├─ markdown/
│  │  ├─ note-meta.ts
│  │  ├─ outline.ts
│  │  └─ tags.ts
│  ├─ errors/
│  │  ├─ app-errors.ts
│  │  └─ error-messages.ts
│  └─ runtime/
│     ├─ timing.ts
│     ├─ announcer.ts
│     └─ modal-stack.ts
├─ platform/
│  ├─ gateways/
│  │  ├─ fs.ts
│  │  ├─ contracts.ts
│  │  ├─ tauri.ts
│  │  └─ memory.ts
│  ├─ events/
│  ├─ persistence/
│  └─ runtime/
├─ i18n/
├─ styles/
├─ templates/
└─ view/
   ├─ RenderSearchPanel.vue
   └─ render-view.ts
```

Rust 目标结构：

```text
apps/desktop/src-tauri/src/
├─ main.rs
├─ lib.rs
├─ commands/
│  ├─ fs.rs
│  ├─ keys.rs
│  ├─ ai.rs
│  ├─ export.rs
│  ├─ plugins.rs
│  └─ mod.rs
├─ domain/
│  ├─ vault.rs
│  ├─ path_policy.rs
│  ├─ recovery.rs
│  ├─ attachment.rs
│  ├─ note.rs
│  └─ mod.rs
├─ storage/
│  ├─ file_store.rs
│  ├─ attachment_store.rs
│  ├─ metadata_store.rs
│  ├─ history_store.rs
│  ├─ trash_store.rs
│  ├─ key_store.rs
│  ├─ index_store.rs
│  ├─ atomic_write.rs
│  └─ mod.rs
├─ providers/
│  ├─ ai/
│  │  ├─ client.rs
│  │  ├─ request.rs
│  │  ├─ response.rs
│  │  ├─ sse.rs
│  │  ├─ limits.rs
│  │  └─ url_policy.rs
│  ├─ filesystem/
│  └─ mod.rs
├─ security/
│  ├─ vault_authorization.rs
│  ├─ asset_scope.rs
│  ├─ ipc_limits.rs
│  └─ mod.rs
├─ state/
│  ├─ app_state.rs
│  ├─ vault_registry.rs
│  └─ mod.rs
└─ error.rs
```

仓库级文档和测试：

```text
docs/
├─ user/
│  ├─ user-guide.md
│  ├─ a11y.md
│  └─ privacy.md
├─ development/
│  ├─ development-roadmap.md
│  ├─ dev.md
│  ├─ test-plan.md
│  └─ coding-standards.md
├─ architecture/
│  ├─ overview.md
│  ├─ frontend-structure.md
│  ├─ backend-structure.md
│  └─ data-flow.md
├─ security/
│  ├─ security.md
│  ├─ threat-model.md
│  └─ audit-findings.md
├─ operations/
│  ├─ releasing.md
│  ├─ recovery.md
│  └─ performance.md
├─ history/development-log.md
├─ assets/
├─ mdx-demo/
└─ superpowers/

apps/desktop/e2e/
├─ editor-input.spec.ts
├─ export.spec.ts
├─ vault-security.spec.ts
└─ recovery.spec.ts

apps/desktop/src-tauri/tests/
├─ fs_authorization_test.rs
├─ fs_scope_test.rs
├─ recovery_test.rs
├─ ai_limits_test.rs
└─ rename_metadata_test.rs
```

## 4. 大文件拆分任务

### 前端

- `SettingsPanel.vue` 拆为各设置分区组件；父组件只负责导航和布局。
- `FileTree.vue` 拆为 row、拖拽、重命名、文件操作模块。
- `NoteListPanel.vue` 拆为 toolbar、search、list、outline、links 模块。
- `tabs.ts` 拆为 tab 生命周期、持久化、恢复和文件操作。
- `plugins.ts` 拆为 discovery、permissions、governance、integrity、trust、audit。
- `services/attachments.ts` 拆为路径解析、导入、媒体读取和库查询。

### Rust

- `storage/file_store.rs` 拆为基础读写、附件、元数据、重命名、原子写入。
- `providers/ai/client.rs` 拆为请求、响应、SSE、URL 策略和限制。
- `commands/fs.rs` 只保留参数解析、授权调用和错误转换。

拆分规则：先提取纯函数和类型，再迁移调用方；每个新模块必须有明确公开接口；禁止用 `utils.ts` 或 `manager.rs` 作为临时垃圾桶。

## 5. 命名规范

```text
Vue 组件：PascalCase.vue
TypeScript：kebab-case.ts
Rust：snake_case.rs
Store：useXxxStore
类型：PascalCase
常量：UPPER_SNAKE_CASE
```

固定动词语义：

```text
open   打开或激活
load   从外部加载
read   读取原始内容
save   持久化
rename 重命名
delete 永久删除
remove 从内存集合移除
close  关闭标签或窗口
```

避免 `utils`、`helpers`、`common`、`misc`、`manager`、`data` 等无边界名称。`note` 表示用户笔记，`document` 表示编辑器或索引文档，`file` 表示磁盘文件，`tab` 表示打开会话。

## 6. 注释规范

必须注释的场景：

- 安全边界：为什么某路径被拒绝、scope 如何撤销。
- 事务流程：哪些步骤必须按顺序执行，失败如何回滚。
- 并发控制：锁保护什么，避免哪类 TOCTOU。
- 平台差异：Linux/Tauri 行为与浏览器行为不一致之处。
- 非直观兼容逻辑：旧数据迁移、历史格式兼容。

推荐格式：

```ts
// The write and rename share one lock because a concurrent save could
// recreate the old path after metadata has moved to the new path.
```

不要写：

```ts
// Set the value.
const value = nextValue
```

注释必须描述“为什么”，而不是逐行翻译“做了什么”。安全和恢复注释优先使用英文，避免关键术语因翻译歧义被误解。

## 7. 测试体系

```text
单元测试：与源码同目录
跨模块测试：apps/desktop/src-tauri/tests/
端到端测试：apps/desktop/e2e/
```

必须新增或补强：

- vault 授权和 IPC 路径测试；
- asset scope 和嵌套 vault 测试；
- 恢复崩溃和 key rotation 测试；
- rename/history/trash 一致性测试；
- 附件并发和 restore 不覆盖测试；
- AI 请求、SSE、响应大小限制测试；
- HTTPS/localhost URL 策略测试。

每项 bug 修复都要保留一个能复现原问题的回归测试。

## 8. 执行顺序

1. 建立本文档、架构说明和命名规则。
2. 修复 P0 Vault 授权和资源 scope。
3. 修复恢复、密钥和文件元数据一致性。
4. 增加 AI 限制及 HTTPS 策略。
5. 以 `features/notes` 为试点拆分前端目录。
6. 拆分 `FileTree`、`SettingsPanel` 和 `tabs`。
7. 拆分 Rust storage、AI provider 和 IPC commands。
8. 统一命名、迁移 import、删除兼容入口。
9. 整理测试、文档和构建产物目录。
10. 进行 Linux 全量验证和发布。

每一阶段都遵循：

```text
写失败测试 → 最小实现 → 定向测试 → 全量测试 → code review → 单独提交
```

## 9. Linux 验证和发布

```bash
npx --yes pnpm typecheck
npx --yes pnpm lint
npx --yes pnpm test
npx --yes pnpm build
```

Linux 发布只生成并验证 AppImage、deb、rpm。不要运行 Windows 打包脚本，不生成 `.exe`，不把 `NekoWite_win` 纳入构建输入。

完成标准：安全测试通过、类型检查和 lint 无错误、全量测试无失败、Linux 构建成功、关键流程完成手工验收，并在发布说明中记录已知风险。

## 10. 详细拆分方法

### 10.1 拆分前的硬性规则

1. 任何移动前先执行 `git status --short`，记录用户已有修改。
2. 先为当前行为补测试，再拆文件；不得以“重构”为理由改变行为。
3. 每次只处理一个功能域，建议单次变更不超过 8 个源码文件。
4. 新模块先通过参数注入依赖，禁止在领域服务内部隐式创建 Pinia store 或 Tauri API。
5. 原文件保留兼容导出一个阶段，所有调用方迁移后再删除兼容层。
6. 每个拆分提交必须能单独通过 `typecheck` 和相关测试。
7. 不得把 `target/`、`release/`、`test-results/`、`.worktrees/` 或 `NekoWite_win/` 纳入迁移。

### 10.2 模块所有权

| 模块 | 允许负责 | 禁止负责 |
|---|---|---|
| `components` | 展示、事件转发、通用交互 | 读取 vault、调用 store、业务决策 |
| `features/*/components` | 功能域布局和用户交互 | 直接实现底层原子写入 |
| `features/*/services` | 功能域流程、组合领域服务 | 依赖 Vue DOM |
| `services` | 纯函数、跨功能基础服务 | 依赖具体页面组件 |
| `stores` | 状态、缓存、公开动作 | 大段文件系统事务 |
| `platform` | Tauri、系统 API、网关 | 用户业务规则 |
| Rust `commands` | IPC 校验、授权、错误转换 | 文件迁移和恢复算法 |
| Rust `domain` | 规则、状态机、策略 | 直接读写磁盘 |
| Rust `storage` | 持久化、锁、原子操作 | IPC 参数解析 |

依赖只能向下：

```text
组件 → feature service → shared service/domain → platform adapter
store → feature service/shared service
commands → security/domain/storage
```

禁止反向依赖，例如 `platform` import `features`、`services` import `.vue`、Rust `storage` 调用 command。

### 10.3 前端拆分顺序

#### 阶段 A：`NoteListPanel.vue`

先提取无状态部分：

```text
NoteListPanel.vue
├─ NoteListToolbar.vue       搜索、排序、模式切换
├─ NoteSearch.vue             查询输入和内容搜索状态
├─ NoteListContent.vue        卡片列表和空状态
├─ OutlineList.vue            大纲列表
└─ LinkList.vue               入链和出链列表
```

父组件只保留 `panelMode`、活动路径和子组件组合。搜索、排序、内容索引状态迁移到 `useNoteList.ts`，不要把 store 引用复制到每个子组件。

#### 阶段 B：`FileTree.vue`

```text
FileTree.vue
├─ FileTreeRow.vue             单行渲染、键盘和拖拽事件
├─ FileTreeContextMenu.vue     菜单项和目标路径
├─ useFileTree.ts              展开、刷新、扁平化
├─ useFileTreeRename.ts        重命名输入、校验和提交
├─ useFileTreeDrag.ts          拖放解析和冲突状态
└─ vault-file-actions.ts       新建、删除、重命名流程
```

`FileTree.vue` 不再直接实现 `moveNote` 事务；它只调用 `vault-file-actions.ts`。所有成功和失败都通过返回结果或统一错误类型表达。

#### 阶段 C：`SettingsPanel.vue`

先保留原设置 store 不动，只拆模板和分区：

```text
SettingsPanel.vue
├─ SettingsNavigation.vue
├─ GeneralSettings.vue
├─ AppearanceSettings.vue
├─ EditorSettings.vue
├─ ExportSettings.vue
├─ AiSettings.vue
└─ PluginSettings.vue
```

分区组件通过 `v-model` 或明确事件读写设置，不允许自行读 localStorage。导出组件只发出 `export-html`、`export-pdf` 事件，导出实现归 `features/export/services`。

#### 阶段 D：`tabs.ts`

保持 `useTabsStore` API 不变，内部抽取：

```text
tab-lifecycle.ts       open、close、active、remove
tab-persistence.ts     session、autosave、save state
tab-file-operations.ts rename、delete、reload
tab-recovery.ts        crash recovery、history restore
```

store 只编排这些服务并维护响应式状态；服务通过接口接收 fs、clock 和通知依赖，测试中使用 memory adapter。

### 10.4 Rust 拆分顺序

#### `commands/fs.rs`

按调用边界拆为：

```text
commands/fs.rs             IPC 函数签名和错误转换
security/vault_authorization.rs  vault 注册和当前 scope
security/asset_scope.rs          asset 协议允许范围
domain/path_policy.rs            路径规范化和边界判断
storage/file_store.rs            基础读写
```

任何 `register_vault` 授权判断必须集中在 `vault_authorization`，不能在多个 command 中复制字符串前缀判断。

#### `storage/file_store.rs`

拆分顺序：

1. 先提取 `atomic_write.rs` 和锁接口。
2. 再提取 `attachment_store.rs`，实现原子“不覆盖”创建。
3. 再提取 `metadata_store.rs`，集中 history/trash side key。
4. 最后提取 `rename_store.rs`，负责文件和目录元数据迁移。

每一步都要保留旧公开函数的薄转发，避免一次性修改全部 command。

#### `providers/ai/client.rs`

```text
client.rs       HTTP client 生命周期和 provider 调用
request.rs      请求体构造及大小限制
response.rs     JSON 响应解析及大小限制
sse.rs          流式帧解析及 buffer 上限
url_policy.rs   HTTPS、localhost 和 SSRF 规则
limits.rs       prompt、图片、响应和超时上限
```

大小限制必须在读取 body 前和流式追加时分别执行，不能只在前端提示。

## 11. 子代理协作约束

主代理必须将本文档视为只读规范。所有子代理收到任务时必须附带以下约束：

```text
只能读取 docs/development/DEVELOPMENT-ROADMAP.md。
禁止修改、覆盖、重命名、移动或删除该文档及 docs/development/ 下的规范文档。
禁止使用 git checkout、git restore、git reset 覆盖用户文件。
只能修改任务明确授权的源码和测试文件。
完成后报告修改文件、测试命令和失败原因，不得自行修改开发文档。
```

子代理完成后，主代理负责：

1. 检查 `git diff --stat` 和完整 diff。
2. 检查是否越过模块所有权边界。
3. 运行定向测试、类型检查和 lint。
4. 发现文档与实现不一致时，暂停合并并由主代理统一决定；子代理不得自行改文档。
5. 每个功能域单独提交，提交信息使用 `refactor:`、`fix:` 或 `test:` 前缀。

## 12. 拆分完成判定

一个模块只有同时满足以下条件才算完成：

- 单个 Vue/TS/Rust 文件不再同时承担展示、状态、IO 和事务四种职责；
- 公共接口有类型定义和测试；
- 新模块没有循环依赖；
- 注释解释了安全、并发、恢复和兼容性原因；
- 旧行为测试全部通过；
- 新文件名符合命名规范；
- 子代理没有修改本开发文档；
- Linux 构建和全量测试通过。

## 13. 500 行上限下的解耦方案

### 13.1 行数预算

源码文件默认不超过 500 行，目标控制在 300-400 行。测试文件默认不超过 800 行；若测试超过 800 行，按行为域拆分，而不是删除场景。生成代码、锁定文件和资源文件不计入预算，但必须避免被误提交到源码目录。

建议的预警阈值：

```text
300 行：开始拆分设计
400 行：本次提交必须完成拆分
500 行：禁止继续增加代码，必须先解耦
800 行测试：按行为域拆分测试文件
```

### 13.2 垂直切片，而不是横向切碎

不要把一个文件简单拆成 `helpers-a.ts`、`helpers-b.ts`。优先按完整用户能力切片，每个切片包含自己的类型、服务、组件和测试：

```text
features/notes/
├─ create/
│  ├─ create-note-form.vue
│  ├─ create-note.ts
│  └─ create-note.test.ts
├─ rename/
│  ├─ rename-note-dialog.vue
│  ├─ rename-note.ts
│  └─ rename-note.test.ts
├─ delete/
│  ├─ delete-note.ts
│  └─ delete-note.test.ts
├─ list/
│  ├─ note-list-panel.vue
│  ├─ note-card.vue
│  └─ note-list.test.ts
└─ index.ts
```

这样每个文件的变化原因更单一，后续修改删除流程不会触碰列表渲染。

### 13.3 页面组件只做编排

页面组件最多负责四件事：组合子组件、传递 props、监听事件、处理 loading/error 状态。以下内容必须移出页面：

- 路径拼接和规范化；
- 文件读写和删除事务；
- 搜索排序算法；
- 导出格式转换；
- 复杂键盘和拖拽状态机；
- 直接调用 Tauri command。

推荐结构：

```ts
// NoteListPanel.vue: composition only
const model = useNoteListModel({ store: documentList, tabs })
```

复杂逻辑放入 `useNoteListModel.ts`，纯算法再放入 `note-list-query.ts`，确保 composable 不包含不可测试的 DOM 细节。

### 13.4 状态、查询、命令分离

每个功能域分成三种接口：

```text
state      当前状态和缓存
query      只读派生数据
command    会产生副作用的动作
```

例如笔记列表：

```text
document-list.ts       state
note-list-query.ts     filter、sort、count 纯函数
note-actions.ts        open、rename、delete、export
```

查询函数不能修改 store；command 必须显式接收目标路径和依赖，不能隐式读取 active tab。

### 13.5 Ports and Adapters

业务服务只依赖小接口，不直接依赖 Tauri：

```ts
interface NoteFilePort {
  read(vault: string, path: string): Promise<string>
  write(vault: string, path: string, content: string): Promise<void>
  rename(vault: string, from: string, to: string): Promise<void>
  delete(vault: string, path: string): Promise<void>
}
```

生产环境使用 `tauriFsAdapter`，测试使用 `memoryFsAdapter`。同样的原则适用于时间、剪贴板、通知、打印和网络请求。

### 13.6 事务编排与原子步骤分离

删除、重命名、密钥轮换等流程不要写在一个 500 行函数中。拆成：

```text
validate*       校验输入和前置条件
prepare*        读取快照、计算目标和备份
commit*         执行原子写入或 rename
rollback*       失败后的恢复
publish*        更新内存状态和通知
```

顶层函数只编排顺序和错误策略。每个步骤通过返回值表达是否已提交，避免用全局变量猜测磁盘状态。

### 13.7 用显式状态机替代布尔变量

当组件出现 `loading`、`saving`、`deleting`、`error`、`confirming` 等多个互相冲突的布尔值时，改为联合类型：

```ts
type DeleteState =
  | { kind: 'idle' }
  | { kind: 'confirming'; path: string }
  | { kind: 'deleting'; path: string }
  | { kind: 'failed'; path: string; message: string }
```

状态机集中在 `useDeleteNote.ts`，组件只渲染状态并发送事件，减少分支和重复清理代码。

### 13.8 事件只用于跨域通知

事件总线只能传递“已完成”的事实，例如 `note-renamed`、`vault-closed`。不能用事件隐藏必须等待的业务步骤，也不能让多个监听器同时修改同一 store。需要返回结果的流程使用显式 `await` 服务调用。

### 13.9 类型和错误独立管理

跨模块类型放在功能域的 `types.ts`，不要从大型组件反向导出类型。错误统一使用可判别类型：

```ts
type NoteActionError =
  | { kind: 'not-found'; path: string }
  | { kind: 'conflict'; path: string }
  | { kind: 'outside-vault'; path: string }
  | { kind: 'io'; cause: unknown }
```

UI 层负责翻译错误文案，服务层不直接调用 toast 或 Vue 通知。

### 13.10 Rust 解耦策略

Rust 中为每个外部依赖定义 trait：

```rust
pub trait VaultFileIo {
    fn read(&self, vault: &Path, path: &Path) -> Result<Vec<u8>>;
    fn atomic_write(&self, vault: &Path, path: &Path, bytes: &[u8]) -> Result<()>;
}
```

`domain` 接收 trait，`storage` 提供真实实现，测试提供 fake 实现。锁、时钟、随机数、HTTP client 和权限检查都采用相同方法。

Rust 文件拆分优先级：

1. 先把纯类型、错误和策略移出；
2. 再把 IO trait 和真实适配器移出；
3. 再把事务编排移出；
4. 最后让 command 只保留薄包装。

### 13.11 防止拆分后的循环依赖

每个 feature 只能通过 `index.ts` 暴露公开 API。禁止深层路径互相 import。共享代码必须满足至少两个真实调用方，否则留在所属 feature 中，不提前抽成 shared。

依赖检查清单：

- `components` 不 import `stores`；
- `services` 不 import `.vue`；
- `platform` 不 import `features`；
- feature 不 import 另一个 feature 的内部文件；
- Rust `domain` 不 import `storage` 的具体实现；
- 测试可注入 fake，不通过全局 singleton 绕过接口。

### 13.12 500 行例外规则

只有以下情况允许暂时超过 500 行：自动生成代码、协议映射、静态数据、复杂但单一的解析器。必须在文件顶部添加简短注释说明原因，并在架构文档登记。业务组件、store、command、service 和 provider 不适用例外。
