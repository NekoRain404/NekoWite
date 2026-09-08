# NekoWite v1.2 引用管理 Design

- 日期：2026-08-29
- 状态：已确认
- 前置：v1.0（编辑器内核/侧栏/三态视图）+ v1.1（数学，已合并至 master）

## 1. 目标

导入 `.bib` / `.ris` / CSL-JSON 参考文献文件，侧栏搜索引用并按 `[@citekey]`（Pandoc 语法）插入到文档；WYSIWYG 视图中自动编号 `[1]` `[2]`…（按文档内首次出现顺序）；侧栏展示与文档编号一致的参考文献列表，供 v1.3 导出复用。

## 2. 技术选型

| 项 | 选型 | 理由 |
|---|---|---|
| 引用解析 | **Citation.js**（`@citation-js/core` + `plugin-bibtex` / `plugin-ris` / `plugin-csl`） | 一个库原生支持三种格式；业界标准；纯 JS 可跑在 WebView |
| 引用节点 | editor-core Milkdown `$node`（`cite`，inline，attrs `{ key }`） | 与 math/mdx 节点一致的自定义节点模式 |
| `[@key]` 解析 | 自写 remark 预处理（复用 `mdxJsxRemark` 的 `$remark` 模式） | 不依赖 remark-citation 的版本兼容；解析可靠可控 |
| 存储/搜索 | app 层 Pinia `refs` store | 编辑器内核与引用数据解耦；引用是应用级功能 |

## 3. 核心设计

### 3.1 引用解析与服务（app 层）

- `apps/desktop/src/services/refs.ts`：
  - `parseRefs(text: string, format: 'bib' | 'ris' | 'csl'): Reference[]` —— 包一层 Citation.js。
  - `Reference = { key: string; title: string; authors: string[]; year: string; type: string }`
  - `detectFormat(filename: string): 'bib' | 'ris' | 'csl' | null`（按扩展名 `.bib`/`.ris`/`.json`+CSL 判定）。
- `apps/desktop/src/stores/refs.ts`（Pinia）：
  - `refs: Map<string, Reference>`；`refFiles: string[]`。
  - `loadVault(vaultPath: string): Promise<void>` —— 扫 vault 下引用文件（`.bib`/`.ris`/`.json`），逐个解析并索引；单个文件解析失败不影响其余。
  - `search(query: string): Reference[]` —— 按 key/title/author/year 子串匹配。
  - `get(key: string): Reference | undefined`。
- 侧栏 `RefSidebar.vue`：搜索框 + 结果列表（key / 标题 / 作者 / 年），点击一项 → 在光标处插入 `[@key]`。
- 面板 `ReferencesPanel.vue`：显示当前文档已引用文献的编号化列表（与文档内 `[n]` 一致）。

### 3.2 引用节点（editor-core）

- `cite` 节点：`group: 'inline'`、`inline: true`、`atom: true`，attrs `{ key: string }`。
  - `parseMarkdown`：匹配 `citation`（或预处理产生的 `nekoCite`）节点，value 为 `[@key]`，抽取 key。
  - `toMarkdown`：输出 `[@key]`（html-bucket 原文输出，同 math/mdx 模式）。
  - `toDOM`：`<cite data-cite-key>`。
- remark 预处理（`citeRemark`，`$remark`）：在 mdast 中识别 `text`/`paragraph` 内的 `[@key]` 子串 → 拆成 `citation` 节点（携带 `{ value: '[@key]' }`），行内可混排（`see [@a] and [@b]` 各自成节）。
- 编号：node view 渲染为 `[n]` chip（`n` = 文档内 cite 节点首现顺序；node view 通过 `view.state.doc` 扫描计算，文档更新时重算）。tooltip 显示原始 `[@key]`。

### 3.3 自动编号一致性

- 编号规则唯一：按文档内 cite 节点首次出现顺序 1..N。
- 文档内 chip `[n]` 与侧栏 `ReferencesPanel` 编号一致（侧栏对当前文档文本提取 cite 顺序，用同一规则）。
- 无引用的文档：ReferencesPanel 显示空态提示。

## 4. 实现范围（v1.2）

1. editor-core：`cite` 节点 + `citeRemark` 预处理 + node view 编号渲染 + 往返保真测试。
2. app：`services/refs.ts`（Citation.js 解析）+ `stores/refs.ts` + 启动时随 vault 加载。
3. 侧栏：`RefSidebar.vue`（搜索/插入）+ `ReferencesPanel.vue`（编号列表）。
4. 往返测试：`[@smith2020]` → 保存 → 重开 → `[@smith2020]`；混排文本保真。

## 5. 范围红线（v1.2 不做）

- 不做 prefix/locator 编辑 UI（`[see @key, pp.10-15]` 的解析保留，编辑暂不做）。
- 不做导出（PDF/HTML，v1.3）。
- 不做 Zotero/云同步/自动抓取 DOI。
- 不做引用去重合并。

## 6. 测试策略

- **解析单测**：.bib/.ris/CSL 各一真实样例 → Reference 字段正确；空文件/坏文件不崩溃；key 缺失降级。
- **序列化单测**：`[@a]` / `see [@a] and [@b]` / `[@a] tail` 经 `roundTrip` 字节保真。
- **编号单测**：多引用文档首现顺序 → 1,2,3…；重复引用编号一致。
- **侧栏搜索单测**：关键字匹配 key/title/author/year。
- **E2E（可选）**：侧栏点击插入 → 文档出现 `[@key]` → 渲染视图出现 `[n]` chip。

## 7. 依赖

- `@citation-js/core`、`@citation-js/plugin-bibtex`、`@citation-js/plugin-ris`、`@citation-js/plugin-csl`（app 层）。
- editor-core 不新增第三方依赖（复用现有 remark/$remark/$node/$view 基础设施）。
