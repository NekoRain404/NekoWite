# NekoWite 开发文档

> 文档版本：2026-09-04
> 项目定位：本地优先、Markdown/MDX 兼容、结构化可视化编辑的桌面知识库。

## 1. 产品目标

NekoWite 的目标不是只提供一个 Markdown 输入框，而是成为一个可靠的 MDX 文档工作台：

- 源文件可长期保存、可迁移、可被 Git 和其他工具使用。
- 可视化编辑不会静默破坏未知 Markdown/MDX 语法。
- 图片、表格、链接、反向链接和图谱可以直接参与编辑工作流。
- 大型 vault 仍能快速搜索、打开和更新索引。
- 插件、AI、文件访问和密钥处理有清晰且可验证的安全边界。
- 崩溃、误删、冲突和关闭窗口不会轻易造成数据丢失。

核心原则：

1. **源码优先**：MDX 源码是最终事实来源，编辑器状态是可重建的投影。
2. **可恢复优先**：写入采用临时文件、原子替换、快照和回收站策略。
3. **边界优先**：权限检查必须位于真正的执行边界，而不是只依赖前端声明。
4. **增量优先**：搜索、图谱、文件监听和渲染尽量只处理变化部分。
5. **可测量**：每一个性能结论都要有场景、数据、环境和回归阈值。

## 2. 当前架构

### 2.1 分层

```text
UI / Vue views
    ↓
stores + composables
    ↓
application services
    ↓
gateway contracts
    ├─ Tauri gateway
    └─ memory/test gateway
    ↓
Rust commands / filesystem / key storage / AI transport
```

编辑器核心位于 `packages/editor-core`，插件运行时位于 `packages/plugin-host`。桌面应用只通过公共契约使用这两个包，避免把 Tauri、Vue 或浏览器对象泄漏到可复用核心。

### 2.2 关键数据流

```text
MDX 文件
  → parser / source model
  → editor document
  → ProseMirror transaction
  → serializer
  → atomic write
  → file watcher / index update / graph update
```

任何无法安全转换的 MDX 片段必须保留为源码占位内容，不能在 round-trip 中被静默删除或改写。

### 2.3 状态边界

- UI 状态：当前面板、选区、对话框、筛选条件。
- 文档状态：编辑器文档、源码文本、dirty 状态、历史栈。
- vault 状态：当前根目录、文件清单、监听状态、索引版本。
- 基础设施状态：IPC、密钥、AI 请求、插件生命周期。

跨层通信优先使用显式接口、事件和命令对象，禁止通过全局变量隐式传递业务状态。

## 3. 里程碑完成度

状态说明：

- **已完成**：代码、测试和文档均形成闭环。
- **基本完成**：主流程可用，但仍有明确的生产风险或能力缺口。
- **部分完成**：核心能力存在，完整产品体验尚未闭环。
- **未完成**：尚无可接受的实现或验证证据。

| 里程碑 | 当前状态 | 已完成内容 | 仍然不足 |
|---|---|---|---|
| M1 安全与数据可信度 | 基本完成 | IPC vault 绑定、真实 KDF、API key 隐藏、插件执行前校验、完整性校验、严格 CSP | 插件尚无真正 Worker/进程隔离；生产 vault 插件在严格 CSP 下被禁用；需要恶意插件和越权 IPC 的真实测试 |
| M2 MDX 保真编辑 | 基本完成 | MDX round-trip、未知 JSX 源码占位、HTML/Markdown 导出修复 | 仍需覆盖更多 JSX 表达式、指令、嵌套组件和格式最小化 diff；不能承诺任意 MDX 100% 保真 |
| M3 图片与表格编辑 | 基本完成 | 图片属性面板、比例缩放、对齐、附件限制；表格行列操作和基础序列化 | 表格合并/拆分、列宽、CSV/Excel 粘贴、多选；图片裁剪/旋转、键盘缩放、完整无障碍和批量流式导入 |
| M4 索引与知识图谱 | 基本完成 | 持久化增量全文索引、正文深层搜索、图谱 Worker、筛选、链接解析和非静默截断 | 需要真实多 vault、大规模文件、断电恢复和索引损坏重建验证；JSON/localStorage 容量边界仍需关注 |
| M5 性能与大型 vault | 工程能力完成，生产数据待补 | 有界并行、去抖、latest-wins、低拷贝附件路径、性能 harness | 仍需在目标机器测量冷启动、输入延迟、搜索、图谱和大附件峰值，并纳入 CI 回归 |
| M6 产品成熟度 | 基本完成 | 关闭前保存、恢复/快照/回收站、冲突处理、插件 SDK、恢复相关无障碍 | `.tmp` 崩溃残留清理、切换 vault 时未命名 dirty 文档、编辑器完整 live-region、真正插件隔离 |

### 3.1 M1：安全与数据可信度

已具备：

- Rust IPC 根据当前打开 vault 校验路径，前端传入的任意路径不能绕过边界。
- API key 不再通过 URL 查询参数返回，前端仅获得掩码或受控结果。
- 主密码使用真实 KDF，不再是无盐单轮哈希。
- 插件完整性在执行顶层代码之前验证，审批后再次确认变更。
- 严格 CSP 下不允许通过 `blob:` 绕过生产策略。

必须保持的安全契约：

- 权限检查必须发生在 Rust command、文件网关或插件宿主的执行点。
- 插件声明权限不能被视为 IPC 授权凭证。
- vault 根目录不能由普通渲染层单方面决定。
- 所有敏感错误向用户显示可行动建议，但不泄露密钥、绝对路径或内部堆栈。

剩余高风险：当前插件仍可能在主窗口上下文运行。目标实现应采用 Worker、独立 WebView 或独立进程，并让宿主只暴露最小 RPC 能力。

### 3.2 M2：MDX 保真

编辑器必须区分三类内容：

1. 已知且可结构化编辑的 Markdown/MDX 节点。
2. 已知语义但暂不支持可视化编辑的节点。
3. 未知 JSX、表达式或指令源码。

第 2、3 类内容以源码占位符保留。保存时必须满足：

- 未编辑区域字节级或语义级不变，取决于 serializer 策略。
- 未知片段顺序、边界、属性和内容不丢失。
- 解析失败时保留原始源码，并提供回退到 Source 编辑的路径。
- 输出失败不能覆盖最近一次可恢复版本。

后续必须建立 round-trip fixture 集合，覆盖：组件属性、表达式容器、嵌套 JSX、代码块、表格、图片、链接、中文和混合换行符。

### 3.3 M3：图片和表格

#### 图片标准

基础能力已可用：粘贴、拖放、附件保存、路径解析、宽度调整、对齐和序列化。

目标体验还应包括：

- 明确的选中态和独立 resize handle。
- Alt、title、链接、替换、删除、恢复原始尺寸。
- 比例锁定、键盘缩放和无障碍名称。
- 大文件采用路径或流式导入，避免前端 Base64 和 Rust decode 的双重峰值。
- 对 SVG 规定安全策略，禁止危险脚本和外部资源加载。

拖动过程只产生一个 undo 历史项；中间 pointermove 更新应合并，取消操作应恢复原值。

#### 表格标准

