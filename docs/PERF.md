# NekoWite 性能记录 (M5)

对齐 docs/dev.md 的性能预算（本节一直写作「§9」，那个编号对不上现行文档——见下表后的校正注）。每次改动在本表记录一个 **before → after** 数字；无法用脚本精确测量的 WebView/应用级指标（冷启动、首次输入、打开文档）用可复现的服务级代理近似，并在图例中说明。

预算（§9）：

| 指标 | 目标 |
| --- | --- |
| 冷启动到可编辑 | 中端设备 ≤ 2s |
| 首次输入响应 | P95 ≤ 50ms |
| 普通文档打开 | ≤ 300ms |
| 1万文件搜索 | 首次索引后 P95 ≤ 300ms |
| 文件变更到索引完成 | P95 ≤ 1s |
| 1万节点图谱 | 不阻塞输入，布局异步 |
| 10MB 图片插入 | 不发生明显 UI 冻结 |
| 500×30 表格编辑 | 输入响应 P95 ≤ 100ms |

> **这份「§9」的出处对不上任何现行文档（2026-09-15 核）**：`docs/dev.md` 的性能预算是 **§8**（§9 是
> 「标准开发流程」），路线图的 §9 是「Linux 验证和发布」，两份都不含上表的全部行。dev.md §8 与本表
> 有三行数字不一致（普通文档打开 **150** vs 300ms、搜索 p95 **100** vs 300ms、增量索引响应 **100ms**
> vs 1s），而 **「500×30 表格编辑」这一行只存在于本文件**。本表按原样保留——它是本文件自己声明的
> 目标，改数字等于替人定预算——但引用和数字需要一次决定，见下面的「两行重定向」。

---

## 测量基准 (`pnpm perf`)

运行方式：`pnpm --filter @nekowite/desktop perf`（等价于根目录 `pnpm perf`，经
`apps/desktop/package.json` 的脚本转发到 `vitest run --config vitest.perf.config.ts`）。
在 `apps/desktop/perf/perf.bench.test.ts` 中执行，输出一张 `metric — ms` 表，并对
每一项断言其上界（除 `graph-build-10k` 与 `search-broad-10k`——两者都只记录，理由在各自
那一行的注解里）。

| Metric（代理，见下文图例） | 测量值 (ms) | 上界断言 (ms) | 是否达标 |
| --- | ---: | ---: | --- |
| index-build-10k（冷启动代理） | 199.2 | ≤ 2000 | ✅ |
| search-query-p95-10k（1万文件搜索，§9） | 10.3 | ≤ 300 | ✅ |
| change-to-index-10k（变更→索引，§9） | 23.9 | ≤ 1000 | ✅ |
| graph-build-10k | 401.7 | — | — |
| graph-layout-2k（1万节点图谱布局，§9） | 642.5 | ≤ 3000 | ✅ 异步/不阻塞 |
| image-insert-10mb（10MB 图片插入，§9） | 16.1 | ≤ 2000 | ✅ |
| open-doc-1mb（普通文档打开，§9） | 7.3 | ≤ 300 | ✅ |
| search-keystroke-10k（首次输入，§9；p50 / p95 / max） | 3.1 / 6.8 / 8.6 | ≤ 50（p95） | ✅ |
| search-broad-10k（同一个按键，索引跳不掉任何一篇） | 24.5 / 48.7 / 49.5 | 无断言（见下） | ⚠️ 贴预算 |
| table-500x30-save-escape（500×30 表格保存时的逐格转义；p50 / p95 / max） | 1.8 / 5.0 / 5.0 | ≤ 50（p95） | ✅ |

> 数值在开发机上重复运行会有波动（本例记录一次整链 `pnpm perf` 输出，上界断言是强门禁，
> 不会受 ±50% 噪声影响）。
>
> **上面两行在 2026-09-15 换掉了它们测的东西**，第三行是那一轮新加的记录项：原先的
> `table-500x30-edit` 和 `first-input-match-x100` 量的都不是应用代码（一次 `String.split`、
> 一次 `toLowerCase().includes`），预算比实测高约 50 000 倍却在本表里读作覆盖。详见下面的
> 「两行重定向（2026-09-15）」。旧行那一轮（2026-09-13）的记录见下方补记。

