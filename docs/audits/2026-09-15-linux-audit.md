# Linux 功能与数据一致性审计

日期：2026-09-15。代码基线：`b41b1be`，以本次实际读取的工作树为准。

本轮只审计、测试、撰写报告，不修改业务实现，不提交代码。排除 Windows 历史目录及依赖、构建产物。既有开发计划、AGENTS.md 和用户改动保持原样。本报告不是“项目没有其他缺陷”的证明，也不代表 Linux 原生发布验收已完成。

## 1. 结论与证据等级

发现 11 项有动态复现证据的问题，以及 1 项通过调用链确认、尚未完成真实传输复现的取消风险。优先处理文件覆盖和编辑丢失，再处理撤销隔离、附件迁移和 AI 请求生命周期。

- P1：可能丢失或覆盖用户正文，应先于发布处理。
- P2：明确功能错误、状态错误或恢复能力缺口。
- 浏览器复现：真实页面与编辑器运行，文件系统采用测试替身，不等同于原生桌面验证。
- 模块探针：执行当前实际 TypeScript 模块，注入可控 IO、时钟或事件边界，非另写一份业务算法。
- Rust 探针：调用当前构建产物，在独立测试目录操作合成文件，未操作用户笔记。
- 静态确认：调用链明确存在缺口，但不将推断的终端现象写成已实测结果。

## 2. 已执行测试

| 验证 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm test` | 3191 项通过，270 个测试文件 | editor-core 900、plugin-host 132、desktop 2159 |
| `pnpm typecheck` | 通过 | 本轮运行退出码 0 |
| `pnpm lint` | 通过 | 本轮运行退出码 0 |
| `pnpm build` | 通过 | 有大体积 chunk 警告，不等于构建失败 |
| Rust 默认测试 | 364 项通过，5 项默认忽略 | 按测试输出统计执行次数，包含不同测试目标，不声称全是唯一场景 |
| Rust 忽略的慢测试 | 额外 5 项全部通过 | 密钥轮换、备份密钥解锁与失败恢复，合成数据 |
| Chromium 全量 E2E | 154 项直接通过，1 项重试通过 | 共 155 项；不能描述成无波动全绿 |
| 设置动画重复测试 | 12 次通过 | 2 个匹配用例各重复 6 次，禁用重试 |
| `pnpm perf` | 6 项通过 | 算法/交互预算，不等同于原生连续帧率 |
| WebKit 定向 E2E | 42 项未能启动浏览器 | 缺少 `libicu74`、`libflite1`；不是 42 个应用断言失败 |

主要命令（除标注外在仓库根目录执行）：

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --offline --locked
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --offline --locked --test keys_test --test recovery_test -- --ignored --test-threads=2
```

以下在 `apps/desktop` 执行，使用项目的空闲端口包装脚本：

```bash
pnpm e2e
pnpm e2e e2e/motion-surfaces.spec.ts --grep 'settings dialog' --repeat-each=6 --workers=1 --retries=0
pnpm perf
pnpm e2e e2e/editor-input.spec.ts e2e/input-ime.spec.ts e2e/pane-handoff.spec.ts e2e/split-scroll.spec.ts e2e/table-resize-handle.spec.ts --browser=webkit --workers=2 --retries=0
```

本机测试日志：`/tmp/nekowite-audit-tests.log`、`/tmp/nekowite-audit-types.log`、`/tmp/nekowite-audit-lint.log`、`/tmp/nekowite-audit-build.log`、`/tmp/nekowite-audit-rust.log`、`/tmp/nekowite-audit-rust-slow.log`、`/tmp/nekowite-audit-e2e.log`、`/tmp/nekowite-audit-motion-repeat.log`、`/tmp/nekowite-audit-perf.log`、`/tmp/nekowite-audit-webkit.log`。临时日志不是长期 CI 产物，可能被系统清理。

## 3. 优先修复的问题

### L01 / P1：Linux 大小写重命名覆盖另一份现存文件

位置：`apps/desktop/src-tauri/src/storage/rename_store.rs:59`、`:61`、`:92`。

复现：在区分大小写的 Linux 文件系统中，同时创建 `note.md` 和 `Note.md`，内容不同；将前者重命名为后者。实际 Rust 调用返回 `Ok("Note.md")`，目标内容变为 `SOURCE`，源路径消失。原目标被替换。