基础能力已可用：插入、单元格编辑、GFM 解析/序列化、行列操作。

优秀 MDX 编辑器至少应补齐：

- 添加/删除行列、Tab 到末尾自动新增行。
- 列宽调整、表头切换、单元格对齐。
- 单元格多选、复制粘贴、CSV/Excel 粘贴。
- 合并/拆分单元格（若格式不适合 Markdown，应明确降级策略）。
- 宽表格的横向滚动和移动端操作。
- 复杂 JSX/MDX 表格的源码保留和 round-trip 测试。

## 4. M6 后仍需解决的不足

### P0：必须优先

1. **真正的插件隔离**：把插件执行移出主窗口，使用最小权限 RPC、超时、取消、资源配额和崩溃重启机制。
2. **生产插件治理**：签名验证、来源信任、版本回滚、撤销列表、安装包校验和审计日志。
3. **安全回归测试**：恶意顶层代码、篡改插件、伪造 vault 路径、IPC 越权、密钥泄露和 CSP 生产构建测试。
4. **数据恢复闭环**：启动时扫描 `.tmp`、展示可恢复版本；清理已确认无主的临时文件；vault 切换前处理未命名 dirty 文档。

### P1：影响核心体验

1. 完善 MDX round-trip fixture，覆盖当前解析器未知和边界语法。
2. 完善表格和图片结构编辑，尤其是复制粘贴、键盘流程和无障碍。
3. 将索引从单一 JSON 存储演进为分片或嵌入式数据库，支持版本、校验和原子重建。
4. 附件采用文件路径/流式导入，明确单文件、批量、vault 总量和磁盘剩余空间策略。
5. 在真实 Tauri WebView 和目标机器上建立性能基线，避免只用 Node/service proxy 推断桌面体验。

### P2：工程长期收益

1. 拆分 `App.vue`、`RenderedPane.vue`、`library.ts` 等中心模块。
2. 拆分 Rust 的 `fs.rs`、`keys.rs`、`ai.rs`，隔离 command、domain、storage 和 transport。
3. 统一事件总线和取消模型，消除全局 singleton 对测试和多 vault 的影响。
4. 补齐编辑器 live-region、非模态属性面板焦点管理和完整键盘导航。
5. 建立插件开发者文档、示例插件、兼容性矩阵和迁移策略。

## 5. 代码解耦与目录整理

### 5.1 前端目标目录

```text
apps/desktop/src/
├─ app/
│  ├─ AppShell.vue
│  ├─ bootstrap.ts
│  └─ routes.ts
├─ features/
│  ├─ editor/
│  │  ├─ components/
│  │  ├─ composables/
│  │  ├─ model/
│  │  └─ services/
│  ├─ vault/
│  ├─ search/
│  ├─ graph/
│  ├─ plugins/
│  ├─ attachments/
│  └─ settings/
├─ stores/
├─ services/
│  ├─ gateways/
│  ├─ indexing/
│  ├─ persistence/
│  └─ events/
├─ shared/
│  ├─ types/
│  ├─ errors/
│  ├─ utils/
│  └─ ui/
└─ test/
```

整理规则：

- 页面组件只负责布局和事件绑定，不直接调用 Tauri `invoke`、`listen` 或文件系统。
- feature 内部依赖可以向下调用 shared，禁止 feature 之间互相穿透内部文件。
- store 只管理状态和动作，复杂 I/O 下沉到 service。
- gateway contracts 不依赖 Vue、Tauri 或浏览器 DOM；memory gateway 必须能独立驱动单测。
- 全局单例改为显式生命周期对象，由 `bootstrap` 创建并在 vault 切换/销毁时释放。

### 5.2 重点模块拆分建议

- `App.vue`：拆为 `AppShell`、`WorkspaceLayout`、`GlobalDialogs`、`AppShortcuts`。
- `RenderedPane.vue`：拆为文档渲染、图片交互、上下文菜单、保存状态和编辑器桥接 composable。
- `stores/library.ts`：拆为 vault 状态、文件树、打开文档、索引状态四个 store。
- `services/ai.ts`：通过 `aiGateway` 访问 Tauri 监听，不在业务 service 内直接依赖事件实现。
- `fs.rs`：拆为 `commands/fs_commands.rs`、`domain/path_policy.rs`、`storage/file_store.rs`、`storage/trash_store.rs`、`recovery/recovery_store.rs`。
- `keys.rs`：拆为 `commands/key_commands.rs`、`crypto/kdf.rs`、`crypto/key_store.rs`、`crypto/session.rs`。
- `ai.rs`：拆为 provider、request policy、rate limiter、secret resolver 和 command 层。

### 5.3 依赖规则

允许方向：`UI → composable/store → service → gateway → platform`。
禁止方向：platform 反向引用 UI；editor-core 引用 desktop；plugin-host 直接调用 Rust command。

每次新增跨层依赖都应在 code review 中说明原因，并优先新增接口而不是导入具体实现。

### 5.4 当前文件职责盘点

以下盘点以当前代码规模为依据，不要求一次性移动所有文件。先识别职责，再按风险分批迁移。

| 当前文件 | 当前问题 | 目标职责 | 首个拆分动作 |
|---|---|---|---|
| `App.vue` | 约 640 行，布局、快捷键、全局对话框、生命周期和业务动作混在一起 | 应用壳层和装配入口 | 把快捷键、窗口事件、全局弹窗各提取为 composable/component，保持模板行为不变 |
| `view/RenderedPane.vue` | 渲染、编辑器桥接、图片交互、搜索、保存状态耦合 | 文档渲染视图 | 先提取 `useRenderedDocument`、`useRenderedSearch`、`useImageInteraction`，再简化组件 |
| `stores/library.ts` | vault、文件树、当前文件、索引刷新和监听状态集中 | vault session、file tree、index status | 先定义 `VaultSession` 和 `FileIndexState` 类型，再拆 store，避免直接复制 reactive 状态 |
| `services/plugins.ts` | 发现、读取、校验、审批、加载、运行、错误路由集中 | plugin registry、integrity verifier、lifecycle runner | 先提取纯函数校验和 manifest 解析，再提取 I/O adapter，最后保留编排器 |
| `services/linkGraph.ts` | 链接解析、图数据构造、缓存、排序和截断策略集中 | link resolver、graph builder、graph cache | 将路径解析做成无副作用模块，图构造只接收已解析的文档快照 |
| `services/attachments.ts` | MIME、大小限制、编码、保存、命名和 UI 错误处理集中 | attachment policy、import pipeline、attachment store | 先提取 `AttachmentPolicy` 和 `AttachmentSource`，为后续流式导入保留接口 |
| `services/ai.ts` | provider、请求、事件监听、并发、错误映射混在一起 | AI application service | `aiGateway` 负责 transport，service 只负责请求策略和生命周期 |
| `src-tauri/src/lib.rs` | command 注册、状态初始化和插件配置集中 | Tauri composition root | 只保留装配和注册，命令实现全部移到 `commands/` |
| `src-tauri/src/fs.rs` | 路径策略、读写、搜索、回收站、恢复、附件都在一个文件 | 文件领域服务集合 | 先抽 `path_policy`，再按读写、trash、recovery、search 分模块 |
| `src-tauri/src/keys.rs` | KDF、会话、密钥存储、命令和错误映射集中 | crypto domain + secure storage adapter | 先固定 `KeyStore` trait，再拆实现，避免 UI 依赖具体存储 |
| `src-tauri/src/ai.rs` | provider HTTP、密钥解析、限流、命令和响应转换集中 | AI transport/application modules | provider trait 与 command DTO 先分开，保证新增 provider 不改命令层 |