> **补记（2026-09-13）**：`index-build-10k` 一行的上界此前只是**记录**、没有断言——表里写着
> ≤2000 但代码里没有对应的 `expect`，也就是说冷启动代理退十倍也只会让表格里的数字变大。
> 现在补上断言（≤2000ms，与 §9 的 2s 一致）。同一轮实测（较慢的开发机）：
> index-build-10k 1010.3、search-query-p95-10k 6.6、change-to-index-10k 8.5、graph-build-10k 504.0、
> graph-layout-2k 676.2、image-insert-10mb 33.9、open-doc-1mb 2.5、table-500x30-edit 0.6、
> first-input-match-x100 0.0——全部在预算内。（最后两个 metric 名是当时的旧行，2026-09-15 被
> `table-500x30-save-escape` / `search-keystroke-10k` 取代，它们的 0.6/0.0 正是「量的不是应用
> 代码」的表现。）

图例：
- **冷启动 / 打开文档 / 首次输入** 是 WebView 层指标，无法在无头 JS 中精确复现；分别用
  “10k 笔记首建索引”“1MB 文档 parseNoteMeta+buildSearchText”“一次内容搜索按键
  （`services/content-search.ts` 的 `searchWithIndex`）”作为可复现代理。真实 WebView 数字通常
  比代理高（正文要从缓存/磁盘来，不在代理里），但代理的激进上界仍能拦截回归。
- **graph-layout-2k** 是有意缩小的替代：10k 节点的力导向布局是 O(n²)，应放在 Web Worker/
  分块路径上运行（`computeGraphLayout` → Worker，缺失时 `computeLayoutChunked`，每 >8ms 让出）。
  代理用 2k 节点验证该路径“能完成且让出”，10k 场景由 Worker/分块设计保证不阻塞主线程。
- 表中数值是 **after**（本次改动后）记录；后续改动在本表上方追加一行，可对比回归。

---

## 两行重定向（2026-09-15）

**原来那两行量的不是应用代码**：`table-500x30-edit` 计时的是 harness 刚拼出来的字符串上的一次
`split('\n')`/`split('|')`，`first-input-match-x100` 量的是 `content.toLowerCase().includes(...)`。
两行的预算因此比实测高约 **50 000 倍**，而本表把它们读作覆盖。**两行都改指真实代码，都不删**——
删掉等于静默移除本文件已经声明过的覆盖。

### `search-keystroke-10k`（原 `first-input-match-x100`）——预算 ≤ 50ms 保持不变

- **量什么**：`services/content-search.ts` 的 `searchWithIndex(...)` 一次调用，10 000 篇候选、
  索引条目全部 `upToDate`（正文从 Map 来，即缓存命中；磁盘那一半不在无头进程里）。40 个查询、
  3 次预热不计，记 p50/p95/max，断言 **p95 ≤ 50ms**。查询是用户正在打的词：`token 7` 也命中
  `token 70`…，于是 10k 里约 **1.1k 篇读正文、约 9k 篇被索引闸门跳过**，两半路径都走到了。
- **为什么预算不动**：≤50ms 是 §9 记在「首次输入响应」上的数，也正是这一行本来要代理的东西；
  改的是被量的代码，不是预算。
- **实测**：p50 **2.1–8.3ms**、p95 **4.4–10.0ms**、max **6.7–10.9ms**（整链 5 次）；单独探针
  （10k 候选、40 查询）另得 p50 4.9–10.8 / p95 **11.1–18.1** / max 11.5–25.5ms。
- **余量**：按最慢的一组（探针 p95 18.1ms）算 **2.8 倍**，按整链最坏（10.0ms）算 **5.0 倍**。
  也就是说这一行现在会在真实路径**退化 2.8–5.0 倍**时失败，而不是 50 000 倍。
- **另加一条按篇数、不按时间的断言**：一次按键读正文的篇数 ≤ 候选数的一半。索引闸门的失效
  （`upToDate` 不再被采信 → 每篇都读）**在延迟上只值约 2 倍**（探针：5.4 → 10.2ms），
  计时门抓不住它；篇数是确定性的，抓得住。