原因：以小写字符串相等推断“只是更改大小写”，跳过目标占用检查，随后调用可覆盖目标的 `std::fs::rename`。这不是 Linux 文件身份判断。

修复方向：Linux 重命名必须保持不覆盖不变量；不能凭大小写折叠绕过冲突保护。目标检查与实际移动之间也必须考虑竞争。

回归要求：两个大小写不同的同名文件并存、目标在移动前被创建、普通重命名、无目标的大小写修改。失败后两份原始正文均须保留。

### L02 / P1：关闭保存期间新增的输入被丢弃

位置：`apps/desktop/src/stores/tab-lifecycle.ts:205`、`:209`、`:240`、`:256`。

模块复现：正文 `v1` 开始关闭，暂停文件写入；继续编辑成 `v2 NEW TEXT`；释放写入。结果为 `remainingTabs: 0, disk: "v1"`，新增内容无存留标签。

原因：`saveTab` 已能识别写入期间的新版本并保留 dirty，但 `closeTab` 只判断一次保存是否成功，不复核是否仍有未保存版本。批量关闭的 `flushDirty -> removeAllTabs` 有同类缺口。

修复方向：关闭门禁必须确认被关闭文档的最新编辑版本已落盘，或明确阻止关闭期间编辑；不能把“一次写入成功”当作“当前文档已全部保存”。

回归要求：延迟写入期间输入、重复关闭、关闭全部、保存失败；断言最新正文仍在内存或已写入磁盘。

### L03 / P1：打开文件时迟到的读取覆盖用户输入

位置：`apps/desktop/src/stores/tab-lifecycle.ts:137`、`:147`、`:149`。

模块复现：暂停 `files.read`；`openTab` 激活占位标签后输入 `USER TYPED`；再返回 `DISK BEFORE`。实际 content 与 savedContent 均成为磁盘旧内容。

UI 可达：`apps/desktop/src/ui/EditorPane.vue:154` 依据 activeTab 挂载编辑器，OpenTab 没有 loading 状态，`apps/desktop/src/view/SourcePane.vue:71` 可正常发布输入。

修复方向：加载状态必须明确。可在初次读取完成前禁止编辑，或以版本/加载票据保护提交；不能无条件覆写已经被用户编辑的占位文档。

回归要求：读取期间输入、读取失败、读取期间关闭、并发打开同一文件、切换仓库后旧读取返回。

### L04 / P1：渲染编辑后快速切换标签丢失尾部输入

位置：`apps/desktop/src/features/editor/controller/editor-persistence.ts:37`、`:117`；`apps/desktop/src/stores/tab-lifecycle.ts:94`；`apps/desktop/src/ui/TabBar.vue:102`。

浏览器复现：在第一篇渲染正文中将 `alpha` 编辑为 `aLOSTlpha`，立即切到第二篇，再返回。第一篇恢复成 `alpha\n`，dirty 仍为 true。

原因：渲染正文延迟 120ms 才序列化到标签状态；切换 activeId 没有先交付离开文档的编辑快照，下一篇重载编辑器后，旧输入失去来源。

修复方向：文档切换必须有交接边界，待发布内容绑定原文档 ID。先保留离开文档的实际编辑模型，再切换；不要通过延长 debounce 掩盖问题。

回归要求：输入后 0/50/119ms 切换，鼠标标签、键盘标签、新建/打开另一篇等入口分别覆盖；返回和落盘正文都要包含最后输入。

### L05 / P1：非活动标签忽略外部正文更新

位置：`apps/desktop/src/services/external-doc-sync.ts:100`、`:151`；`apps/desktop/src/stores/tab-lifecycle.ts:94`。

模块复现：A 活动、B 已打开，B 的 savedContent 为 `B before`；外部将 B 改为 `B external` 并发送 modified。服务读取了 B，但 reload 和 conflict 均未发生，B 仍持有 `B before`。

原因：所有标签的预检查只验证文件存在；真正的正文比较只处理活动标签。切回 B 仅改变 activeId，不补做磁盘同步。之后基于旧正文编辑并保存会覆盖外部版本。最后的覆盖后果由保存调用链确认，探针直接验证的是“事件被忽略、正文仍旧”。

修复方向：外部变更按路径处理所有已打开文档；干净标签可更新，脏标签保留本地正文并标记冲突。激活时补同步可以作为补救，但不能替代保存前的一致性策略。

回归要求：后台干净标签、后台脏标签、resync、切回后保存、目录级事件；不得静默覆盖外部正文。