### 5.4.1 前端文件逐项归类

当前 `apps/desktop/src` 中的文件建议按以下规则归位。这里的“目标目录”是职责归属，不要求立刻移动；迁移时先保持旧导出，再逐步删除兼容层。

| 当前位置 | 文件/文件组 | 归类 | 具体职责 | 不应继续承担 |
|---|---|---|---|---|
| 根目录 | `App.vue`、`main.ts` | `app/` | 应用装配、根布局、启动入口 | 文件读写、搜索算法、编辑器业务细节 |
| `components/` | `AppToast`、`ConflictDialog`、`PermissionDialog`、`RenameDialog` | `shared/ui/` 或对应 feature | 通用对话框、提示和表单 | 直接读写 store 之外的业务数据 |
| `components/` | `GhostWriter`、`FloatToolbar`、`WordToolbar` | `features/editor/components/` | 编辑器工具条和 AI 编辑入口 | 直接调用 Tauri 或管理文档持久化 |
| `ui/` | `EditorPane`、`SourcePane`、`RenderedPane`、`ViewSwitch` | `features/editor/components/` | 三种编辑视图和视图切换 | vault 监听、全局窗口事件 |
| `ui/` | `FileTree`、`NoteListPanel`、`AttachmentsPanel` | `features/vault/`、`features/attachments/` | 文件树、笔记列表、附件列表 | 建立底层 watcher 或拼装索引算法 |
| `ui/` | `GraphPanel`、`ReferencesPanel`、`OutlinePanel` | `features/graph/`、`features/editor/` | 图谱、反链、大纲展示 | 直接读文件、自己维护索引副本 |
| `ui/` | `ChatPanel`、`CommandPalette`、`SettingsPanel` | `features/ai/`、`features/settings/`、`app/` | AI 会话、命令入口、设置 UI | provider 选择、密钥加载、系统对话框实现 |
| `services/` | `contentCache`、`contentSearch`、`searchIndex`、`vaultFiles` | `application/indexing/` | 索引构建、查询、缓存和文件清单 | toast、dialog、Vue reactive 状态 |
| `services/` | `linkGraph`、`graphLayoutClient`、`graphLayoutWorker` | `features/graph/services/` | 链接解析、图快照、布局通信 | 保存文档、修改 tabs、访问组件 ref |
| `services/` | `attachments`、`attachmentLibrary`、`renameAsset` | `features/attachments/services/` | 导入、命名、保存、清理附件 | 直接处理面板显示状态 |
| `services/` | `editorBridge`、`editorBehaviors`、`scrollSyncAnchors`、`renderSearch` | `features/editor/services/` | 编辑器命令、桥接、同步、搜索覆盖层 | 全局持有多个编辑器实例 |
| `services/` | `plugins` | `features/plugins/services/` | 发现、授权、完整性和生命周期编排 | 直接暴露 Tauri IPC 给插件 |
| `services/` | `ai`、`aiEdit` | `features/ai/services/` | AI 用例、请求策略、编辑建议 | 直接调用 `listen`、处理 UI toast |
| `services/gateways/` | `contracts`、`memory`、`tauri` | `infrastructure/gateways/` | 平台能力端口和适配器 | 领域规则、翻译、组件状态 |
| `stores/` | `library`、`tabs`、`view`、`appearance`、`settings` | `stores/` | 可观察状态、用户动作、selectors | 复杂异步流程和多步骤 I/O |

### 5.4.2 一个模块应如何判断“职责过多”

满足以下任意两项，就应考虑拆分，而不是继续往文件中追加函数：

- 同时导入 Vue、Pinia、Tauri、编辑器核心和多个业务 service。
- 同时处理 UI 状态、持久化、网络/IPC 和错误展示。
- 测试需要 mock 四个以上不同层次的依赖才能运行。
- 一个函数既决定业务规则，又负责把结果转换成 toast/dialog 文案。
- 修改一个需求需要同时触碰组件模板、store、底层 gateway 和 Rust command。
- 文件超过 400 行且没有明显的单一领域边界；超过 600 行应默认进入拆分 backlog。

拆分的判断依据不是行数本身，而是“变化原因”数量。一个 500 行但只有一个纯领域算法的文件可以暂时保留；一个 200 行却同时跨 UI、平台和安全边界的文件也应优先拆分。

### 5.4.3 推荐的接口收口

应用层不应把原始路径字符串和 Tauri 参数到处传递，建议定义领域值对象和 repository：

```ts
type VaultId = string & { readonly __brand: 'VaultId' }
type NotePath = string & { readonly __brand: 'NotePath' }

interface NoteRepository {
  read(vault: VaultId, path: NotePath): Promise<string>
  write(vault: VaultId, path: NotePath, content: string): Promise<void>
  remove(vault: VaultId, path: NotePath): Promise<void>
}

interface NoteIndex {
  rebuild(vault: VaultId): Promise<IndexBuildResult>
  update(vault: VaultId, path: NotePath): Promise<void>
  search(vault: VaultId, query: SearchQuery): Promise<SearchResult[]>
}
```

组件只依赖 `NoteRepository`、`NoteIndex` 等接口。`VaultId` 和 `NotePath` 的构造必须经过校验函数，避免调用方把任意用户输入误当成已验证路径。

### 5.4.4 迁移期间的兼容策略

解耦重构不应和行为变更绑在同一个大 PR 中。推荐使用三步迁移：

1. 在原文件中新增内部模块并保留原导出，例如 `services/plugins.ts` 暂时转发到 `features/plugins/services/pluginCoordinator.ts`。
2. 将调用方逐个切到新路径，使用 `rg` 检查旧路径引用数量逐步降为零。
3. 删除转发文件和旧测试入口，更新 barrel export、路径别名和文档。

兼容层必须标注删除条件和目标版本，不能无限期保留。迁移期间禁止同时修改序列化格式、错误码和用户交互，除非该重构本身就是为修复安全问题。

### 5.5 推荐目标目录（更细粒度）