### `search-broad-10k`——只记录、不断言，因为它是一个发现

- 同一个按键，但查询是**整库都命中**的词（`quick brown fox`，10 000/10 000），索引**跳不掉任何
  一篇**，每篇都要读正文再抽 snippet。实测 p50 **14.8–25.0ms**、p95 **23.8–48.7ms**、
  max 最高 **49.5ms**（整链 5 次）；探针那一组：p95 28.1–**51.0ms**、max 最高 **51.6ms**。
  **10 次记录里有 1 次 p95 与 1 次 max 越过 50ms**——§9 那条 ≤50ms 的「首次输入」预算，
  在这个形状上**已经贴住、偶尔越过**。
- **为什么不给它加断言**：把 p95 ≤50 钉在它上面，就是一条在忙机器上会红的门（本机负载见下，
  同一份代码轮次之间差 2 倍）；把预算放宽到它能过，又会放过真正要抓的形状。所以这一行
  **只记录，并把数字摆进上表**，与 `graph-build-10k` 的「—」同一做法：它是一个待决的数，
  不是一条已满足的门。

### `table-500x30-save-escape`（原 `table-500x30-edit`）——新上界 ≤ 50ms

- **量什么**：同一张 500×30 表在**保存路径**上的逐格转义——`escapeUnescapedPipes`
  （`packages/editor-core/src/table/stringify.ts`，序列化器每格调一次）对 `split('|')` 出来的
  **16 064 个片段**（502 行 × 32 段）各调一次，预热 5 次后取 20 次的 p50/p95/max，断言 **p95 ≤ 50ms**。
- **为什么是 50 而不是沿用 100ms**：100ms 属于这一行原来的主张（「表格编辑输入响应」），
  而那个主张经真实路径测出来够不到（见下），接着用等于把旧主张的预算挂在新测量上。上界按实测
  重新定：实测 p50 **1.0–1.9ms**、p95 **3.8–6.2ms**（9 组里的最坏 p95 = 6.2ms），
  **50ms ≈ 最坏 p95 的 8 倍、中位数的 27 倍**。取 50 而不是更低，是因为本文件自己记过 5 倍的
  机器差（index-build 199 → 1010）：把最坏 p95 乘 5 是 31ms，仍然过得去（1.6 倍），
  再往下压就会在慢机器上红。
- **它抓什么**：逐字符扫描被换成每格一次 `replace`/正则/`[...str].map().join('')` 之类的重写。
  **校准过**：正则 3.5–4.7ms、`split`/`join` 3.0ms、`spread`/`map` 4.3ms——**都只有 2–3 倍**。
  所以这条门抓的是 **≥8 倍**的退化（按最坏 p95 算；按中位数是 27 倍），**换一种写法的 2–3 倍
  它抓不住**——这是它现在的能力边界，不要读成更多。

### 表格预算：3.9–5.6 秒，和这条门够不到的那个数

- **本文件的「500×30 表格编辑 输入响应 P95 ≤ 100ms」经真实路径不成立**：`createEditor` +
  `open(500×30 表格)` ≈ **3.9–5.6 秒**、`save()` ≈ **3.6–3.8 秒**（128KB markdown，在
  `MAX_RENDERABLE_CHARACTERS` 之内，即应用真的会去打开它）——超预算 **40–56 倍**。成本在
  remark 解析 / Milkdown 序列化，也就是 `packages/editor-core/src/open-budget.ts` 记的
  「不是本仓库能定」的那部分。
- 所以这一行现在量的是保存路径上属于本仓库的那一小段（逐格转义），**不是**那个 100ms 主张。
  **100ms 与 4 秒之间的差距是待决事项，不是已修好**：四秒对一个 15 000 格的表格是否可接受，
  得有人定，然后 §9 那一行（或 `open-budget.ts` 的边界）按决定改。

### 测量条件（数字的来历）

- **机器**：16 核 Linux（`Linux 7.2.4-zen2-1-zen`）；**测量期间负载 ~9–10**——用户正在用这个应用，
  另有若干代理共用这台机器。同一份代码轮次之间可以差 2 倍（broad p95 一轮 24.3ms、下一轮
  48.7ms），**这个差是机器，不是代码**。