### L06 / P2：内容相同的不同笔记共享渲染撤销历史

位置：`apps/desktop/src/features/editor/composables/use-rendered-editor-stack.ts:228`；`apps/desktop/src/features/editor/controller/editor-external-sync.ts:105`、`:149`。

浏览器复现：A 从 `alpha` 编辑为 `aXlpha`；B 原内容也是 `aXlpha`。切到 B 按 Ctrl+Z，B 变成 `alpha`，撤销了 A 的操作。

原因：监听与幂等条件只有正文，没有文档身份。不同标签文本相同时不会重新隔离编辑状态。

修复方向：状态边界至少包含 vault、文档 ID、格式。正文相等不代表文档相同；跨文档应隔离撤销栈、选择区及其他编辑状态。

回归要求：相同文本的 A/B 独立撤销和重做、两个空文档、同文本不同格式；当前已复现撤销泄漏，不把不同格式的潜在问题当作已复现。

### L07 / P2：多附件首次保存部分失败后无法重试恢复

位置：`apps/desktop/src/stores/tab-assets.ts:55`、`:58`、`:65`。

模块复现：`.tmp/a.png` 搬迁成功，`.tmp/b.png` 搬迁失败。正文仍引用两个旧地址。解除故障后重试，又从 a 开始，因为旧路径已不存在而失败，b 也无法继续。

实际状态：文件为 `.tmp/b.png` 与 `n_assets/a.png`，正文仍是 `.tmp` 引用，上层仍可保存正文，形成持久断图。

修复方向：逐项记录完成的移动与引用改写，或提供可靠回滚；重试必须幂等，不能从已不存在的旧源重新开始。允许正文先保存时也应保留可恢复迁移状态。

回归要求：至少两张图片，第二项失败后重试；同时覆盖重启恢复、目标占用、正文在迁移期间继续编辑。

### L08 / P2：重命名目录后子笔记历史不可见

位置：`apps/desktop/src-tauri/src/storage/rename_store.rs:120`；`apps/desktop/src-tauri/src/storage/metadata_store.rs:63`。

Rust 复现：给 `docs/a.md` 创建历史快照，将 docs 改为 archive；新路径历史条数为 0，旧路径仍为 1。

原因：历史按相对路径索引，rename 仅为单文件迁移历史键。历史数据没有被删除，但从重命名后的笔记无法访问。

修复方向：对子树元数据进行可恢复的映射迁移，或建立不依赖路径的稳定文档身份；迁移失败不能只静默忽略。

回归要求：多层目录、多文件历史、目标旧历史、部分迁移失败及恢复，确认快照内容和顺序不丢失。

### L09 / P2：AI 准备阶段可重复发送

位置：`apps/desktop/src/features/chat/composables/use-chat-commands.ts:100`、`:114`、`:149`、`:201`。

模块复现：延迟上下文构建并调用两次 send。两份准备流程同时存在，按钮仍可发送；随后产生 2 条用户消息、2 个 streaming 占位和 2 次 completion 启动。

原因：防重复锁只看 streaming，直到上下文和图片编码结束才设置它。第二次操作进入时第一份请求尚未占用锁。

修复方向：首次 await 前进入 preparing 状态，统一管理 preparing/streaming/cancelled/idle，冻结本次草稿和附件快照，在失败或取消时释放。

回归要求：双击、连续 Enter、慢图片编码、准备失败重试、准备时切会话/关闭面板。不能假定两次启动一定都已到达远端，发送次数应分层断言。

### L10 / P2：旧 AI 请求迟到失败会清除新请求监听器

位置：`apps/desktop/src/features/ai/services/ai-chat.ts:217`、`:230`、`:231`。

模块复现：启动 A，保持 completion 未结束；启动 B，成功注册其 4 个监听器；再让 A 迟到 reject。B 的活动监听器从 4 变为 0，并触发 A 的过期错误回调。

原因：正常事件检查 generation，异常 catch 却无条件调用全局 cleanupListeners，清理的已是新请求资源。

修复方向：监听器及 cleanup 归属于请求实例；异步成功和失败都校验请求身份。过期请求不得修改当前请求的 UI 状态。

回归要求：A 晚于 B 的成功注册而失败、监听注册阶段失败、取消后迟到错误；B 必须继续收到 chunk/done。

### L11 / P2：另一笔保存提前清除仍在写入的自身事件标记