```text
apps/desktop/src/
├─ app/
│  ├─ AppShell.vue                 # 只负责根布局
│  ├─ bootstrap.ts                 # 创建 runtime 和依赖
│  ├─ lifecycle.ts                 # 启动、关闭、恢复
│  └─ shortcuts.ts                 # 全局快捷键表
├─ features/
│  ├─ editor/
│  │  ├─ components/               # EditorPane、RenderedPane、SourcePane
│  │  ├─ composables/              # 编辑器生命周期、搜索、图片交互
│  │  ├─ model/                    # 文档会话、dirty、selection DTO
│  │  └─ services/                 # 编辑器应用用例
│  ├─ vault/
│  │  ├─ components/               # FileTree、VaultPicker
│  │  ├─ model/                    # VaultSession、VaultFile
│  │  └─ services/                 # 打开、切换、监听、恢复
│  ├─ search/
│  │  ├─ model/                    # Query、SearchResult、IndexStatus
│  │  └─ services/                 # 查询和索引编排
│  ├─ graph/
│  │  ├─ components/               # GraphPanel、filters
│  │  └─ services/                 # graph client、snapshot、layout
│  ├─ attachments/
│  ├─ plugins/
│  └─ settings/
├─ stores/
│  ├─ vaultSession.ts
│  ├─ documentTabs.ts
│  ├─ editorView.ts
│  ├─ searchState.ts
│  └─ settings.ts
├─ platform/
│  ├─ gateways/                    # Tauri、memory、browser fallback
│  ├─ events/                      # listen/emit 适配
│  └─ runtime/                     # 生命周期和取消
├─ shared/
│  ├─ contracts/                   # 跨 feature DTO
│  ├─ errors/                      # 可展示错误与内部错误
│  ├─ logging/                     # 脱敏日志
│  ├─ ui/                          # 通用无业务组件
│  └─ utils/
└─ test/
   ├─ fixtures/
   ├─ factories/
   └─ e2e/
```

对应 Rust：

```text
apps/desktop/src-tauri/src/
├─ main.rs
├─ lib.rs                         # 仅组装 app state 和 command
├─ commands/
│  ├─ fs.rs
│  ├─ recovery.rs
│  ├─ keys.rs
│  └─ ai.rs
├─ domain/
│  ├─ path_policy.rs
│  ├─ vault.rs
│  ├─ recovery.rs
│  └─ plugin_policy.rs
├─ storage/
│  ├─ file_store.rs
│  ├─ trash_store.rs
│  ├─ index_store.rs
│  └─ key_store.rs
├─ providers/
│  └─ ai/
│     ├─ gemini.rs
│     ├─ openai_compatible.rs
│     └─ client.rs
├─ errors.rs
└─ state.rs
```

### 5.6 拆分顺序与操作步骤

按以下顺序拆分可以降低回归范围：

1. **先抽类型和契约**：把参数、返回值、错误码、事件名固定下来；不移动实现。
2. **再抽纯函数**：路径规范化、manifest 校验、搜索评分、链接解析、序列化都先变成无副作用函数。
3. **再抽 gateway**：把 `invoke`、`listen`、文件读写和系统对话框集中到 platform 层。
4. **再抽 composable/use case**：组件只保留模板、输入输出和少量局部状态。
5. **最后移动 store 和目录**：等依赖方向稳定后再改文件位置，避免反复改 import。
6. **每次只迁移一个职责**：迁移后先跑受影响测试，再进行下一步。

每个拆分 PR 应满足：不同时引入新功能；旧 API 保留一个过渡周期；新增模块有单测；删除旧实现前完成引用搜索；变更说明列出循环依赖和公共导出变化。

### 5.6.1 具体重构任务单

#### R1：App.vue

- 新建 `app/AppShell.vue`，只保留布局、插槽和 feature 组件组合。
- 新建 `app/appBootstrap.ts`，返回已初始化的 `DesktopRuntime`，不触碰 DOM。
- 新建 `app/appLifecycle.ts`，封装 `onMounted`、`onBeforeUnmount`、窗口关闭和 autosave。
- 新建 `app/appDialogs.ts`，统一冲突、权限、完整性和恢复对话框的状态模型。
- 新建 `app/windowState.ts`，只负责窗口尺寸、位置和持久化。
- 验收：`App.vue` 不再出现 `invoke`、`listen`、文件路径拼接和索引遍历；组件测试只需装配 mock runtime。

#### R2：RenderedPane.vue

- `editorController.ts`：创建、更新、销毁编辑器实例，暴露命令而不暴露内部 view。
- `editorPersistence.ts`：序列化、dirty、save、autosave、保存失败恢复。
- `editorExternalSync.ts`：文件 watcher、外部修改检测、冲突决策。
- `editorScrollSync.ts`：source/rendered 锚点计算、去抖和取消。
- `editorSearchOverlay.ts`：搜索状态、匹配定位、拼写标记。
- `editorSelection.ts`：图片、表格、浮动工具条的选区 DTO。
- 验收：组件只接收 `documentSession` 和 callbacks；所有异步任务可取消；卸载后没有遗留 listener、worker 或 timer。

#### R3：library.ts

- `vaultSessionStore`：当前 vault、打开/关闭和切换状态。
- `fileTreeStore`：文件树、排序和截断状态。
- `documentListStore`：笔记列表、标签、收藏和最近访问。
- `vaultIndexCoordinator`：watcher 事件到索引任务的编排。
- `indexPersistence`：索引版本、校验、保存和重建。
- `libraryQueries`：只读 selectors，不产生副作用。
- 验收：store 不直接读文件内容；索引服务能用 memory gateway 在无 Vue 环境下测试；切换 vault 会取消旧任务并清理旧订阅。

#### R4：services/gateways

- 将 `contracts.ts` 拆为 `FsPort`、`AiPort`、`KeyPort`、`EventPort`、`DialogPort`。
- `tauri.ts` 只实现适配，不包含业务判断；`memory.ts` 提供可控故障和事件模拟。
- `getGateways()` 改为 `createGateways(deps)`，全局缓存只保留在应用装配层。
- 将 `ai.ts` 中的 Tauri `listen` 移入 `TauriEventAdapter`。
- 验收：业务 service 中搜索不到 `@tauri-apps/api`、`invoke(` 或 `listen(`；memory adapter 能覆盖成功、超时、取消和错误场景。

#### R5：Rust 大模块

- 先移动函数和测试，不改 command 名称、DTO 和错误码。
- 每移动一个领域，立即运行 `cargo test` 和受影响的前端 gateway 测试。
- 最后才调整 `lib.rs` 的模块声明和 command 注册。
- 验收：command 函数只做反序列化、调用 service、错误映射；路径策略只有一个实现；所有文件操作都能追踪到 `VaultContext`。

### 5.6.2 重构完成度指标

| 指标 | 当前风险 | 目标 |
|---|---|---:|
| UI 文件直接调用 Tauri API | 存在 | 0 个 |
| 单个组件直接依赖业务 service 数 | 偏高 | ≤ 3 个，最好只依赖一个 controller |
| 单个 store 直接依赖 platform/gateway 数 | 偏高 | 0 个，统一经 application service |
| 超过 600 行的业务文件 | 多个 | 每个都有拆分 issue 或明确保留理由 |
| 全局 editor/plugin/runtime 状态 | 存在 | 由显式 runtime/session 持有 |
| 无法在 memory adapter 下运行的 service 测试 | 存在 | 核心 application service 全部可运行 |

### 5.7 防止循环依赖的规则

- 类型只放在 `contracts` 或 feature 的 `model`，不要从组件文件导出业务类型。
- `shared` 不能导入任何 feature；它只能依赖标准库和无业务第三方库。
- `stores` 不直接导入 Vue 组件，不读取 DOM，不调用 Rust 命令。
- `services` 不修改另一个 feature 的 store；通过返回值或事件通知上层。
- `platform/gateways` 不知道当前页面，不处理 toast、dialog 或翻译。
- editor-core 只能接收显式 adapter，不允许访问 desktop 的 singleton。
- plugin-host 只能拿到宿主提供的 capability object，不能自行发现 Tauri API。