- **方式**：`pnpm --filter @nekowite/desktop perf`（= `vitest run --config vitest.perf.config.ts`，
  happy-dom）；数值是 `performance.now()` 墙钟，非 CPU 时间。整链 5 次 + 单独探针 5 次，
  探针已删除、不在 diff 里。
- **余量一律按 p95 说**（与 §9 的措辞一致），p50/max 一并记进表里——只看一个统计量会藏住尾部。

---

## 五项改动明细

> **路径校正（2026-09-15）**：本节写在当时，之后仓库拆过几轮，下面提到的若干路径已经不是原来的
> 那个（旧名在前）：`vaultFiles.ts` → `services/vault-files.ts`；`services/contentSearch.ts` →
> `services/content-search.ts`；`services/attachments.ts` → 现在是**兼容 barrel**，实现在
> `features/attachments/services/`（`attachment-library.ts` / `attachment-import.ts`）；
> `library.ts::runIndex` → `features/vault/services/vault-index.ts::runIndex`，让出循环本身在
> `features/vault/services/vault-note-index.ts`（`INDEX_YIELD_EVERY = 32`）；
> `graphLayoutWorker.ts` → `services/graph-layout-worker.ts`；`library.vaultTruncated` 所在的
> store 现在是 `stores/file-tree.ts`（`useFileTreeStore`，id 为 `fileTree`），提示条由
> `features/notes/components/NoteListToolbar.vue` 渲染而不是 `NoteListPanel`。
> 下表已按现行路径更新；`pnpm perf`（§4）与 `vitest.perf.config.ts` 未变。

### 1. 消除硬截断（或非静默化）

**1a. Vault 遍历上限 `services/vault-files.ts::MAX_DIRS`**
- 改动：`MAX_DIRS` 2048 → **100,000**（≈48.8×）；并允许按 walk/索引单独覆盖
  (`walkVault(vault, list, { maxDirs })` / `new VaultFileIndex(list, maxDirs)`)。
- 非静默化：命中上限时 `walkVault` 返回 `truncated: true`，`VaultFileIndex.isTruncated(vault)`
  报告该信号，`useFileTreeStore().vaultTruncated` 存到 Pinia，`NoteListToolbar.vue` 渲染
  `nl-truncated` 提示条（i18n：`notelist.vaultTruncated`）。
- before → after：**2048 目录 → 100,000 目录**（真实 10k 文件 vault 远低于 100k 目录，不会命中）。
- 新测试：`services/vault-files.test.ts` 用 `maxDirs` 覆盖验证截断信号；断言默认上限 ≥ 100,000；
  验证恰好塞满时 `truncated=false`。

**1b. 后端 `search_notes`：先放宽上限，后整体删除**
- 当年改的是上限：`SEARCH_MAX_DIRS` 512 → **100,000**，`SEARCH_MAX_DEPTH` 24 → **64**，并加了
  可选的 `max_dirs` 覆盖。
- 后来发现**整条链路都没有调用方**：前端从某次改动起改用前端索引 + 逐篇读取的内容搜索
  （`services/content-search.ts` 的 `searchWithIndex`，覆盖正文而不只是文件名），`search_notes`
  只剩下测试在引它。既然它比在用的那条更弱、又没有任何消费者，本轮**整体删除**：Rust 命令
  与注册、`storage::file_store` 的 `search_notes`/`_with_max`/`_capped`/`walk_search` 与两个
  上限常量、`FsPort.searchNotes` 契约、Tauri/内存两个适配器、以及只测它的 3 个用例（Rust
  `fs_test.rs` 68 passed）。「路径搜索」这一能力由前端内容搜索完全覆盖。

**1c. 核对其余静默上限**
- 无其他静默上限。图谱默认全量（`GraphPanel` `maxNotes=0` = 全部渲染，截断时显式
  “仅展示前 N / 共 M”）；笔记索引 `runIndex`/`indexNote` 读取 **全部** 文件（无文件数上限）；
  `contentCache` 的 LRU 200 是文档化的内存上限（并非列表截断）；全文搜索用持久化索引预筛 +
  全文回退，正文后半段匹配不会被丢弃。无需改动。