位置：`apps/desktop/src/stores/self-writes.ts:80`、`:86`。

模块复现：为 A 登记带正文的写入标记；时钟推进 3000ms，A 本来仍识别为自身写入；为 B 调用 note 后，A 的识别结果变为 false。

原因：isSelfWrite 对带正文的在途写入不采用时间过期，但 note 调用的 prune 对所有标记统一使用 2000ms，违背其自身生命周期约定。

影响：慢保存期间启动另一笔保存，可能将自己的写盘事件误判为外部编辑，引发多余重载或冲突提示。探针验证的是标记提前失效，未将所有 UI 后果视为必然发生。

修复方向：只按时间清理 timed 标记；带正文的在途标记由 settle 结束。若同路径可并发，结束标记也需有操作身份。

回归要求：A 写入超过窗口后启动 B、A 成功/失败后的清理、真实外部不同内容、同路径重复操作。

## 4. 静态确认的风险

### L12 / P2：AI 停止操作未覆盖排队和等待响应头

位置：`apps/desktop/src-tauri/src/commands/ai.rs:111`；`apps/desktop/src-tauri/src/providers/ai/limits.rs:167`；`apps/desktop/src-tauri/src/providers/ai/client.rs:141`、`:192`。

并发槽等待和 `request.send().await` 没有与 cancel token 竞争，只有收到响应后读取流的循环执行取消选择。排队时取消的任务仍可能取得槽并发送；已经发出但尚未收到响应头的请求不会因 token 被立即终止。

这项已核对代码调用链，但未运行真实延迟传输端到端复现；不声称已测量取消耗时或远端费用。

修复方向：取消覆盖队列等待、发送/响应头、错误正文读取和流式正文等完整生命周期，进入新阶段前也检查取消状态。

回归要求：用受控本地测试服务器分别延迟响应头和正文；填满并发槽后取消排队项，断言该请求未发出、槽位及时释放、没有过期错误通知。

## 5. 动画、性能与原生验证缺口

1. `apps/desktop/e2e/motion-surfaces.spec.ts:329` 首轮动画采样断言失败，重试通过；独立重复 6 轮的两个设置动画用例共 12 次通过。暂列测试稳定性疑点，不据此断言产品动画必然有 bug。应检查采样是否受并发负载和帧调度影响。
2. Chromium E2E 并不代表 Tauri 的 Linux WebKitGTK。WebKit 定向验证被系统依赖阻挡，本轮未安装系统包；原生输入法、焦点、选择区、剪贴板及窗口行为仍需验证。
3. 性能用例通过不代表滚动始终 60/120fps。原生环境仍应测长文、表格、图片混排时的帧耗时、长任务、布局次数和输入延迟，并记录机器、显示刷新率和缩放。
4. 构建存在较大 chunk 警告，应另测冷启动、首次打开数学编辑器和内存占用，再决定懒加载；不能仅凭体积把模块判为功能 bug。
5. 本轮没有完成 AppImage/deb/rpm 安装、真实桌面端到端或所有外部服务联调。不得将当前结果当作发布认证。

## 6. 开发交接顺序

建议拆为相互明确隔离的工作包，不按“一个代理修一个报错点”分割共享状态：

| 工作包 | 对应问题 | 所有权与验收 |
| --- | --- | --- |
| Linux 文件事务 | L01、L08 | Rust 文件/元数据移动，验证不覆盖与历史可访问 |
| 文档生命周期 | L02、L03、L04、L06 | 一个负责人统筹标签、编辑模型与序列化交接，避免互相修改同一状态协议 |
| 外部更新一致性 | L05、L11 | 按文档版本处理事件，覆盖多标签与慢 IO |
| 附件迁移恢复 | L07 | 独立迁移状态与幂等重试，不能覆盖正文更新 |
| AI 请求状态 | L09、L10、L12 | 前后端统一取消及资源所有权，各阶段错误和过期结果都可测 |

每个工作包先提交能够稳定失败的回归测试，再实现修复；模块测试通过后补真实入口 E2E，最后运行全量测试、类型检查、lint 和构建。保持单一目的提交，不借修 bug 进行大面积格式化。

子代理只能修改任务明确授权的实现及测试文件。禁止修改、覆盖、删除本报告、AGENTS.md、已有开发路线图、设计规格和实施计划；报告更新仅由主代理在用户授权范围内进行。