### 5.8 全局状态和生命周期整理

当前存在 editor bridge、plugin runtime、gateway cache 等全局状态。目标接口应显式表达创建和销毁：

```ts
type DesktopRuntime = {
  vault: VaultGateway
  index: IndexService
  graph: GraphService
  plugins: PluginService
  dispose(): Promise<void>
}

function createDesktopRuntime(deps: RuntimeDeps): DesktopRuntime
```

vault 切换时必须按顺序执行：停止 watcher → 取消搜索和索引任务 → flush 当前编辑 → 释放旧 runtime → 创建新 runtime。任何事件监听都必须有对应的 unsubscribe，测试中可以创建多个 runtime 而互不污染。

### 5.9 文件命名与导出规范

- Vue 组件使用 PascalCase；composable 使用 `useXxx.ts`；纯函数使用名词或动词短语。
- 同一能力的测试紧邻实现，命名为 `*.test.ts`；跨模块 fixture 放到 `test/fixtures`。
- 一个文件只提供一个主要公共概念；超过约 300 行应解释原因或拆分。
- `index.ts` 只做稳定公共导出，不导出内部实现和测试工具。
- 避免 `utils.ts`、`helpers.ts` 成为杂物箱；按领域命名，如 `pathPolicy.ts`、`searchScore.ts`。
- 类型名表达领域含义，避免 `Data`、`Info`、`Manager`、`Handler` 等无边界命名。

## 6. 注释与文档规范

当前注释数量不低，Rust 的边界说明较好；前端关键流程仍偏依赖命名和上下文，复杂生命周期、取消、缓存失效和安全假设需要补充。目标不是增加注释数量，而是提高决策信息密度。

应写注释的地方：

- 为什么必须这样做，而不是代码表面在做什么。
- 权限、CSP、路径校验、KDF、原子写入等安全约束。
- debounce/latest-wins、缓存失效、并发上限和排序稳定性的原因。
- 外部库 workaround、浏览器/Tauri 差异和已知限制。
- 复杂状态机的状态转移和资源释放责任。

不应写：

- `const value = ... // assign value` 这类重复代码描述。
- 已经由类型、函数名和测试清楚表达的显然事实。
- 失效的 TODO、过时的性能数字或“临时”但没有 issue 的补丁说明。

推荐格式：

```ts
// Preserve unknown MDX as source so a visual edit cannot silently delete it.
// The placeholder is replaced during serialization, not rendered as Markdown.
```

安全假设、已知限制和待移除 workaround 应链接 issue 或在模块文档中集中说明。公共 API、插件 SDK 和 gateway contract 使用 TSDoc/Rustdoc，包含输入、输出、错误和生命周期。

### 6.1 注释分级

| 类型 | 目的 | 必须包含 | 示例位置 |
|---|---|---|---|
| 模块注释 | 解释边界和不变量 | 负责什么、不负责什么、主要依赖 | `services/plugins.ts`、Rust domain |
| 算法注释 | 解释非显然算法 | 选择原因、复杂度、失效条件 | 图布局、搜索评分、缓存 |
| 安全注释 | 防止未来误删保护 | 威胁、边界、禁止的替代实现 | 路径校验、CSP、KDF、密钥 |
| 生命周期注释 | 说明创建/取消/释放 | 谁创建、谁销毁、重复调用行为 | watcher、worker、editor bridge |
| 兼容性注释 | 解释外部环境差异 | 版本、平台、触发条件、移除条件 | Tauri/WebView、Milkdown |
| 公共 API 文档 | 给调用方使用 | 参数、返回、错误、示例、稳定性 | plugin SDK、gateway contracts |

### 6.2 模块头注释模板

复杂模块建议在文件顶部写一段短文，而不是在每个函数前重复描述：

```ts
/**
 * Coordinates plugin discovery, approval, integrity verification and lifecycle.
 * It does not grant filesystem or AI access; capabilities are enforced by the
 * host gateway. Loading must verify source before any plugin top-level code runs.
 */
```

Rust 模块使用 `//!` 说明领域边界和安全不变量。模块头不写变动日志，变动历史交给 Git。

### 6.3 安全注释模板

安全注释必须回答“保护谁、阻止什么、在哪一层阻止”：

```ts
// This check prevents stale results from an older vault from overwriting the
// current index. The sequence is incremented before every async rebuild.
```

```rust
// The path is canonicalized and checked against the registered vault here,
// because frontend permission declarations are not an IPC security boundary.
```

不要写“这里很安全”“防止攻击”这种无法验证的结论；要写具体不变量和测试名称。

### 6.4 性能注释模板

性能相关注释应记录复杂度和取舍，而不是只写“优化”：

```ts
// Metadata filtering avoids reading bodies for obvious non-candidates.
// Full-body verification still runs for every candidate to prevent false negatives.
```

如果采用截断、并发上限、去抖或缓存，必须注明：上限值、用户可见的截断信号、缓存失效条件和为什么不会丢最新结果。

### 6.5 TODO、FIXME 和 workaround 管理

- `TODO` 必须带 issue 编号、责任边界和完成条件。
- `FIXME` 只用于已确认的正确性问题，不能作为长期需求列表。
- 外部库 workaround 必须写触发版本、当前影响和移除条件。
- 已完成事项删除 TODO，不保留“历史纪念”注释。
- 每个版本发布前扫描无 issue 的 TODO、过期版本号和“临时”字样。

推荐格式：

```ts
// TODO(#412): Replace JSON index storage with sharded persistence once the
// vault-size benchmark exceeds the current memory budget.
```

### 6.6 注释质量检查清单

Code review 时逐项检查：

- 注释是否解释原因，而非复述代码。
- 是否说明错误、取消和资源释放行为。
- 是否把安全边界放在实际执行点。
- 数字是否有来源、单位和适用环境。
- 注释是否与测试和实现一致。
- 是否可以通过更好的命名或类型消除注释。
- 是否存在中文/英文混杂导致术语不统一。

### 6.7 注释整理的实施批次

1. 先清理失效 TODO、明显错误注释和复制粘贴注释。
2. 为 `fs.rs`、`keys.rs`、`plugins.ts`、`attachments.ts`、`linkGraph.ts` 补模块边界和安全不变量。
3. 为 watcher、index、graph worker、editor bridge 补生命周期和取消说明。
4. 为 plugin SDK、gateway contracts、公共 editor-core API 补 TSDoc/Rustdoc。
5. 最后统一术语、标点和中英文格式，不为了比例强行增加注释。

注释整理的验收标准：新成员只阅读模块头、公共 API 和关键测试，就能回答“输入是什么、状态由谁拥有、失败如何恢复、权限在哪一层 enforced、何时释放资源”。

## 7. 测试与质量门禁

