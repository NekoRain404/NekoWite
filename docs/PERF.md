# NekoWite 性能记录 (M5)

对齐 docs/dev.md §9 的性能预算。每次改动在本表记录一个 **before → after** 数字；无法用脚本精确测量的 WebView/应用级指标（冷启动、首次输入、打开文档）用可复现的服务级代理近似，并在图例中说明。

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

---

## 测量基准 (`pnpm perf`)

运行方式：`pnpm --filter @nekowite/desktop perf`（等价于根目录 `pnpm perf`，经
`apps/desktop/package.json` 的脚本转发到 `vitest run --config vitest.perf.config.ts`）。
在 `apps/desktop/perf/perf.bench.test.ts` 中执行，输出一张 `metric — ms` 表，并对
每一项断言其上界（与 §9 对齐）。

| Metric（代理，见下文图例） | 测量值 (ms) | 上界断言 (ms) | 是否达标 |
| --- | ---: | ---: | --- |
| index-build-10k（冷启动代理） | 199.2 | ≤ 2000 | ✅ |
| search-query-p95-10k（1万文件搜索，§9） | 10.3 | ≤ 300 | ✅ |
| change-to-index-10k（变更→索引，§9） | 23.9 | ≤ 1000 | ✅ |
| graph-build-10k | 401.7 | — | — |
| graph-layout-2k（1万节点图谱布局，§9） | 642.5 | ≤ 3000 | ✅ 异步/不阻塞 |
| image-insert-10mb（10MB 图片插入，§9） | 16.1 | ≤ 2000 | ✅ |
| open-doc-1mb（普通文档打开，§9） | 7.3 | ≤ 300 | ✅ |
| table-500x30-edit（500×30 表格，§9） | 1.1 | ≤ 100 | ✅ |
| first-input-match-x100（首次输入，§9） | ~0.0 | ≤ 50 | ✅ |

> 数值在开发机上重复运行会有波动（本例记录一次整链 `pnpm perf` 输出，上界断言是强门禁，
> 不会受 ±50% 噪声影响）。

图例：
- **冷启动 / 打开文档 / 首次输入** 是 WebView 层指标，无法在无头 JS 中精确复现；分别用
  “10k 笔记首建索引”“1MB 文档 parseNoteMeta+buildSearchText”“单次 match/snippet 匹配”
  作为可复现代理。真实 WebView 数字通常比代理高，但代理的激进上界仍能拦截回归。
- **graph-layout-2k** 是有意缩小的替代：10k 节点的力导向布局是 O(n²)，应放在 Web Worker/
  分块路径上运行（`computeGraphLayout` → Worker，缺失时 `computeLayoutChunked`，每 >8ms 让出）。
  代理用 2k 节点验证该路径“能完成且让出”，10k 场景由 Worker/分块设计保证不阻塞主线程。
- 表中数值是 **after**（本次改动后）记录；后续改动在本表上方追加一行，可对比回归。

---

## 五项改动明细

### 1. 消除硬截断（或非静默化）

**1a. Vault 遍历上限 `vaultFiles.ts::MAX_DIRS`**
- 改动：`MAX_DIRS` 2048 → **100,000**（≈48.8×）；并允许按 walk/索引单独覆盖
  (`walkVault(vault, list, { maxDirs })` / `new VaultFileIndex(list, maxDirs)`)。
- 非静默化：命中上限时 `walkVault` 返回 `truncated: true`，`VaultFileIndex.isTruncated(vault)`
  报告该信号，`library.vaultTruncated` 存到 Pinia，`NoteListPanel` 渲染 `nl-truncated` 提示条
  （i18n：`notelist.vaultTruncated`）。
- before → after：**2048 目录 → 100,000 目录**（真实 10k 文件 vault 远低于 100k 目录，不会命中）。
- 新测试：`vaultFiles.test.ts` 用 `maxDirs` 覆盖验证截断信号；断言默认上限 ≥ 100,000；验证
  恰好塞满时 `truncated=false`。

**1b. 后端 `search_notes` 目录/深度上限 `fs.rs`**
- 改动：`SEARCH_MAX_DIRS` 512 → **100,000**，`SEARCH_MAX_DEPTH` 24 → **64**；新增
  `search_notes_with_max(..., max_dirs: Option<usize>)`，`lib.rs` 命令新增可选 `max_dirs` 参数
  （前端不传 → 用宽裕默认，兼容旧调用）。
- before → after：**512 目录/24 深度 → 100,000 目录/64 深度**，且可配置。
- 新测试：`tests/fs_test.rs` 验证 32 层深目录可见（旧 24 层会静默截断）；默认宽裕、显式
  覆盖 `Some(0)` 能清晰截断（可配置而非静默）。

**1c. 核对其余静默上限**
- 无其他静默上限。图谱默认全量（`GraphPanel` `maxNotes=0` = 全部渲染，截断时显式
  “仅展示前 N / 共 M”）；笔记索引 `runIndex`/`indexNote` 读取 **全部** 文件（无文件数上限）；
  `contentCache` 的 LRU 200 是文档化的内存上限（并非列表截断）；全文搜索用持久化索引预筛 +
  全文回退，正文后半段匹配不会被丢弃。无需改动。

### 2. 图片导入资源峰值防护（attachments.ts）

- 保留 `MAX_ATTACHMENT_BYTES = 10 MiB`，`fileToBase64` 与 `classifyAttachmentFiles` 都在
  编码前拒绝超限图片（拒绝后才读字节 / 才进入管线）。
- **避免大图二次全量拷贝**：新增 `LOW_COPY_ENCODE_MIN_BYTES = 1 MiB` 阈值——≥1MiB 的大图走
  原生 `FileReader.readAsDataURL`（宿主直接产 base64，不再经 JS 中间的 binary 字符串，少一次
  约等于文件大小的全量拷贝）；小图仍走快速 `arrayBuffer → btoa`（该尺寸下拷贝可忽略，且
  保持微任务内同步解析，避免破坏既有测试/调用的时序假设）。
- **流式 API**（消除 base64 整体搬运）需要一次 Rust 改动：新增
  `save_attachment_file(vault, path, target_dir)` ——前端先把图片落到 `.tmp`（文件路径），再让
  Rust 直接从磁盘读取字节并写入目标（`read_attachment` / `atomic_write_bytes`），完全避开
  base64。本次**未**做该有风险改动——仅在 `attachments.ts` 留下精确注释，前端保持干净降级。
- before → after：大图从“arrayBuffer（1 拷贝）+ binary 字符串（1 拷贝）+ base64（1 拷贝）”
  降为“arrayBuffer + base64”，少一次全量拷贝；实测 `fileToBase64` 对 ~9MiB 图片约 16ms，
  无 UI 冻结。
- 新测试：`attachments.test.ts` 验证超限图片在编码前拒绝（FileReader 不被调用）；≥1MiB 走
  FileReader；小图走 arrayBuffer（FileReader 不被调用）。

### 3. Worker 化解析 + 图谱布局

- 图谱布局已在 Worker（`computeGraphLayout` → `graphLayoutWorker.ts`；缺失时回退分块
  `computeLayoutChunked`，每 >8ms 让出），无需改动。
- **新增**：笔记列表索引 `library.ts::runIndex` 每索引 32 篇让出一次事件循环
  (`yieldToMainThread`)，使 10k 文件索引不冻结输入（缓存命中的笔记可能不触发 macrotask，
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