### 2. 图片导入资源峰值防护（`features/attachments/services/attachment-library.ts`；写这段时是 `services/attachments.ts`）

- 保留 `MAX_ATTACHMENT_BYTES = 10 MiB`，`fileToBase64` 与 `classifyAttachmentFiles` 都在
  编码前拒绝超限图片（拒绝后才读字节 / 才进入管线）。
- **避免大图二次全量拷贝**：新增 `LOW_COPY_ENCODE_MIN_BYTES = 1 MiB` 阈值——≥1MiB 的大图走
  原生 `FileReader.readAsDataURL`（宿主直接产 base64，不再经 JS 中间的 binary 字符串，少一次
  约等于文件大小的全量拷贝）；小图仍走快速 `arrayBuffer → btoa`（该尺寸下拷贝可忽略，且
  保持微任务内同步解析，避免破坏既有测试/调用的时序假设）。
- **流式 API**（消除 base64 整体搬运）需要一次 Rust 改动：新增
  `save_attachment_file(vault, path, target_dir)` ——前端先把图片落到 `.tmp`（文件路径），再让
  Rust 直接从磁盘读取字节并写入目标（`read_attachment` / `atomic_write_bytes`），完全避开
  base64。本次**未**做该有风险改动——仅在附件模块里留下精确注释，前端保持干净降级。
  （`save_attachment_file` 至今仍未落地：全仓库没有这个名字。）
- before → after：大图从“arrayBuffer（1 拷贝）+ binary 字符串（1 拷贝）+ base64（1 拷贝）”
  降为“arrayBuffer + base64”，少一次全量拷贝；实测 `fileToBase64` 对 ~9MiB 图片约 16ms，
  无 UI 冻结。
- 新测试（当时在 `attachments.test.ts`，现在按行为分在两个文件里）：
  `features/attachments/services/attachment-import.test.ts` 验证超限图片在编码前拒绝；
  `attachment-library.test.ts` 验证 ≥1MiB 走 FileReader、小图走 arrayBuffer
  （两条都断言 FileReader 是否被调用）。

### 3. Worker 化解析 + 图谱布局

- 图谱布局已在 Worker（`computeGraphLayout`（`services/graph-layout-client.ts`）→
  `services/graph-layout-worker.ts`；缺失时回退分块 `services/link-graph.ts` 的
  `computeLayoutChunked`，每 >8ms 让出），无需改动。
- **新增**：笔记列表索引 `features/vault/services/vault-index.ts::runIndex` 每索引 32 篇让出一次
  事件循环 (`yieldToMainThread`，循环本体在 `features/vault/services/vault-note-index.ts`，
  常量为 `INDEX_YIELD_EVERY`)，使 10k 文件索引不冻结输入（缓存命中的笔记可能不触发 macrotask，
  显式周期让出兜底）。索引构建已按并发上限（列表 8 / 图谱读 8 / 索引 build 4）且每 25 篇让出。
- before → after：列表索引从“可能长队列占用主线程”变为“每 32 篇让出”；10k 索引 144.6ms，
  可交互。

### 4. 性能基准植入

- 新增 `apps/desktop/perf/perf.bench.test.ts` + `perf/perf.setup.ts` +
  `vitest.perf.config.ts`；根/桌面脚本 `pnpm perf` 运行，断言 §9 上界。CI 可用
  `pnpm --filter @nekowite/desktop perf` 作为门禁；其为独立 vitest 配置，不进入常规
  `pnpm test` 主套件（CI 慢时可为注释跳过的选项）。
- 本文件作为基准记录；后续每次改动在表格上方追加一行 before/after。

### 5. 回归验证

- `pnpm -r typecheck`（clean）、`pnpm -r lint`（0/0）、`pnpm -r test`（editor-core 259、
  plugin-host 49、desktop 776 = 769 基线 + 7 新测试）、`cd apps/desktop && pnpm exec playwright test`
  （4/4）、`cd apps/desktop/src-tauri && cargo test`（42+8+4 等全部通过，0 警告）。
- 新增/更新测试：vault 遍历截断“表面化+抬起”、后端 search 可配置/不静默、图片导入编码前
  拒绝、perf 上界断言（各 harness 用例内 `expect`）。