### 7.1 提交前必跑

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter desktop test:e2e
```

性能变更额外运行：

```bash
pnpm perf
```

### 7.2 测试矩阵

- editor-core：parser、serializer、图片、表格、未知 MDX、撤销合并。
- desktop services：索引增量更新、搜索取消、图谱刷新、附件限制、恢复流程。
- gateway：memory 与 Tauri 实现的一致性。
- Rust：路径越权、原子写入、回收站、密钥、AI 限流和错误映射。
- E2E：真实打开 vault、编辑保存、重启恢复、导入附件、切换文档、生产 CSP。
- 安全：篡改插件、拒绝权限、恶意顶层代码、伪造路径、敏感信息日志扫描。

### 7.3 Definition of Done

一个功能只有同时满足以下条件才算完成：

1. 需求、边界和不支持场景已写清楚。
2. 核心逻辑有单测，跨层流程有集成或 E2E。
3. 错误、取消、重试、恢复和权限失败都有用户可见结果。
4. 没有新增 lint/typecheck/build 警告。
5. 性能有基线或说明为什么不需要基线。
6. 安全边界经过负向测试。
7. 文档、迁移说明和用户可见行为保持一致。
8. 变更经过独立 review，并确认没有扩大模块耦合。

## 8. 性能预算

以下是开发阶段建议预算，实际值必须在目标设备测量：

| 场景 | 目标 |
|---|---:|
| 冷启动到可交互 | ≤ 2 s |
| 普通文档打开 | ≤ 150 ms |
| 编辑输入延迟 | p95 ≤ 50 ms |
| 增量索引响应 | ≤ 100 ms |
| 搜索 p95 | ≤ 100 ms |
| 图谱交互布局 | 不阻塞输入，分块完成 |
| 单图导入 | 前端额外内存尽量接近文件大小，而非多倍 Base64 峰值 |

`docs/PERF.md` 中的 harness 数值是服务层代理，不能直接等同于 Tauri WebView 的冷启动或输入体验。每次性能优化都应记录：数据规模、设备、构建模式、缓存状态、p50/p95/p99、峰值内存和回归阈值。

## 9. 标准开发流程

1. **定义问题**：写清用户场景、源码格式、兼容性和不支持边界。
2. **定位边界**：确定属于 editor-core、desktop feature、gateway 还是 Rust platform。
3. **风险分析**：检查数据丢失、权限越权、插件执行、性能峰值和可访问性。
4. **先写验收测试**：优先覆盖失败路径、恢复路径和 round-trip。
5. **实现最小闭环**：保持依赖方向和现有 gateway 模式，不做无关重构。
6. **验证行为**：运行单测、集成、E2E、typecheck、lint、build。
7. **验证性能和安全**：根据影响范围运行 perf harness、负向安全测试和真实 WebView 检查。
8. **更新文档**：同步 API、限制、迁移、性能数据和已知问题。
9. **代码审查**：重点检查边界、错误处理、资源释放、模块耦合和测试盲区。
10. **合并验收**：确认工作树、生成物、版本说明和回滚方案，再合并主分支。

## 10. 推荐后续计划

### Sprint A：安全闭环

- 插件 Worker/进程隔离原型。
- 最小权限 RPC 和资源配额。
- 生产插件安装、签名、撤销和回滚。
- 恶意插件与 IPC 越权 E2E。

### Sprint B：数据与 MDX 可靠性

- `.tmp` 扫描和恢复 UI。
- 未命名 dirty 文档的 vault 切换流程。
- 扩充 round-trip fixtures 和差异报告。
- 索引版本、校验、分片和损坏重建。

### Sprint C：编辑器产品力

- 表格复制粘贴、列宽、合并/拆分和移动端交互。
- 图片替换、属性、键盘缩放、裁剪和 SVG 安全策略。
- 编辑器 live-region、焦点管理和完整快捷键矩阵。

### Sprint D：工程解耦与真实性能

- 按 feature 拆分前端中心模块。
- 按 command/domain/storage 拆分 Rust 大文件。
- 消除全局 singleton，建立显式 runtime 生命周期。
- 在真实目标设备建立 CI 性能回归和内存预算。

## 11. 最终评价

M1-M6 的主线能力已经形成，项目从“功能原型”进入“可持续打磨的产品阶段”。当前最重要的判断不是继续堆叠功能，而是补齐三个可信度缺口：插件真正隔离、MDX 任意边界语法的保真、真实桌面环境的性能与恢复验证。

图片和表格已经从不可编辑提升到基础可编辑，但距离“自由编辑”仍有结构操作、复制粘贴、键盘无障碍和复杂 MDX 保真等差距。代码层面最大的长期风险是中心组件和 Rust 大模块继续膨胀；应按上述边界逐步拆分，并以依赖规则和 Definition of Done 约束后续开发。

这份文档是当前开发基线。任何声称“已完成”的后续工作，都应同时更新对应里程碑状态、测试证据、性能数据和已知限制。

## 12. 子代理执行规范

本节用于把文档转换为可直接交给编码子代理的任务提示词。每个任务必须明确范围、禁止事项、输入文件、输出文件、验收命令和回滚方式。子代理不得因为发现“顺手可以优化”的问题而扩大范围。

### 12.1 标准任务提示词

```text
任务名称：<一句话描述>
目标：<用户可观察的结果>
范围：<允许修改的目录和文件>
禁止：<禁止修改的目录、API、格式或行为>
现状：<当前实现、已知限制、相关审计结论>
设计约束：<依赖方向、安全边界、性能预算、兼容要求>
实现步骤：
1. 先阅读指定文件和相邻测试。
2. 先补失败路径测试，再实现最小改动。
3. 保持现有公共 API，除非任务明确要求迁移。
4. 完成后运行指定验证命令。
交付物：代码、测试、文档、变更摘要。
验收：<逐条可检查的条件>
不得声称：没有运行的测试、没有测量的性能、没有实现的安全能力。
```

### 12.2 解耦任务示例

```text
任务：拆分 RenderedPane 的编辑器持久化逻辑。
只允许修改：apps/desktop/src/view/RenderedPane.vue、apps/desktop/src/features/editor/、对应测试。
目标：将序列化、dirty 状态、save、autosave 和保存失败恢复提取到 editorPersistence.ts。
禁止：修改 MDX serializer 行为、修改 Rust command、改变用户可见按钮文案。
必须保持：保存成功/失败状态、关闭前保存、外部文件冲突流程、现有 undo 行为。
先检查：RenderedPane.test.ts、tabs store、fs gateway、RECOVERY.md。
测试：保存成功、保存失败、取消、重复保存、卸载取消、外部变化冲突。
验收：RenderedPane 不包含文件写入调用；异步保存任务可取消；测试和 typecheck 通过。
```

### 12.3 功能任务示例

```text
任务：增加表格 Tab 到末尾自动新增行。
只允许修改：packages/editor-core/src/table/ 及其测试。
必须保持：GFM 序列化、表头结构、撤销/重做、未知 MDX 占位符。
边界：仅当光标位于最后一行最后一个单元格且按 Tab 时新增一行；其他位置行为不变。
测试：普通 Tab、末尾 Tab、连续 Tab、只读文档、撤销新增行、合并单元格降级策略。
性能：单次命令 O(列数)，不得重新解析整篇文档。
```

### 12.4 审计任务示例

```text
任务：验证生产构建中的插件安全边界。
只读范围：plugin-host、desktop plugin service、tauri.conf.json、相关测试和构建产物。
检查：顶层代码执行时机、完整性校验、权限拒绝、CSP、blob URL、IPC 暴露面。
输出：按 P0/P1/P2 列出证据、文件行号、复现步骤、影响和建议；不要修改代码。
结论规则：没有真实构建或 E2E 证据时只能标记“未验证”，不能标记“已修复”。
```

## 13. 产品功能规格

### 13.1 文档打开与保存

文档会话至少包含：`vaultId`、`path`、`sourceText`、`editorState`、`lastSavedHash`、`dirty`、`saveState`、`externalVersion`。保存流程必须是：

1. 从编辑器状态生成候选源码。
2. serializer 失败时保留旧文件并显示错误。
3. 写入临时文件并 flush。
4. 原子替换目标文件。
5. 更新 `lastSavedHash`、历史快照和索引任务。
6. watcher 事件带来源标记，避免把自己的写入误判为外部冲突。

保存状态至少包括 `idle`、`dirty`、`saving`、`saved`、`failed`、`conflict`、`recoverable`。UI 不得只用布尔值表示所有状态。

### 13.2 外部修改与冲突

当 watcher 发现文件变化时：

- 若当前文档 clean，直接重新载入并刷新索引。
- 若 dirty 且文件 hash 与打开时不同，进入冲突状态。
- 冲突对话框必须提供保留本地、采用磁盘、查看 diff、另存副本四条路径。
- 任何自动选择策略必须有设置项和日志记录。
- 关闭窗口前冲突文档不能被静默覆盖。

### 13.3 搜索与索引

索引记录建议分为 metadata、body、links、tags、attachments 五个逻辑区。查询流程必须保证：metadata 快速过滤可以减少 I/O，但不能造成正文 false negative；最终候选仍需按索引或正文验证。

索引更新事件必须幂等：同一路径重复事件不会产生重复记录；删除事件必须清理反链和图谱边；旧 vault 的异步结果不得覆盖新 vault。所有截断必须返回结构化状态并在 UI 可见。

### 13.4 图谱

图谱输入是不可变快照，不直接读取 Vue store。构建、布局和渲染分为三个阶段：

1. 解析文档和链接，生成节点/边快照。
2. Worker 执行布局，支持取消和分块进度。
3. UI 只渲染当前快照，并根据筛选条件重新计算可见集合。

链接解析必须测试 root-relative、相对路径、扩展名、省略 index、同名目录和 `../`。图谱超过展示上限时，必须显示实际数量和截断原因。

### 13.5 图片

图片节点属性至少包含 `src`、`alt`、`title`、`width`、`align`、`link`、`originalWidth`。属性修改应通过单一 transaction 完成；拖动 resize 使用 begin/update/end 三阶段，只有 end 写入历史。

导入流程应接受 `FilePathSource`、`BlobSource` 和未来的 `StreamSource`，策略层负责大小、MIME、扩展名、命名冲突和 SVG 清洗。UI 不应知道 Base64 编码细节。

### 13.6 表格

表格命令必须是可组合的纯操作：`insertTable`、`addRow`、`deleteRow`、`addColumn`、`deleteColumn`、`toggleHeader`、`setColumnAlignment`。每个命令返回 transaction 或失败原因，不直接操作 DOM。

复杂能力要明确 Markdown 降级：合并单元格、公式和富文本内容若无法稳定序列化，应保留源码或提示用户切换 Source 模式，禁止生成不可逆格式。

## 14. 安全开发要求

每个涉及文件、插件、AI 或密钥的任务都要回答四个问题：

1. 不可信输入是什么？
2. 真正的执行边界在哪里？
3. 失败时是否会泄露数据或破坏旧数据？
4. 是否有负向测试证明拒绝路径？

安全变更必须包含威胁模型、允许列表、错误码、日志脱敏规则和回归测试。禁止用“前端按钮隐藏”“插件 manifest 声明权限”“TypeScript 类型约束”代替真正的 Rust/宿主边界。

## 15. 性能工程细则

性能问题按四类记录：CPU、内存、I/O、交互延迟。每类都要给出数据规模和上限：

- CPU：解析、序列化、索引、图布局的 p95 和最坏样本。
- 内存：打开文档、批量附件、图谱和索引重建峰值。
- I/O：单文件读取次数、写入次数、watcher 事件合并率。
- 交互：输入到 transaction、输入到渲染、搜索首结果和关闭保存耗时。

优化顺序：先消除重复工作，再做增量和缓存，再做并发，最后才考虑微优化。每个缓存必须说明 key、生命周期、失效事件、最大容量和淘汰策略。每个并发任务必须有取消、上限和 latest-wins 或队列语义。

## 16. 版本与文档维护

每个里程碑维护四份记录：

- `docs/dev.md`：目标、架构、任务和验收标准。
- `docs/SECURITY.md`：威胁模型、边界和安全限制。
- `docs/PERF.md`：场景、设备、数据和基准结果。
- `docs/RECOVERY.md`：保存、快照、回收、恢复和冲突流程。

当实现与文档不一致时，以代码和测试为证据修正文档；当安全或恢复行为没有测试时，只能写“设计目标”，不能写“已完成”。每次发布前检查：完成度表、已知限制、命令、目录树、性能数字和截图是否仍然有效。

## 17. 可直接执行的重构手册

本章把“建议拆分”转换为实际操作步骤。执行时一个任务对应一个 PR；不要把多个中心模块同时重构。所有路径以当前仓库为准，目标目录可以在迁移过程中调整，但依赖方向不能放宽。

### 17.1 开工前固定流程

每个重构任务开始前必须执行：

```bash
git status --short
rg "<旧模块名>|<旧导出名>" apps packages
pnpm typecheck
pnpm lint
```

然后在任务分支中创建四个清单：当前公共导出和调用方、当前测试和未覆盖行为、允许修改的文件、完成后的验证命令。如果基线测试已经失败，先记录失败，不要把基线问题混入重构提交。重构 PR 的第一原则是行为等价：新旧实现对同一输入产生相同的源码、错误码、事件和用户可见状态。

### 17.2 R1：拆分 App.vue

当前 `App.vue` 同时承担装配、布局和生命周期。按下面顺序操作：

1. 在 `src/app/types.ts` 定义 `AppDialogState` 联合类型，替代多个互相矛盾的 `showXxx` 布尔值。状态至少覆盖 `none`、`conflict`、`permission`、`integrity`、`recovery`。
2. 创建 `src/app/windowState.ts`，只负责窗口尺寸、位置和持久化，暴露 `loadWindowState`、`saveWindowState`、`subscribeWindowEvents`；不导入组件和 vault store。
3. 创建 `src/app/appBootstrap.ts`，按“设置 → gateway → 密钥会话 → 窗口 → tabs → vault → watcher/index”顺序初始化，并为每一步记录阶段错误。
4. 创建 `src/app/appLifecycle.ts`，封装启动、关闭前保存和销毁。`beforeClose` 必须幂等，保存失败必须返回 `cancel-close`。
5. 最后把 `App.vue` 简化为布局、组件组合、`provide(runtime)` 和生命周期 hook。

验收：`App.vue` 中没有 `invoke`、`listen`、路径拼接和索引遍历；全局对话框由一个联合状态驱动；测试可以传入 memory runtime；关闭请求重复触发只执行一次保存。

### 17.3 R2：拆分 RenderedPane.vue

按“读取 → 编辑 → 保存 → 外部同步 → 辅助 UI”五阶段拆分，不要一次搬走全部代码。

1. 定义 `DocumentSession`，集中 `vault`、`path`、`source`、`savedHash`、`dirty`、`mode` 和 `saveState`。组件不能再从多个 store 读取同一份文档内容。
2. 创建 `editorController.ts`，只暴露 `mount`、`replaceSource`、`dispatch`、`getSource`、`destroy`；禁止侧栏和插件直接获得 ProseMirror `EditorView`。
3. 创建 `editorPersistence.ts`，统一序列化、hash、save、autosave、取消和错误状态。保存队列采用 latest-wins，但当前磁盘写入完成前不得破坏写入原子性。
4. 创建 `editorExternalSync.ts`，只返回 `clean-reload`、`ignore-own-write`、`mark-conflict`、`file-deleted` 决策，不显示对话框。
5. 创建 `editorScrollSync.ts`、`editorSearchOverlay.ts` 和 `editorSelection.ts`，分别负责锚点同步、搜索/拼写覆盖层、图片/表格/浮动工具条选区。

验收：保存失败重试、关闭前保存、外部修改、外部删除、切换 tab、切换 vault、组件卸载取消监听均有测试；组件不直接持有文件写入逻辑；卸载后无 listener、worker 或 timer 泄漏。

### 17.4 R3：拆分 library.ts

把 `library.ts` 拆成状态和编排两部分，不能复制出多个事实来源：

- `vaultSessionStore`：当前 vault 和切换状态。
- `fileTreeStore`：文件树、排序、截断状态。
- `documentListStore`：笔记列表、标签、收藏和最近访问。
- `vaultSessionCoordinator`：打开、切换、关闭，拥有取消控制器。
- `fsChangeCoordinator`：watcher 事件去重、分类、排序。
- `indexCoordinator`：全量/增量索引、序号守卫、失败重建。
- `libraryQueries`：纯 selectors。
- `libraryPersistence`：只保存用户偏好和索引元数据。

切换 vault 的顺序必须固定：暂停入口 → 取消搜索 → 停止 watcher → flush dirty 文档 → dispose 旧 index/graph → 清空旧状态 → 创建新 session → 建 watcher → 索引 → 恢复入口。每一步失败都必须进入可解释的 `error` 或 `closed` 状态。

验收：store 不直接读文件内容；索引服务能在无 Vue 环境下由 memory gateway 驱动；两个 runtime 连续打开不同 vault 时没有旧事件和旧索引污染。

### 17.5 R4：统一 Gateway

先搜索所有直接平台调用：

```bash
rg -n "@tauri-apps/api|invoke\(|listen\(|localStorage|window\." apps/desktop/src
```

逐个调用标注所属端口：`FsPort`、`AiPort`、`KeyPort`、`EventPort`、`DialogPort`、`WindowPort`。业务层只依赖 port；Tauri adapter 负责参数转换和错误映射；memory adapter 必须可注入延迟、失败、取消、权限拒绝和事件。

将 `getGateways()` 的全局缓存收口到应用装配层，业务 service 使用 `createGateways(deps)` 注入实例。`ai.ts` 中直接使用的 Tauri `listen` 必须移动到 `TauriEventAdapter`。

验收：以下搜索结果只能出现在 infrastructure、bootstrap 和测试适配器中：

```bash
rg -n "@tauri-apps/api|invoke\(|listen\(" apps/desktop/src/features apps/desktop/src/services apps/desktop/src/stores
```

### 17.6 R5：拆分 Rust fs.rs

先按函数性质移动，不修改 command 名称、DTO 和错误码：

| 函数性质 | 目标 | 约束 |
|---|---|---|
| `#[command]` | `commands/` | 只做 DTO、service 调用、错误映射 |
| 路径校验 | `domain/path_policy.rs` | 无 I/O，纯函数 |
| 文件读写 | `storage/file_store.rs` | 只接收已验证 `VaultContext` |
| 原子写入/历史 | `storage/history_store.rs` | 临时文件、flush、rename、版本 |
| 回收站/恢复 | `storage/trash_store.rs`、`domain/recovery.rs` | 与普通删除分离 |
| 遍历/搜索 | `services/search_service.rs` | 明确深度、数量、截断结果 |
| 附件 | `services/attachment_service.rs` | MIME、大小、命名、流式接口 |

定义唯一入口：

```rust
pub struct VaultContext {
    pub id: VaultId,
    pub root: CanonicalPath,
}
```

`CanonicalPath` 只能由 `PathPolicy::resolve_inside_vault` 构造。所有 command 都必须拿到 `VaultContext` 后才能访问文件。每迁移一个领域，立即运行 `cargo fmt --check`、`cargo clippy -- -D warnings` 和 `cargo test`。

### 17.7 R6：拆分 keys.rs 与 ai.rs

`keys.rs` 拆为 `crypto/kdf.rs`、`crypto/keyfile.rs`、`crypto/session.rs`、`storage/secure_store.rs`、`commands/keys.rs`。分别测试 KDF 参数、密钥文件迁移、锁定/解锁、内存清理和命令错误映射。

`ai.rs` 拆为 provider trait、Gemini/OpenAI-compatible provider、request policy、并发 limiter、流式解析、取消和 `commands/ai.rs`。新增 provider 时不得改编辑器、聊天 UI 或密钥存储。日志不得包含 API key、Authorization header 或完整请求体。

## 18. 子代理执行规范

每个子代理只能领取一个主要任务。提示词必须包含：任务目标、允许修改的文件、禁止修改的文件、当前行为、设计约束、测试命令、交付格式和“不允许声称未验证能力”的规则。超出范围的问题只记录为新任务，不顺手修改。

通用模板：

```text
任务：<唯一任务 ID 和一句话目标>
范围：<允许修改的目录/文件>
禁止：<不允许修改的目录、API、格式和行为>
现状：<相关审计结论和现有测试>
步骤：先读实现和测试；先补失败路径测试；实现最小改动；运行验证。
验收：<逐条可检查条件>
交付：修改文件、测试名称、完整命令和关键输出、性能/安全影响、已知限制。
不得声称：没有运行的测试、没有测量的性能、没有实现的安全能力。
```

## 19. 详细验收报告模板

```text
任务：ARC-xx
修改文件：<逐个列出>
未修改但检查过的文件：<逐个列出>
行为变化：无 / <逐条说明>
新增测试：<名称、输入、预期、失败路径>
验证命令：<完整命令>
验证结果：<通过/失败，附关键输出>
性能影响：<数据规模、设备、p50/p95、峰值内存；未测量则写未测量>
安全影响：<边界变化、拒绝路径、日志脱敏>
已知限制：<明确列出>
后续任务：<issue 或任务 ID>
```

没有文件、命令和结果的“已完成”回复不能作为合并依据。
