# NekoWite Development Log

> 项目开发与版本管理记录。从 2026-09-08 起，本仓库统一使用 Git 管理代码、主题、文档和测试。

## Git 约定

- 仓库级提交身份：`NekoWite Dev <dev@nekowite.local>`（未配置全局 user.name/email，避免污染其他项目）。
- 主分支：`master`。功能开发优先在 `codex/` 前缀分支进行，完成后合并回 `master`。
- 提交信息使用 Conventional Commits：`feat:`、`fix:`、`chore:`、`docs:`、`test:`、`style:`。
- 每轮功能保持单一职责，先跑测试/类型检查/构建，再提交。
- 忽略运行产物：`.nekowite/`、`.nekowite-trash/`、`.pnpm-store/`、`node_modules/`、`dist/`、`target/`、`test-results/`、`playwright-report/`。
- `.npmrc` 保留国内镜像源（npmmirror），仅用于加速依赖下载，不含密钥。

## 提交记录

### 2026-09-12（真机功能测试轮）

以「实际使用」的方式驱动打包后的应用（WebView2 远程调试 + Playwright，真实 vault、真实磁盘）逐项走查，覆盖三种视图模式的编辑与保存、构造单元（表格/公式/图片/组件/脚注/任务列表/双链/引用/高亮）、无编辑保存的字节保真、工具栏与命令面板、表格对话框、模式切换、外部文件改动、搜索、分隔条拖拽、图谱、回收站与导出 HTML。

- `fix(storage): keep the app's own bookkeeping out of the trash` — 回收站被索引临时文件灌满（见 CHANGELOG）；`.nekowite/**` 直接永久删除，`list_trash` 清理历史遗留条目；新增 2 条 Rust 回归用例。
- `fix(table): always insert on confirm` — 有选区时确认插入表格是静默空操作；新增 2 条用例，并验证过「回退修复即失败」。
- `fix(export): one tbody per table` — 每行一个 `<tbody>` 的导出结构；新增 2 条用例。
- `fix(ui): localize the registry toolbar buttons` — 「Table」英文 tooltip；注册按钮加 `data-command-id`，E2E 定位器改为稳定 id。
- `feat(image): honest copy for a blocked remote image` — 区分「远程图片被安全策略拦截」与「本地加载失败」，新增「在浏览器中打开」；图片节点文案可注入并接入中英文（此前写死英文）；重试路径补记期望 src。
- 测试中确认**不是**缺陷的项（记录以免重复排查）：`_`/`*` 在保存时被转义成 `\_`/`\*` 属 CommonMark 合法行为；表格分隔行 `| --- |` 规范化为 `| - |`、`---` 规范化 `***`、脚注定义之间补空行，均为既有的有意规范化（`source-fidelity.spec.ts` 已逐一钉住）；点击表格列边框 5px 内不聚焦是 prosemirror-tables 的列宽拖拽热区（原生行为）。
- 验证：editor-core 567、plugin-host 100、desktop 1073、typecheck、lint、`cargo test`（54+37+7+6+3）、`cargo clippy -D warnings`、Playwright 135 全绿。

### 2026-09-12

- `fix(export): stop a component body from stealing a document heading id` — 导出 HTML/PDF 的标题锚点错位与重复：
  - 根因：`collectHeadingTexts` 只统计真正的文档标题（编辑器里 mdx 组件是原子，正文是不透明源码，其标题不在锚点列表里），但渲染时组件正文同样走 `headingIds.shift()`，于是正文里的每个标题都**消耗**了一个本该属于文档标题的 id —— 后续 id 全部前移，最后一个被重复使用。
  - 实测（`<Box>` 正文含 `## Inside`，前后有 `# Aaa` / `# Bbb` / `# Ccc`）：修复前 `Ccc` 拿到 `ddd`、`Ddd` 也是 `ddd`；修复后三个文档标题分别是 `aaa`/`bbb`/`ccc`，正文标题不再带文档锚点（编辑器里也没有对应锚点按钮，给了 id 反而是永远不可达的链接目标）。
  - 新增 `RenderContext.literalHeadingIds`，由 `renderMdx` 在渲染组件正文时打开；`export/headingIds.test.ts` 增加「正文标题不吃 id」「同一 id 绝不出现两次」两例。
- `fix(image): scope the resolution memo to the note` — 切换笔记后显示上一页的图片：
  - 根因：`resolveImageSrc` 的 memo 只以原始 src 为键，而应用层解析器在**调用时**读取当前笔记（`getNotePath: () => tabs.activeTab?.path`）把相对路径变成绝对显示 URL。同一个 `pic.png` 在不同目录下指向不同文件（图片存放于 `<basename>_assets/`），于是切换标签后第二篇笔记复用了第一篇的解析结果。
  - 实测：`a/note.md` 与 `b/note.md` 都引用 `pic.png`，修复前第二次返回 `asset:///a/pic.png`，修复后为 `asset:///b/pic.png`。
  - 新增 `ImageResolverOptions.scope`：token 变化即丢弃 memo（`editor-core/src/image/resolver.ts`）；`editorController` 挂载时传入 `JSON.stringify([vault, activeTab.path])`。同一笔记内仍然命中缓存。
  - `image/resolverCache.test.ts` 增加三例（跨笔记失效、同笔记命中、未配置 scope 时保持原行为）；`editorController.test.ts` 增加接线用例，防止 scope 被误删。
- 验证：editor-core 559、desktop 1071、typecheck、lint、`cargo test`、Playwright 135 全绿。

### 2026-09-08

- `chore: initial project baseline` — 建立可版本化的项目基线，包含 Vue/Tauri 应用、编辑器核心、插件宿主、文档、演示内容与 CI。
- 前端外观增强（主题 + 强调色）：8 → 15 套主题、11 → 15 个强调色、设置面板主题色卡与单色展示。
- `feat(templates): add ten built-in default note templates` — 从模板新建始终提供每日日记、每周复盘、会议记录、学习笔记、读书笔记、实验记录、文献阅读、研究计划、测试用例、决策记录 10 个内置模板；同名用户模板可覆盖，内置模板使用稳定英文文件名避免中文路径。
- `docs: record template feature and windows bundle` — 记录内置模板功能验证与 Windows 打包产物`release/nekowite_0.1.0_x64-setup.exe`（SHA-256：`1bf064945dca7e71699697b753dc5a79f9d201999696a711681dd624c2e4ba8f`）。
- `fix(ui): restrict window dragging to titlebar` — 修复整个界面均可拖拽的问题：移除 Tauri 原生 `data-tauri-drag-region`，改为自定义标题栏仅空白区域调用 `startDragging()`；按钮/链接/输入框/可编辑元素不触发拖动，双击标题栏空白处保持最大化/还原，并补充 TitleBar 回归测试。
- `fix(ui): make close fallback reliable` — 修复右上角 X 无法关闭的问题：标题栏 X 优先走正常 `close()`（保留关闭前保存），失败时自动调用 `destroy()` 兜底；关闭保存流程增加异常保护，并为关闭按钮与 close-requested 异常路径补充回归测试。
- `chore(release): add Windows packaging workflow` — 新增 `scripts/package-win.sh` 一键打包脚本（测试 → 类型检查 → lint → 编译 → `release/`），并约定后续每个可感知改动均交付 **免安装 Windows 可执行文件**及 SHA-256，便于直接双击验证。
- `chore(release): make portable exe the default` — 默认交付 `release/nekowite_<version>_x64.exe`（免安装）；NSIS 安装包改为可选（`PORTABLE=0`）。

### 2026-09-09

- `fix(editor): prevent caret jumping from duplicate instances` — 修复输入时光标乱跳与多实例冲突：
  - 注册 `tauri-plugin-single-instance`，再次启动时只恢复、显示并聚焦已有主窗口，不再创建共享同一知识库的第二个进程。
  - 保存、删除与恢复历史在磁盘操作前标记自写窗口，避免把应用自身写入误判为外部修改。
  - 文件监听对活动文档的 `modified` 事件先读取磁盘并与 `savedContent` 比较，内容一致时只刷新目录树，不重载编辑器。
  - 编辑器外部同步依据 `appliedContent` 做幂等保护，重复 `open()` 不再清空撤销历史、光标与滚动位置。
  - 验证：983 个测试全部通过，前端类型检查与 lint 通过；Windows 免安装包 `release/nekowite_0.1.0_x64.exe`（SHA-256：`af308f470179641a8b415f4de80b4b2264e2ee481fbf56379af92b7a18d25b3c`）构建成功；双实例启动验证仅保留单进程。

- `fix(editor): stabilize heading edge input` — 修复标题末尾点击后按 Enter 跳回开头、连续删除误触斜杠的问题：
  - 标题节点视图改为外层包裹 + 真实 `h1` 作为 ProseMirror 内容 DOM，锚点按钮移到可编辑区域外，避免 Chromium 把光标放在非内容边界。
  - 移除拦截普通文本输入的 `beforeinput` 插件，让 Enter/Backspace/`/` 走 ProseMirror 原生输入流程，避免 DOM 与模型失同步。
  - 标题包装层占满整行，右侧空白仍属于可编辑内容；补充标题与后续段落间距规则。
  - 新增 E2E 回归测试：标题末尾 → Enter → 输入 `abc` → 三次 Backspace → 输入 `/`，逐节点验证光标与内容。
  - 验证：editor-core 281 个测试、desktop 983 个测试全部通过，类型检查与 lint 通过。

## 输入健壮性全量测试：源码模式光标回跳与重做失效

- **测试覆盖**：新增 `apps/desktop/e2e/editor-input.spec.ts`（30 个用例），覆盖源码 / 渲染 / 对照三种模式：连续字符输入、修饰键与符号、CJK `insertText`、连续 Enter、行首与行中 Enter、连续 Backspace、Backspace 并行、Delete、方向键与 Home/End、全选替换、撤销重做、多行粘贴、Markdown 标点、Tab 缩进、编辑中触发自动保存、Markdown 快捷语法、斜杠菜单、模式往返切换。
- **定位到的真实缺陷**：
  - 源码模式编辑经隐藏渲染面板回写成规范化 Markdown，替换原文并把 CodeMirror 光标重置到开头；现源码模式不再回写（`editorExternalSync` 的 `renderedPaneOwnsText()`），`persistMarkdown` 亦只在模型真正变化时才写入标签页。
  - Windows 上 `Ctrl+Shift+Z` 无法重做：CodeMirror 仅在 `linux` 平台标记下绑定该组合键，现于 `cmSourceView` 显式绑定（`Ctrl+Shift+Z` / `Cmd+Shift+Z`）。
- **测试脚手架修正**（非产品缺陷，避免误报）：
  - 渲染面板在点击后需等待 ProseMirror 落定（约 20ms 合并 flush），否则 CDP 的零延迟按键会落在尚未采纳的选区上；新增 `waitForRenderedCaretSettle` / `pressKey` 辅助函数。
  - 源码模式若干用例缺少建立焦点的点击，导致按键落到工具栏按钮上。
  - 行首 Enter 的期望值有误（标准语义为光标停在被下推文本行首），文档末尾空行的 `End` 合法列只有 0。
- **验证**：editor-core 281 个测试、desktop 989 个测试、全部 E2E（含 app / caret-debug / usage / lifecycle / security-csp / editor-input 共 40 个用例）通过，类型检查、lint 与生产构建通过。
- **交付**：免安装 Windows 可执行文件 `release/nekowite_0.1.0_x64.exe`（17,255,424 字节，未签名），SHA-256：`acc1a3f7dceb6999240211abc390f0e2c00a765963db57077bd0039d11dbed53`。

## 当前外观状态

- 主题（15）：默认 / 暖阳 / 森林 / 海洋 / 樱花 / 薄雾 / 石墨 / 午夜 / 薰衣草 / 沙漠 / 薄荷 / 咖啡 / 梅子 / 暮色 / 绯红
- 强调色（15）：墨 / 珊瑚 / 蓝 / 绿 / 金 / 紫 / 石板 / 青 / 酸橙 / 玫瑰 / 琥珀 / 橙 / 粉 / 青 / 可可
- 每套主题含浅色/深色完整的表面、文本、边框、语义色、代码高亮与阴影变量；设置面板只显示当前模式单个色块，可点击切换。

## 提交命令示例

```bash
git config user.name "NekoWite Dev"
git config user.email "dev@nekowite.local"
git add <files>
git commit -m "feat(appearance): add crimson palette and four accents"
```

### 2026-09-10

- `fix(editor): make image intake work in every view mode` — 修复「源码模式无法粘贴图片」「插入图片不弹文件选择器」及同类的模式假设错误：
  - 图片粘贴 / 拖放处理器从渲染面板上移到两种视图共用的面板容器（捕获阶段），源码模式同样生效；源码模式插入改为写 CodeMirror 文本。
  - 新增后端命令 `pick_image_files` / `import_attachment`（原生多选、扩展名白名单、10 MB 上限、字节不过 IPC、目标目录限定在 vault 内、重名加后缀），工具栏与命令面板的「图片」命令改为打开选择器并把所选文件复制进笔记资源目录；`editor-core` 暴露 `setImageInsertHandler` 宿主钩子，未注册时仍插入可见占位节点而不是空 `src` 图片。
  - 新增 `services/editorInsert.ts`、`services/editorOwnership.ts`、`services/sourceCommands.ts`、`services/sourceView.ts`：按视图模式把「插入 / 工具栏命令 / 焦点归属」路由到真正负责输入的面板；源码模式下内置命令改为等价的 Markdown 文本变换，编辑器不再被按钮抢焦点。
  - 修复对照模式下源码编辑被序列化结果覆盖（按「标签页文本是否由源码面板产生」判定，并在回写前冲刷源码面板待提交编辑），`Ctrl+S` 前也会冲刷，避免漏存最后一次按键。
  - 修复 `resolve_within_rel` 在 Windows 上返回反斜杠相对路径的问题（影响图片引用、历史/回收站键），顺带修复该平台此前失败的 3 个附件测试。
  - 验证：desktop 单元测试 1028 通过（含新增 `sourceCommands`/`editorInsert`/`useImageIntake`/`EditorPane` 用例）；editor-core 281 通过；`cargo test` 除 4 个既有的 Windows 路径分隔符用例（`/etc/passwd` 与 `ends_with("a/b")` 假设，与本改动无关）外全部通过，`cargo clippy -D warnings` 通过；`pnpm -r typecheck`、`pnpm -r lint` 通过；Playwright E2E 全部通过（新增 `e2e/image-insert.spec.ts` 10 项，`editor-input.spec.ts` 连跑 3 轮 96 项稳定）。
  - 测试基建：`e2e/support/editorHarness.ts` 新增附件/选择器命令 mock 与图片粘贴、拖放、选择器助手；`focusHeadingEnd` 改为点击标题「文本末端」（元素整行宽，右端是空白区，点击映射在布局收敛前会落到下一段），并在测量前等待标题文本完成绘制。

### 2026-09-11

- `fix(editor): route every command entry point by view mode` — 继续排查「假设渲染面板永远是活动编辑器」这一类逻辑错误，又发现并修复 7 处：
  - AI 改写 / 润色 / 翻译在源码模式下读写隐藏的渲染模型，结果在切回渲染模式时被静默丢弃；新增 `services/editorTextSelection.ts` 作为模式感知的选区读写层，`rewriteSelection` 改为经由它操作实际负责输入的面板。
  - 插件按钮（`math.insert` / `table.insert` / `callout.insert` / `floatbox.insert`）原先各自调用 `run()` 并自行解析渲染视图，源码模式下插入丢失；`editor-core` 新增 `registerMarkdownCommand`，这些命令声明其 Markdown 形式，源码模式下插入文本（`$$…$$`、3×3 GFM 表格、对应 JSX）。
  - 命令面板每一项都直接 `getCommand(id)?.run()`，连「加粗」在源码模式下也改的是隐藏模型；现与工具栏共用新增的 `services/runEditorCommand.ts`。
  - 按 id 分发后 `callout.insert` / `floatbox.insert` 失效（它们只注册为工具栏项、无命令注册），分发回退到工具栏注册表。
  - 对照模式下的分发依赖瞬时 DOM 焦点，而命令面板打开时焦点已移到其输入框；现记住最后聚焦的编辑面板（`noteFocusedPane`）。
  - 保存 / 导出 / 聊天上下文直接读取标签页文本，可能落后源码面板一次按键的合并窗口；`saveTab`（显式、自动、关闭保存）、导出与聊天上下文在读取前先冲刷待提交编辑。
  - 源码模式下浮动框工具栏仍显示但按钮编辑隐藏模型；切到源码模式时清除浮动框选中。
  - 测试基建：`focusParagraph` 增加点击重试；新增基于模型定位光标的 `placeRenderedCaretInParagraph`，替换「点击 + 连按方向键」这种在负载下会丢按键的定位方式，消除两处固有 flaky。
  - 验证：desktop 单元测试 1052 通过（新增 `editorTextSelection`/`runEditorCommand`/`markdown 注册表`/`tabs 冲刷`/浮动框模式用例），editor-core 290 通过；`pnpm -r typecheck`、`pnpm -r lint`、`cargo clippy -D warnings` 通过；Playwright 全量 64 项通过，`editor-input` + `input-ime` 连跑 4 轮 144 项稳定。

### 2026-09-11（第二轮）

- `fix(layout): make the split divider follow the pointer` — 修复用户报告的「对照模式下分隔条只能拖到固定位置」：
  - 根因：`LayoutResizeHandle` 把指针位移（像素）直接累加到取值上，而分隔条取值是 0.15–0.85 的比例，任何拖拽都会瞬间撞到上/下界。侧栏与右栏用的是像素宽度，因此该组件必须同时支持两种单位。
  - 修复：新增 `deltaUnit`（`px` 默认 / `fraction`），比例型手柄按轨道宽度换算位移；分隔条声明 `delta-unit="fraction"`。
  - 同时修复该组件丢失调用方 `class` 的问题（模板双根节点导致无法自动继承属性），`split-handle` 现正确生效。
- `fix(ui): stop the command palette from keeping a stale open flag` — 排查过程中发现的两个真实缺陷：
  - `show()` 用两帧 rAF 延后淡入而 `hide()` 不取消它，快速关闭时迟到的绘制会在 `hide()` 之后把「已显示」重新置真，造成逻辑已关闭但仍标记在屏的状态；现关闭与卸载都会取消待执行绘制帧。
  - Esc 与 Ctrl+K 原先依据 `visible`（受上述延迟影响）判断，导致「刚打开时按 Esc 不生效」；现改为依据逻辑开启状态，并新增独立 `closing` 状态，使淡出过程中的 Ctrl+K 重新打开面板。
- `fix(editor): flush the source pane before any whole-document read` — 修正上一轮修复中的顺序问题并补齐同类路径：
  - `saveTab` 的冲刷原先排在附件迁移之后，而迁移是整档「读-改-写」，会基于过期快照改写并覆盖合并窗口内的按键；现提前到读取 `t.content` 之前。
  - 侧栏移除标签、frontmatter 面板写回同样是整档读改写，此前未先冲刷。
- `test(e2e): add a console-clean sweep` — 新增 `e2e/console-clean.spec.ts`：三种视图模式点遍全部工具栏按钮、走遍侧栏与右栏、多组关键词执行命令面板、逐项遍历设置面板全部配色与开关，任何 console error/warning 或抛错即失败。该巡检用于捕捉单元测试看不到的渲染期问题（Teleport 目标被移除后继续 patch、命令派发到已卸载编辑器等）。
- `test(layout): cover both divider units` — 新增 `e2e/split-resize.spec.ts`（5 项，真实鼠标拖拽 + 上下界 + 双击复位 + 方向键步进）与 `LayoutResizeHandle` 单元用例（5 项）。已验证：移除修复后比例拖拽用例会失败。
  - 排查方法记录：`e2e/support/editorHarness.ts` 的 `focusParagraph` 增加点击重试；需要精确光标位置的用例改用新增的 `placeRenderedCaretInParagraph`（经编辑器模型定位），替换「点击 + 连按方向键」这类在负载下会丢按键的写法。
  - 另发现：`set_master_password` / `unlock_vault` 两条 Rust 命令已实现并有测试，但前端没有任何调用点（vault 主密码解锁没有 UI）。属于未完成功能而非回归，本轮未改动。
- 验证：desktop 单元测试 1063 通过、editor-core 290 通过；`pnpm -r typecheck`、`pnpm -r lint`、`cargo clippy -D warnings` 通过；Playwright 全量 73 项通过（其中 mode-routing 与 console-clean 连跑 3 轮 36 项稳定）。

### 2026-09-11（第三轮）

- `fix(editor): flush the rendered pane before saving` — **数据丢失级修复**：
  - 渲染面板的序列化同样是防抖的（120ms），但 `saveTab` 只冲刷了源码面板。在防抖窗口内按 Ctrl+S 会写入上一版文本，随后 `editorExternalSync` 又把这份过期文本套回模型，刚敲的按键被彻底丢弃（实测：立刻保存 → 模型与磁盘都没有该文本；等待 200ms 后保存 → 正常）。
  - 现 `editorPersistence` 暴露可等待的 `flush()`，由 `RenderedPane` 注册到 `editorOwnership`；`flushEdits()` 一次冲刷两个面板，`saveTab`／导出／聊天上下文在读取文档前统一调用。
- `fix(editor-core): keep U+00A0 out of saved files` — 在渲染面板于一段文字末尾输入空格时，浏览器插入 U+00A0；该字符此前会原样写进 Markdown 文件，导致纯文本搜索/对比失配、其他工具显示异常。现于 `normalizeNbsp()` 在序列化与解析两侧归一化；实测 `END`/`MID`/`DOUBLE` 三种输入位置都已输出普通空格（0x20），`insertText` 与源码面板本就不受影响。
- `fix(i18n): add the four missing chat session keys` — `chat.newSession`/`chat.sessions`/`chat.untitled`/`chat.deleteSession` 在中英文里都不存在，界面直接显示原始键名（控制台伴随 `[intlify] Not found` 警告）。根因是既有的对等测试只比较 zh↔en，两边同时缺失时无法发现；新增「源码用到的字面量键必须存在」用例填补该盲区。
- `test(e2e): add save round-trip coverage` — 新增 `e2e/save-roundtrip.spec.ts`（8 项）与夹具 `diskFiles()`（读取内存 vault 的真实落盘内容），逐字节校验源码模式、渲染模式、对照模式、frontmatter 面板的保存结果，并覆盖「立即保存」「末尾空格」「已有 U+00A0 的文件」三类回归。
- `test(e2e): extend the console-clean sweep` — 覆盖范围扩到标签栏（开/切/关）、信息栏全部 6 个分区、模板选择器、文件树右键菜单、附件与图谱视图（新增 1 项，共 5 项）。
- `test: harden load-sensitive waits` — `GraphPanel.test.ts` 中三处「固定次数 flush()」改为 `vi.waitFor` 轮询（读 N 个笔记是 N 层 await，负载下两次宏任务不足以完成），消除全量跑批时的偶发失败。连续 3 轮全量通过（103 文件 / 1064 用例）。
- `test(rust): make fs_test platform-correct` — 修复 4 个仅 Windows 失败的既有用例（此前后端测试在 Windows 上恒有 4 项红）：
  - `/etc/passwd` 在 Windows 上不是绝对路径（无盘符），守卫会把它当作 vault 相对目录而放行，断言因此为别的原因失败；改用 `outside_absolute_dir()` 返回平台对应的绝对路径，并补上「未写到 vault 之外」这一真正要守的不变量。
  - `restore_from_trash` 返回绝对路径，Windows 下用 `\`，`ends_with("docs/a.md")` 恒为假；改用 `rel()` 归一化分隔符后比较。
  - 现在 `cargo test` 在 Windows 上全绿：7 + 37 + 50 + 6 + 3。
- 验证：desktop 单元测试 1064 通过（连续 3 轮）、editor-core 297 通过、`pnpm -r typecheck`/`lint`、`cargo clippy -D warnings`、`cargo test` 全绿、Playwright 全量 82 项通过。
- 排查方法记录：本轮先用「控制台洁净度巡检」把界面点一遍定位到 i18n 缺失，再用「磁盘快照比对」定位到保存丢失与 U+00A0 —— 两者都是单元测试结构上看不到的（前者是运行期渲染，后者是浏览器输入行为）。

### 2026-09-11（第四轮）

- `fix(image): stop showing a load failure for images that loaded` — 修复用户报告的「默认打开文件图片渲染失败，Retry 才会成功」：
  - 根因（两处叠加）：图片节点视图先把文档里的相对路径写进 `<img src>` 再等异步解析替换；相对路径在应用源下必然 404，于是先触发 `error` 显示失败浮层；随后 `asset://` URL 加载成功，但节点视图**只监听 `error` 没有监听 `load`**，浮层因此无人清除。Retry 之所以看起来有效，是因为它在重试前先把状态重置为正常。此外解析失败的结果也会被 memoize，若首次解析早于 vault 授权，Retry 将永久无效。
  - 修复：解析器可用时不再写入不可加载的原始路径（`http:`/`data:`/绝对路径这类本就可直接显示的仍立即写入，避免空白帧）；补上 `load` 监听在真正加载成功后清错；Retry 改为带 `refresh` 重新解析，仅在解析结果与原路径相同（无更优 URL）时才附加 `?retry=` 强制重新请求。
  - `editor-core/image/resolver.ts` 新增 `hasImageResolver()`；`resolveImageSrc(src, { refresh })` 支持丢弃 memo。新增 5 项单元测试（首帧不得为不可加载路径、可直接显示的路径立即写入、`load` 清错、Retry 重新解析、Retry 缓存穿透）；已验证其中 2 项在未修复代码上失败。
- `test(e2e): make images actually renderable in the harness` — E2E 夹具此前没有实现 `resolve_media_path`，`convertFileSrc` 也是 undefined，因此**任何图片相关行为都无法在浏览器里验证**。现在夹具实现 `resolve_media_path`（返回 data URL）、`convertFileSrc` 恒等、并新增 `attachments` / `resolveDelayMs` 选项，使图片真正被浏览器解码（可断言 `naturalWidth`）。
  - 新增 `e2e/image-render.spec.ts` 4 项：首次打开即渲染且无失败浮层、解析期间元素绝不指向不可加载路径（用 `resolveDelayMs` 让中间态可观测）、附件缺失时显示可恢复浮层且 Retry 能清除、模式往返后仍渲染。
  - 探测过程记录：`@tauri-apps/api` 的 `invoke` 在导入时即绑定，事后替换 `window.__TAURI_INTERNALS__.invoke` 无法拦截调用（这是最初 `CALLS []` 误判的原因）；`vaultRelativeFromNoteVault` 产生的 `resolve_media_path` 参数是 vault 相对路径，不含 vault 目录名。
  - 另核查：`assetProtocol.scope` 静态配置仅 `attachments/**`，但 `register_vault` 会在运行时 `allow_directory(整个 vault, recursive)` 并 forbid 内部目录，因此 `*_assets/` 与 `.tmp/` 下的图片本就可通过 asset 协议访问——scope 不是本次故障的原因。
- 验证：desktop 单元测试 1064、editor-core 301、`pnpm -r typecheck`/`lint`、`cargo clippy -D warnings`、`cargo test` 全绿、Playwright 全量 86 项通过。

### 2026-09-11（第五轮：外部扫描结果复核）

按独立扫描报告逐条**实证复核**后修复。报告里关于「工作区有未提交改动」的前提已过时（那批改动已在 `d362b7c` 提交）。

- `fix(export): sanitise link and image destinations` — **P1，已实证**：`renderDocument` 对 `[x](javascript:alert(1))` 输出 `<a href="javascript:alert(1)">`，`![a](javascript:alert(1))` 同样进入 `src`；HTML 转义拦不住它（不含元字符）。同文件对原生 HTML 是故意转义的，链接却无同级防护。新增 `export/url.ts` 协议允许列表（http/https/mailto/tel/相对路径；图片额外 asset: 与 data:image/* 光栅），并接入链接、图片与 `.bib` 参考文献两条链接。附带发现并处理：`java\tscript:` 这类控制字符混淆、`data:text/html`、SVG data URL（作为文档打开可执行脚本）。
- `fix(image): do not memoise a resolution failure` — **P1，已实证**：`resolveImageSrc` 把拒绝也写入缓存（`PROBE_SECOND` 显示第二次调用仍返回失败值且只尝试了 1 次），应用侧解析器无 vault 时返回原 src，使「vault 未就绪」被当作成功结果永久缓存。现失败不入缓存；新增 `invalidateImageResolution()` + 节点视图订阅，`appBootstrap` 在提交 vault 后调用，已挂载图片会重新解析。补充：模式往返**不会**重建节点视图（实测），所以恢复依赖失效通知而非重新渲染。
- `fix(export): give headings the ids their anchors link to` — 导出标题不生成 `id`，编辑器锚点复制的 `#slug` 全是死链。现按编辑器同一 `slugify` 生成 `id` 并去重（`same`/`same-1`/`same-2`），slug 取标题纯文本而非标记。
- `fix(editor): navigate local markdown links in-app` — `[文本](notes/other.md)` 此前无反应；`#slug` 滚动到标题；其它协议一律阻止默认行为。实测确认相对链接**不会**导航掉 webview（`URL_BEFORE == URL_AFTER`），因此这是体验缺口而非破坏性问题。
- `fix(security): enforce the attachment size cap and image allowlist in Rust` — `save_attachment` 无上限、无白名单（仅 picker 用的 `import_attachment` 有）。现先按 base64 编码长度拒绝（不解码超大 payload）再按解码字节复核，并复用图片扩展名白名单；前端 `validateRenameName` 提前给出明确提示。
- `test`: editor-core 新增 `export/url.test.ts`（39 项）、`export/headingIds.test.ts`（6 项）、`image/resolverCache.test.ts`（9 项）、nodeView 恢复用例（4 项）；Rust 新增大小上限与扩展名白名单用例。**每一项都先在未修复代码上验证会失败**（如失败缓存用例、可变宽路径用例）。
- 文档与实现对齐：README 打包章节的产物改为免安装 exe（NSIS 降为可选）；`docs/dev.md` 中「切换 vault 时未命名 dirty 文档」等三项已完成的条目标注完成；`attachments.ts` 中声称 streaming 命令「尚未实现 / OUT OF SCOPE」的注释更正（`import_attachment` 早已实现并接线），并说明粘贴路径实际生效的限额（每文件 / 每批数量 / 每批字节 / 每会话），明确指出每 vault 总量与磁盘余量守卫**目前无生产调用方**。
- 未修复（如实报告，非本轮范围）：`tauri-plugin-fs` 已初始化并授权但前端无调用方；`.oxlintrc.json` 为废配置；插件无真正隔离/签名治理；表格与图片的功能缺口；索引大规模与断电重建未做真机验证；M5 性能缺目标机基线。

### 2026-09-11（第六轮）

继续验证上一轮的标题深链修复，发现并修掉两个**我自己引入/遗漏**的缺陷：

- `fix(heading): give every duplicate heading its own anchor` — 我上一轮只给**导出**加了同名标题去重，编辑器的锚点按钮仍用 `slugify(文本)`，所以三个「Same」标题复制的都是 `#same`：新导出的 `same-1`/`same-2` 反而无人引用，而复制出来的链接全都落在第一个标题上。现提取 `headingAnchorIds(texts)` 作为**唯一**定义，三个消费方（锚点按钮 / 导出 `id` / 滚动处理）共用；锚点在**点击时**按文档顺序解析自己的 id（渲染期零成本），滚动处理改为按**索引**匹配而非 slug 比较（否则 `#same-1` 会匹配到第一个标题）。
  - 如实记录一处共享的固有歧义：标题「Same 1」的 slug 恰好是 `same-1`，与第二个「Same」的后缀相同（GitHub 同样如此）。解析按文档顺序定位，因此链接仍能落到产生它的标题上；已在代码注释与测试里把这个行为固化下来，而不是假装不存在。
- `fix(editor): stop doubling the vault in a copied heading link` — 链接构造 `${vault}/${tab.path}` 未做归一化，而 `tab.path` 在部分流程里已含 vault 前缀（Rust `list_dir` 返回解析后的完整路径，链接索引返回 vault 相对路径），于是复制出的链接是 `vault/vault/note.md#slug`。新增共享助手 `notePathRelativeToVault`（`dirRelativeToVault` 也改为复用它）。
- `test(e2e): heading-links.spec.ts`（4 项）— 覆盖「同名标题复制不同片段」「链接只出现一次笔记路径」「导出为每个片段提供 id」「跟随最后一个同名标题的链接滚动到该标题」。三项都验证过在未修复代码上失败。
  - 测试方法上踩到的坑记录：`element.click()` 会触发 Playwright 的 scroll-into-view，第一次写这条用例时**是 Playwright 滚动的、不是被测代码**，导致用 slug 比较的错误实现也能通过。改为把链接放在文档开头（无需自动滚动）并用 `dispatchEvent` 直接派发后，回退实现才如预期失败（`Received: 0`）。
- 验证：editor-core 370、desktop 单元 1069、`pnpm -r typecheck`/`lint`、`cargo clippy -D warnings`、`cargo test`、Playwright 91 全绿。

### 2026-09-11（第七轮）

- `chore: drop the unused fs plugin and stray runtime artifacts` — 处理上一轮扫描里两条未完成项：
  - `tauri-plugin-fs` 被初始化、`fs:default` 被授权，但前端既无 `@tauri-apps/plugin-fs` 依赖也无任何调用点（文件操作全走自定义命令），是纯粹的 IPC 暴露面。移除插件初始化、权限授权与 Cargo 依赖后，生成的 ACL schema 减少约 7150 行。
  - **运行期验证（关键）**：E2E 跑在浏览器里，抓不到 Tauri 运行时回归，所以打包后实际启动了 exe 做冒烟测试——进程存活、窗口标题 `NekoWite`、`Responding=True`、工作集 29.4 MB，随后仅按记录的 PID 精确结束进程。这一步是本次改动唯一有意义的验证方式。
  - `daily/2026-09-08.md` 是应用在「把仓库根当 vault」时自动生成的空日记，与已忽略的 `.nekowite/` 同类，在基线提交里被误纳入版本控制；取消跟踪并加入 `.gitignore`（磁盘文件保留，未删除）。
  - 删除 `.oxlintrc.json`（内容为空的 `{"rules": {}}`，oxlint 既非依赖也不在 CI 中运行，其存在会让人误以为有一道 lint 关卡）。
  - 澄清文档：代码格式目前只是约定（prettier 配置存在但未安装、CI 无格式门禁）。

### 2026-09-11（第八轮）

- `fix(export): render the node types the editor already understands` — 延续上一轮的导出节点覆盖普查（对每个 remark/milkdown 节点类型跑一遍导出，看有没有内容凭空消失）。除已修的 `math`/`displayMath` 外，又确认四处不一致，其中两处是**文字丢失**：
  - 先写**区分性测试**再改代码：`renderNodes.test.ts` 新增 4 个用例（任务列表 / 脚注 / 高亮 / 双链）。改前 4 个全部失败，改后全绿——用例断言的是「不再出现 `[x]`、`==`、`[[` 字面量」这类**只有真的解析了**才成立的条件，而不是仅仅「文本还在」（双链的别名子串在原始 `[[Other Note|alias]]` 里本来就存在，用 `toContain('alias')` 会假通过）。
  - 高亮/双链的根因是**转换链缺 pass**而非缺渲染分支：`==x==` 与 `[[a|b]]` 对 remark 只是文本。补 `highlightMdast`/`wikilinkMdast` 后必须同时补 `nekoWikiLink` 的渲染分支，否则引用型节点会从「显示字面量」变成「整段消失」——这是本次最容易踩反的一步，已在测试里固定。
  - 任务列表与脚注则是渲染器直接漏了字段/节点类型：`listItem.checked` 被无视（`[x]` 字面量已被 remark-gfm 消费，无处可查），`footnoteReference` 是叶子、落进 `renderChildren` 得空串。
- 验证：editor-core 377、desktop 单元 1069、`pnpm -r typecheck`/`lint` 全绿。

### 2026-09-11（第九轮）

方法：不再逐个找 bug，而是给「保存」这条最贵的路径建一张**属性网**——先只断言必然成立的不变量，再看谁失败。

- `test: round-trip property suites`（三份新测试，editor-core 从 377 涨到 492）：
  - `serializeFuzz.test.ts`：90 条语料断言 `roundTrip(roundTrip(x)) === roundTrip(x)`。**全部通过**——这是本次最有价值的正面结论：序列化层在一大批畸形/边界输入上不会二次漂移。同一份语料的「原文片段必须出现」检查报出 4 处差异，逐一核对后确认全是**有意的规范化**（表格分隔行重新排版、`&amp;`→`\&`、词内下划线转义），没有内容丢失；已把这三条规范化连同理由写进用例，而不是放宽断言。
  - `editorRoundtripFuzz.test.ts`：同样语料走真实编辑器 `open → save`，断言「保存后再解析出的结构与原文一致」。这一层立刻抓到 5 处，其中 **2 处是真缺陷**（见下），3 处是 milkdown 自己的规范化（引用式链接被 `remark-inline-links` 内联、空单元格写 `<br />`），已改为显式断言 + 说明。
  - `link/schema.test.ts`：链接与文字 mark 的嵌套，9 例中改前 6 例失败。
- `fix(editor): keep the link outside the text marks` — 根因定位到 `@milkdown/transformer` 的 `SerializerState.#orderMarks`：按 `spec.priority` 升序，**先打开的在最外层**；所有文字 mark 默认 50，并列时保留 ProseMirror 的顺序，而 `strong` 排在 `link` 前。于是 `[**加粗** 链接](url)` 存成 `**[加粗](url)** [链接](url)`。修法是把 `link` 的优先级钉到 0（`inlineCode` 早用 100 做镜像）；`priority` 不在 milkdown 公开的 `MarkSpec` 类型里，故按自身类型断言回去并注明原因。
- `fix(export): do not print the empty-paragraph marker` — 第二个真缺陷横跨两个功能：空段落被 milkdown 序列化成独占一行的 `<br />`，解析时由 `visitEmptyLine` 删除，所以编辑器里看不到；导出直接读磁盘原文，于是把标记转义成**可见文字** `&lt;br /&gt;`，空表格单元格里最明显。修法是导出侧复刻删除，但**只删块级标记**（父节点不是 `paragraph`，或该 `paragraph` 只有这一个孩子）：写在文字旁的 `<br>` 是作者的内联 HTML，继续走原有的转义策略。定位过程中先按「有相邻行内节点就保留」的启发式写过一版，被 `> a\n>\n> <br />\n> b` 这个**我自己编错的**输入证伪（remark 把懒续行并进了 html 块，值变成 `"<br />\nb"`），改用「父节点类型」这一确定判据，并改用编辑器真实产出的字节做用例。
- 验证：editor-core 492、desktop 单元 1069、`pnpm -r typecheck`/`lint`、Playwright 91 全绿。

### 2026-09-11（第十轮）

承接上一轮的思路：把「同一份文本在编辑器与导出里必须得到同一结果」写成**差分断言**，而不是靠人肉比对。这一轮抓到本次最严重的一个缺陷。

- `fix(mdx): never let a component in an inline container truncate the document` — 差分断言的副产物：`# Title <Callout />` 的标题 id 在编辑器与导出里对不上，追下去发现编辑器**根本没解析成功**。根因是 `mdxJsxMdast` 的 `TEXT_BLOCK` 只列了 `paragraph/listItem/tableCell/tableHeader`：在这些容器里 JSX 保留为原始 `html` 节点，其它容器一律提升为块级 `mdxComponent`。而 `heading`、`emphasis`、`strong`、`delete`、`link`、`nekoHighlight` 的内容都是行内内容——块原子放不进去，ProseMirror 抛 `createNodeInParserFail`，**milkdown 把异常吞掉**：`open()` 正常 resolve，文档只剩解析到一半的部分，于是 Ctrl+S 就把残缺内容覆盖回文件。
  - 实测四种输入保存后是**空文件**：`alpha *em <Callout />* bravo`、`**st <Callout />**`、`~~dl <Callout />~~`、`[lk <Callout />](url) bravo`；`# Title <Callout />` 丢掉同文件其它所有块；`- a` + `# head <Callout />` + `- b` 只剩第一项。修法是把这六种行内容器并入 `TEXT_BLOCK`（沿用表格单元格那套既有的处理），JSX 以行内源码保留、原样写回。
  - 复核方式：先写「JSX 放进每一种容器，标记词一个都不能少」的数据丢失网（19 条，改前 7 条失败），修完再补 17 条**逐字节**往返断言；`# alpha <Callout />` 等 10 种形式现在输入输出完全相同，唯一不同的是表格单元格的列宽补齐。
- `fix(export): derive the heading id from text nodes only` — 同一批差分断言里的另一类不一致：导出用 `plainText` 拼标题文本时把原子的 `value` 也算进去了，而锚点按钮用的是 ProseMirror `Node.textContent`（只拼接文本节点，原子不贡献文字）。`# Claim [@smith2020]` 因此是编辑器 `#claim` / 导出 `claim-smith2020`，`# Formula $a^2$` 同理。现导出跳过 `inlineMath`/`math`/`nekoCite`/`html`/`mdxJsxFlowElement` 的 `value`，差分用例覆盖 16 种标题内容（含重复标题、CJK、混合原子）。
- 验证：editor-core 496、desktop 单元 1069、`pnpm -r typecheck`/`lint`、Playwright 91 全绿。

### 2026-09-11（第十一轮）

把验证推到最外层：不只断言单元行为，而是在**真实应用**里断言「用户按一次 Ctrl+S，磁盘上的字节有没有变」。

- `test(e2e): source-fidelity.spec.ts`（44 项）——打开笔记 → 切到源码模式 → 比对面板文本与文件字节 → 不做任何编辑直接 Ctrl+S → 再比对磁盘字节。第一版按「打开和保存都应当逐字节保真」写，跑出 17 项失败。逐条核对后分成两类：
  - **18 类确实逐字节保真**（frontmatter、加粗链接、任务列表、脚注、标题/强调里的 JSX、数学、CJK/emoji、围栏代码、嵌套列表、引用、自动链接、图片、双链、高亮、引用文献…）。其中「加粗链接」「标题里的 JSX」正是前两轮修的缺陷，这一层等于在应用级别复核了它们。
  - **9 类是规范化而非丢失**：行尾空格硬换行→反斜杠、多余空行折叠、缩进代码→围栏、`~~~`→```` ``` ````、setext→ATX、引用式链接内联、补末尾换行、空单元格写 `<br />` 标记、表格分隔行重排。逐条打印了规范化后的确切字节，确认内容都在、且「源码面板显示」与「保存写入」始终一致。这些改成**显式断言确切输出**——把契约钉住，而不是放宽断言糊过去。
  - 结论要如实说：**渲染模型是文档文本的权威来源**，所以打开时标签页会采用模型的规范化形式，未编辑的 Ctrl+S 会把这个形式写回文件。这不是崩溃级缺陷，但确实会改动用户文件；「未编辑就完全不动原文件」需要在模型之外保留原文并为局部编辑定义规则，属于独立的大改动，本轮**未做**，只把它变成有测试、有文档的已知契约。
- 顺带把「打开时会把内容换成规范形式」的成因定位清楚：`editorExternalSync.applyContent` 在渲染模式下有意把 `active.content` 换成 `editor.save()` 的结果（并保持 dirty=false），所以保存写的是规范形式。记录在案，未改动——这一段代码是为修「连按按键跳到开头 / 最后一个字符消失」而刻意设计的，没有充分理由不动它。
- 验证：e2e 135（91 → 135）、editor-core 496、desktop 单元 1069、`pnpm -r typecheck`/`lint` 全绿。本批次只新增测试与文档，运行时代码未变，因此**没有重新打包**：上一批产物 `release/nekowite_0.1.0_x64.exe`（SHA-256 `9d561487…`）已包含全部修复。

### 2026-09-11（第十二轮）

把上一轮的数据丢失网从「顶层 + 行内容器」推进到「**嵌套**」：内容不只是要出现，还要在表格单元格、脚注、列表项、引用里出现。

- `test(export): exportComposition.test.ts`（36 例）——把标记词塞进各种嵌套位置。第一轮就抓到 1 处：**表格单元格里的双链被拆成两个单元格**。
- `fix(table): escape unescaped pipes in raw HTML inside a table cell` — 追根因：GFM 用 `|` 分隔单元格，文本节点由表格构造的 `|` unsafe 模式自动转义，但**以原始 HTML 序列化的节点**（双链、组件、`<br />` 空行标记）走 `mdast-util-to-markdown` 的默认 `html` handler，而它只 `return node.value`。所以 `[[N\|alias]]` 存盘后成为 `| [[N | alias]] |`（多一格），重开时双链变成两段普通文字。
  - 修法：注册自己的 `html` handler，仅当序列化栈位于 `tableCell` 内时补转义。定位这一步花了几轮实测：先按「父节点是 tableCell」判断——**不成立**，mdast 里单元格内容还包着一层 `paragraph`（探针打出 `stack=["table","tableRow","tableCell","phrasing","paragraph","phrasing"]` 才确定用 `state.stack` 判断）。
  - 第二个坑同样靠实测发现：`<Comp a="x\|y" />` 里的原始 HTML **保留**作者写的 `\|`（remark-gfm 只对文本节点做反转义），若一律 `replace(/\|/g, '\\|')` 就得到 `\\|`——反斜杠成了字面量、管道重新变成分隔符，行照样被拆。故改为「只转义**未被转义**的管道」（按前置反斜杠的奇偶判断），并把这两种情形都写进测试。
- 验证：editor-core 553、desktop 单元 1069、`pnpm -r typecheck`/`lint`、Playwright 135、`cargo clippy -D warnings` + `cargo test`(105) 全绿。
  - 记录一次真实的**测试不稳定**：`GraphPanel > renders the full vault by default` 在并行跑 desktop 套件时偶发失败，单独跑该文件 14/14 通过；与本轮改动无关（本轮只动了 editor-core 的序列化与测试），重跑套件即全绿。没有为了让它变绿去改任何代码。

### 2026-09-11（第十三轮）

按自动循环里列的待办项走「搜索/索引在删除与重命名下的正确性」。

- 先读实现而不是先改：`vaultIndexCoordinator.applyMdChange` 的 `remove` 分支确实会清 `notes`/缓存/`persistence.remove(path)`，而 `buildIndexIncremental` 也会丢弃已不在文件列表里的条目——**删除与重命名的主路径是对的**，没有发现问题，如实记录。
- 但顺着这条线找到一处真实缺陷：`indexStateOf` 只单向校验。写测试确认（`indexStateOf(indexWithA, [])` 返回 `up-to-date`），再修成双向：缺条目的路径、以及「有条目但文件已不在」的路径都判 `stale`。
  - 同时如实标注：**该函数目前没有生产调用方**（全仓只有测试引用它）。所以这是一处潜在契约缺陷，不是线上故障；我没有把它写成「修复了索引错误」这种夸大的说法。
- `docs: correct the Rust index-store module doc` — `storage/index_store.rs` 的模块注释写着「今天没有磁盘索引可存」，而前端其实在 `.nekowite/index/` 里写分片 JSON 索引（校验和 + 原子替换）。这类「注释与实现相反」的说明比没有注释更危险，改为如实描述。
- 验证：desktop 单元 1070、editor-core 553、`pnpm -r typecheck`/`lint`、`cargo clippy -D warnings`、`cargo test`(105) 全绿。

### 2026-09-11（第十四轮）

继续追「静默截断」这一类最严重的问题，把范围从 JSX 扩到所有**块级节点**：行间公式、表格、代码块、标题、列表、组件，分别放进列表项、引用、脚注定义、表格单元格，共 19 种组合，断言标记词一个都不丢。

- 结果：**19 条全过，没有发现新缺陷**。如实记录这个「空手而归」——这一轮的价值是把这一类问题的防线铺开（上一轮的 JSX 版本抓到过 4 个「保存成空文件」的用例，这一轮说明其余块级节点的放置已经被现有实现正确处理），而不是为了显得有产出去改点无关紧要的东西。
- 已核对的既有守卫：`buildIndexIncremental` 会丢弃不在文件列表里的条目、`applyMdChange` 的 remove 分支清缓存并写回索引（上一轮）。本轮没有任何代码改动，只新增测试，因此**不需要重新打包**：HEAD 的运行时代码与 `release/nekowite_0.1.0_x64.exe`（SHA-256 `702b1daa…`）一致。
- 验证：editor-core 554、desktop 单元 1070、`pnpm -r typecheck`/`lint`、Playwright 135、`cargo clippy -D warnings` + `cargo test`(105) 全绿。

### 2026-09-13（第十五轮）

按用户要求「接入 AI、并做全场景测试」，本轮把 AI 从「能连上」推到「可控」，同时用真实应用把一批只在真机上才暴露的缺陷挖出来。

- **AI 接入（DeepSeek / 兼容网关）**：`default_base_url` 现在认识 grok 与 deepseek（此前没有默认值的服务商会把请求发到 api.openai.com）；流式解析新增 `reasoning_content`/`reasoning`，把推理过程作为 `ai-reasoning` 事件单独送出——推理模型在正文前会沉默数秒（实测约 27 个分片），此前界面看起来像卡死；状态栏新增「AI 思考中」指示。`max_tokens` 默认从 256 提到 1024，并在「推理吃光预算、正文为空」时给出明确错误而不是静默成功。
- **思考深度**：先实测再设计——对着线上端点用同一道推理题逐档打表（无参数 152 / none 0 / minimal 68 / low 110 / medium 213 / high 157 / xhigh 182 字符），并确认 `ultra`、`bogus-level`、`HIGH` 都会 400。于是取值白名单化，并在本地丢弃未知档而不是转发；三个服务商各自映射到自己的形状（OpenAI 兼容 `reasoning_effort`、Anthropic `thinking.budget_tokens` 且受 `max_tokens` 约束、Gemini `thinkingConfig` 且与既有 `generationConfig` 合并）。
- **AI 写入权限**：新增纯决策表 `services/aiPermissions.ts`（无依赖，34 例测试）与应用级 `stores/aiPermission.ts`（持久化策略 + 仅本次运行的授权 + 唯一的 `ask()` 入口）。两条写入路径接入：选区改写**在发请求之前**询问（被拒绝就不会把用户文字发给服务商），聊天面板的「插入文档」在改动编辑器之前询问。未知策略一律回落到询问。
- **删除文件夹找不回来**（P1）：文件树对目录同样提供垃圾桶按钮，`delete_file` 也会把目录移入回收站，但 `list_trash` 跳过所有非文件条目——删掉文件夹后回收站显示为空、无计数、无找回入口。这与代码里「目录删除后要关闭其下所有标签页」的逻辑直接矛盾。修法：列出目录（`is_dir`）并支持连内容还原；Rust 侧原本断言「目录不列出」的测试改为断言真实契约。
- **回收站显示编码键 + 碰撞还原出打不开的笔记**（P1）：`docs/a.md` 显示成 `docs%2Fa.md`；同一路径二次删除会在键上加时间戳，而解码把它并进文件名，还原出 `a.md-1757520000000`（扩展名不被识别 = 打不开）。两者都在 Rust 侧解码，重命名标记也插到扩展名之前。
- **还原到已删除目录必然失败**（P1）：不会创建父目录，失败还被显示成「请重试」，而重试不可能成功。现在创建父目录（与 `rename_entry` 一致）。
- **`.tmp` 恢复闭环的路径比较永远不成立**（P1）：`list_dir` 返回绝对路径，而被引用集合是 vault 相对路径，于是每张暂存图片都被当成崩溃残留。这一条上一轮已修（`stripVaultPrefix`），但真实应用里随即暴露出**更深的一层**：被引用集合只来自打开中的标签页，所以「磁盘上有笔记引用、但标签页没开」时仍然误判。实测确认（同一份 vault：笔记打开时提示为空，关掉标签页后立刻被计为可恢复），修法是「打开中标签页 ∪ 全库扫描」，并且全库扫描是惰性的（`.tmp` 为空就直接返回）。
- **`fs-change` 词汇表不匹配**（P1）：类型是裸 `string`，索引协调器判断 `'remove'` 而后端发 `'removed'`——被删除的笔记一直留在缓存与持久化索引里，图谱也留着过期节点。类型收紧为联合类型后，写错字面量变成编译错误。顺带合并了 `notify` 对一次写入发出的重复/派生事件。
- **外部改动检测挂在面板里**（P1）：整个能力（含 OS watcher 的挂载）都在 `FileTree.vue` 中，而它只在「文件夹」面板存在——默认的「笔记」面板下 vault 根本没被监听，外部编辑不被感知，下一次保存会静默覆盖别人的修改。现在监听在 vault 提交处挂载，判定与重载移入应用级服务。
- **推理模型下「停止」停不住**（P1）：请求 id 由后端生成，首个事件到达前窗口侧无 id 可取消；被放弃的请求继续流淌，迟到的分片被下一个请求采纳（问算术题答出 600 字散文）。改为前端在发起前选定 id 并随请求下发，每条流只接受自己的 id。
- **渲染视图的任务复选框点不动**（P1）：复选框是伪元素画的，背后没有 DOM 节点。新增点击插件（单事务、单步撤销、拒绝修饰键点击、只在左侧内边距生效）。
- **打印印错文档**（P1）：`print.css` 用 `display: block !important` 强行显示渲染面板，盖过 `v-show` 的内联 `display: none`；而源码模式下渲染模型被刻意留旧，于是源码模式切换笔记后打印会印出**另一篇笔记**。改为「所见即所印」，并用 `emulateMedia('print')` 在真实应用里逐模式验证（渲染/源码/对照各自只有正确的面板在打印流中）。
- **导出的 HTML 不含图片**（P2）：图片写成 `asset://localhost/...`，文件离开应用后全是坏图（同一文件里的字体却早已内联）。渲染器现在按目标形态请求：应用内打印/PDF 用显示 URL（输出逐字节不变），保存到磁盘的 HTML 内联为 data。组件体（Callout/FloatBox）内的图片此前完全不解析，规则已收窄；参考文献纯文本分支漏转义的 `key`/`authors`/`year` 已补上。
- **命令面板列出无法执行的命令**（P2）：没有打开文档时仍列出约 22 个格式命令，点下去毫无反应。现在直接说明原因（新增 `palette.noDocument`）。
- **插件授权跨 vault 泄漏 / 隔离无法解除**（P1，打包版因 CSP 门控暂不可达）：授权判决只以插件 id 为键且从不清理，A vault 的批准会授权 B vault 的同 id 插件；隔离提示让用户「重载 vault」，但重置函数无人调用、重载也清不掉标记。两者都已修正。
- **验证**：desktop 单元 1161、editor-core 580、plugin-host 100、Rust 144、Playwright 137 全绿；`typecheck`/`lint`/`clippy -D warnings` 全绿。真机（CDP 驱动打包前的 dev 构建）逐项复验：AI 全流程 3/3、聊天 7/7、取消 4/4、权限 9/11（两处失败经核实是探针自身取错消息）、思考深度 5/5、外部改动 11/11、目录回收站 7/7、碰撞解码 6/6、`.tmp` 恢复 3/3、导出 6/6、打印 5/5、索引删除 4/4、模式与渲染 13/16（三处经核实是断言口径不符，非缺陷）。
- 记录一条**测试自身的问题**：`GraphPanel > renders the full vault by default` 在并行跑套件时偶发失败——读盘计数满足时组件仍在 loading 态，断言抢在渲染前。改为等待表头文本稳定，并在并行套件里复跑通过。同类的还有 `App.appearance.test.ts` 的回收站断言，随 `display_name` 契约更新。

### 2026-09-13（第十六轮）

第二轮独立审计（AI 服务、附件与图片、搜索/索引/图谱、frontmatter）交回 12 条，其中一条是**静默数据损坏**。本轮全部处理完，并按惯例逐条在真机上复验。

- **P0：frontmatter 面板重写不属于它的 YAML**。审计给出的复现是「点一下标题字段再点走」，我用同一份文档在真实应用里复现了：`aliases:` 的块序列塌成 `""`、`cssclasses: [wide, dark]` 变成字符串、`meta:` 的嵌套映射塌掉、`标题: …` 直接消失——而标签页随即变脏并自动保存，损坏无声落盘。修法不是补特例，而是换掉模型：解析器按原始文本把 frontmatter 切成「顶层键 + 它的缩进/空行续行」的段落，面板只编辑它渲染的五个标量，其余段落原样回写。真机复验 7/7（块序列、流式序列、嵌套映射、非 ASCII 键、标量、正文全部保住），并且「未改动就不写入」仍然成立。
- **P1：Windows 上向已保存的笔记贴图必然失败**。我先在 Node 里跑真实函数体确认：Windows 路径下 `assetsDirForNote` 返回绝对路径，而后端拒绝非相对目录——所以「插入图片失败，请重试」是一个永远不可能成功的重试。真机复验 5/5：目录为 `notes/img_assets`、保存成功、文件落到笔记旁、显示解析正常。同一根因还让首次保存把绝对路径写进 Markdown，一并修掉；另外四处同类假设（两个解析器、拖拽后代判断、两处取文件名）也一起迁移到共享路径助手。
- **P1：聊天里超过 10 MiB 的图片让发送变成静默无操作**。超限在无人接管的 `await` 中抛出，调用方是 `void send()`：草稿不清、消息不发、毫无提示。现在添加时就拒绝并说明上限，发送失败一律提示；会话存储已有的「图片被容量上限移除」提示也接到界面上。
- **两处服务商请求必然被拒**：Anthropic 在启用 extended thinking 时不允许非默认 `temperature`（而应用默认 0.7），此前两者会同时下发——现在启用 thinking 时省略该字段（交给服务商默认），关闭时用户的 temperature 照常生效，两个方向都有测试钉住。Gemini 的 thinking 预算是输出额度的子集，超额的档位现在会夹到额度以内（Anthropic 侧原本就有这道夹取，Gemini 侧缺失），显式 `none`（预算 0）不受影响。
- **两处 Windows 路径比较**：图谱的目录筛选只按 `/` 切分，Windows 下每个节点的目录都是空串——下拉框只有「根目录」，任何文件夹都选不中（新测试在旧代码上确实失败）；命令面板的文件提示把原生目录与 `/` 拼出的根比较，于是显示整条绝对路径。
- **杂项 P2**：`DocStatsPanel` 是最后一个硬编码英文的面板，现已本地化（并顺手补上漏掉的标题）；侧栏附件徽章此前数的是 `attachments/` 下的**月份文件夹**，而旁边的面板列的是**图片**，两者天然不一致（「1」对着一屏 12 张图），现在递归数图片。
- **验证**：desktop 单元 1192、editor-core 580、plugin-host 100、Rust 145、Playwright 137 全绿；`typecheck`/`lint`/`clippy -D warnings` 全绿。真机复验：frontmatter 往返 7/7、图片粘贴 5/5、AI 思考深度 5/5、权限 9/11（两处为探针取错消息）、目录回收站 7/7、碰撞解码 6/6、`.tmp` 恢复 3/3、导出 6/6、打印 5/5。
- 记录一条**审计自身的局限**：Anthropic「thinking 与 temperature 互斥」这一条审计者未能联网核实（文档在该区域不可达），它按「文档明示行为 + 代码确实下发了这个非法组合」标注了，我也按同一置信度处理——两个方向的测试既钉住了修复，也说明即便规则与此不符，行为也不会退化。

### 2026-09-13（第十七轮）

把审计里剩下的一批「已确认但未修」清完，全部在真机上复验。

- **移动笔记会把图片全部弄坏**（P1）：移动只做 `rename_entry` 与标签页路径更新，而笔记内的图片引用是相对笔记的（图库 `../attachments/…`、粘贴 `a_assets/pic.png`）。新增 `services/noteMove`：先读正文（读失败整体中止）→ 连同名 `_assets` 目录一起移动并跟随改名 → 移动笔记 → 重写相对引用；只改相对 markdown 目标，没有可改写内容时完全不写文件。真机复验 7/7：改名后的自有资源引用、层级变化后的图库引用、正文与标题都正确。
- **关闭面板会丢掉已生成的回答**（P1）：关闭右栏销毁聊天面板，请求继续跑（继续计费）并写进已销毁的组件，用户的回答要等切换会话或重载才可能看见。现在关闭时同时经由面板句柄与应用级注册表取消（句柄在 Promise 落定前为 `null`，只做一边会漏），并把部分回答持久化并标记「已中断」。真机复验 6/6：部分回答仍在、标记可见、没有请求仍在运行。
- **长 frontmatter 丢元数据**：扫描先截 400 字符再找块，长块永不闭合 → 列表/标签/索引里失去标题与标签，而属性面板仍显示它们。改为先定位块（有上限）再对块之后的正文取样。
- **删除文件夹后笔记列表残留**：文件夹事件只以文件夹本身到达，非笔记分支此前不触发重新索引，于是被删文件夹里的笔记一直留在列表里。现在按索引判断结构性影响并重新索引，同时用测试钉住「普通附件写入不重读整个 vault」。
- **链接后备匹配在 Windows 上失效**：拿原生反斜杠路径与 `/` 前缀候选比较，永不匹配。改为按 vault 相对路径比较。
- 三处修复各自都在**旧代码上验证过测试会失败**（临时还原后再跑），确认新测试真的在测那个缺陷，而不是恰好在修复后才通过。
- **验证**：desktop 单元 1220、editor-core 580、plugin-host 100、Rust 148、Playwright 137 全绿；`typecheck`/`lint`/`clippy -D warnings` 全绿；性能夹具（10k 笔记索引 1.0s、检索 p95 6.6ms、图谱布局 2k 节点 0.92s）全绿。
- 记录两次**探针自身的误报**并如实纠正：命令面板「查不到命令」其实是因为没有打开文档（面板刻意不列出无法执行的命令），引用面板报错则是我把 Map 当成数组调用 `map()`——两者都不是产品缺陷。

### 2026-09-13（第十八轮）

这一轮同时启动**第四批独立审计**（四个互不重叠的范围：Rust 后端全量、editor-core 的用户输入路径、服务层与状态层、界面与可访问性/i18n），本条记录的是审计仍在跑时就已经确认并修完的三件事。

- **公式对话框第一次打开时没有可视化编辑器**（P1）：对话框只挂载「此刻就能用」的那个编辑器，而首次打开时 MathLive 的懒加载还没落地——用户写下的**第一个**公式拿到的是朴素的 `contenteditable`，而不是这个功能所宣称的可视化公式编辑器；第二次打开（模块已到）才正常，所以它看起来像「时而好用时而不好用」。改成先挂一个能用的编辑器、等 MathLive 到达后**升级**并把已输入内容带过去。踩到的坑记下来：取值必须在升级的**那一刻**做（传 getter），最初在请求升级时就取值，于是升级期间敲进去的字被升级前的旧值覆盖；这条顺序现在有测试钉住，写反了就会失败。
- **在应用外重命名笔记所在文件夹后，下次保存会静默重建旧路径**（P1）：标签页不知道自己指向的文件已经不在了，`Ctrl+S` 把整篇笔记写回那个已被改名的旧路径，目录被重新创建——用户手上出现**同一篇笔记的两个分叉副本**，界面上没有任何提示。现在外部改动检测会对变动路径下**打开中的标签页**逐个探测存在性，命中的标签页转为「未命名」并保留全文（下次保存走另存为询问），并提示用户发生了什么。**关键教训**：不能按事件种类门控——Windows 上重命名文件夹发来的是两个 `modified` 事件（实测），按 `removed` 判断永远不会命中；必须按行为（路径是否还存在）判定。真机复验 6/6。
- **两处「文档说了但代码没做」**：README 暗示可以安装自己的插件，而发行版因 CSP 门控**不会加载** vault 插件（本版本没有隔离机制），已在 persona、状态与插件开发三处如实写明；`docs/PERF.md` 声称「每一项都有上界断言」，而 `index-build-10k` 只记录耗时，补上 `expect(ms).toBeLessThanOrEqual(2000)`。
- **验证**：desktop 单元 1224、editor-core 585、plugin-host 100、Rust 148、Playwright 137 全绿；`typecheck`/`lint`/`clippy -D warnings` 全绿；性能夹具全项在预算内。
- **打包**：`bash scripts/package-win.sh` → `release/nekowite_0.1.0_x64.exe`，SHA-256 `8d3a7ecd05a07dfde3dad53901fbc4e263e9ab55ec3ff3cbdb958ca243b09c3c`。

### 2026-09-13（第十九轮）

第四批独立审计（四个互不重叠的范围）交回后，本轮把其中**已核实**的部分修完并逐条在真机上复验。审计共交回 40 余条，下面只列已修并有测试钉住的；未修的仍在待办里。

**数据安全**

- **重命名任何文件都会破坏回收站**（P0，Rust）：`move_trash_key` 用 `name.strip_prefix(&from_key).unwrap_or("")` 匹配，再判「后缀为空即精确匹配」——`strip_prefix` 在不匹配时返回 `None`，`unwrap_or("")` 把「与我无关」变成了「就是我」，于是回收站里**每一条**都会被改名成新 key；两条落在同一毫秒时 `fs::rename`（Windows 上会覆盖）会直接销毁其中一条的内容。实测：回收站放 a/b/c 三条，重命名 `keep.md` 后只剩两条同名的 `keep2.md*`，`CONTENT-b.md` 永久消失。现在按**解码后的路径**匹配（顺带让 legacy `__` 编码的条目第一次能跟随重命名），碰撞按 13 位时间戳递增而不是拼接（保持 `strip_collision_suffix` 能识别的时间戳形状，且不会落在已占用的名字上）。
- **历史快照失败会连带让保存失败**（P1）：`write_file` 里的 `snapshot_history(...)?` 把可选部件当成前置条件——历史目录不可写（权限、占满、同名文件占位）时**已有笔记完全存不了盘**，而且前端只看到一句裸 OS 文案。快照改为尽力而为：`write_file` 现在返回 `Result<Option<String>, String>`，`Ok(Some(warning))` 表示「正文已写盘，另一件事没成」，窗口把它作为提示显示。同时给 `hard_link` 加了回退——FAT32/exFAT 卷根本不支持硬链接，那种盘上「新建能存、改已有必失败」的分裂现象现在没有了。
- **`.tmp` 清扫器会删掉用户自己的 `.tmp` 文件**（P2）：判定用的是「名字以 `.tmp` 结尾」，于是笔记文件夹里的 `draft.tmp` 会被下一次保存**永久删除**（不进回收站、没有历史快照，无法恢复）。现在只回收本程序自己写的形状：`.<名字>.<纯数字 nonce>.tmp`。
- **「关闭全部」不保存也不提示**（P1）：`closeAll` 直接循环 `removeTab`，未保存的编辑与未命名文档一次点击全没。现在与关闭单个标签同一套规则：先 flush 有路径的、再对未命名脏文档弹「保存/丢弃」，保存失败即中止；vault 切换走新的非交互 `removeAllTabs`（它已经 flush+提示过，再问一次是另一个 bug）。
- **外部重命名文件夹后，标签页的未保存文字被标成"已保存"**（P1，我上一轮引入的）：`detachMissingPath` 无条件 `savedContent = content; dirty = false`，于是以 `dirty` 为准的每一道保护（关闭、切 vault、关窗口、自动保存）全部跳过它，而提示语还写着「内容仍在这里」。现在 detach 后仍有文字的标签保持 dirty（空标签保持干净，免得对着白纸弹窗），自然走「另存为」。
- **源码模式跨文档撤销会把上一篇删掉的文字写进当前笔记**（P1）：`setText` 的 `addToHistory.of(false)` 只让整篇替换不进历史，CodeMirror 并不清空 undo 栈，旧文档的删除类事件被位置映射后仍可执行。实测「A 里删掉 `note ` → 切到 B → Ctrl+Z」得到 `BBB note B bodynote `，而 SourcePane 的 50ms debounce 会把它发布给 `tab.content` 并自动落盘。现在 `history()` 放进 `Compartment`，换文档时先移除再重新加入（实测这是唯一能真正清空的做法，直接 reconfigure 无效）。

**外部改动检测**

- **事件合并丢掉了突发里的最后一次修改**（P2）：判定是前沿触发——窗口内第一笔发出、后续丢弃且**不刷新时间戳**。两次相隔 50ms 的外部写入只会报第一笔，打开中的笔记 reload 到已经过时的内容，之后不再有事件纠正，用户接着保存就覆盖了更新的文本。现在被丢弃的事件会被**挂起**，突发安静后按尾沿重新发出，因此订阅者看到的永远是最后一笔。
- **隐藏目录过滤作用在绝对路径上**（P2）：vault 自己放在点开头目录（`~/.notes`）时，每一个事件的绝对路径都含隐藏段，于是**全部被丢**——应用以为在监听，实际外部改动永远不出现。过滤改为相对于监听根。
- **watcher 出错被静默丢弃**（P2）：notify 报错（队列溢出、句柄耗尽）意味着事件已经在丢，而前端毫无察觉。现在会发出 `kind: "resync"`，`externalDocSync` 收到后逐个复核打开中的标签页。

**AI**

- **流内错误帧被忽略**（P2）：服务商在 200 响应里发 `{"error":…}`（OpenAI 兼容）或 `{"type":"error",…}`（Anthropic）时，旧解析器返回 `None`——半截答案被当作完整回答接受，`ai-done` 照发。现在会报错并结束请求。
- **`data: [DONE]` 不结束循环**（P2）：答案其实已经完整，但循环只认 EOF；服务端若在 `[DONE]` 后保持连接，用户要等到 120s 读超时，然后一个**已经成功**的请求被报成失败。现在 `[DONE]`即结束。
- **`finish_reason` 从未读取**（P2）：`length`（预算耗尽）与 `content_filter` 与正常完成无法区分。现在会明确报出原因与要改的设置，而不是把截断的片段当完整答案。
- **取消不能立刻生效**（P2）：取消只是摘掉集合里的 id，而循环只在两次 `stream.next()` 之间看它——推理模型沉默数十秒期间，被取消的请求仍占着连接、并发槽位并继续计费，连续取消几次就会撞上「AI 请求过多」。现在每个请求带一个 `CancellationToken`，读循环与它赛跑，取消立刻放下响应体。被取消的流也不再 flush 尾部、不再发 `ai-done`。
- **主线程阻塞**（P2）：保存 API Key、设置/输入主密码都是同步 `#[tauri::command]`，跑在主线程——19 MiB 的 Argon2id 加 Stronghold 落盘期间窗口完全冻结。改为 `async`，与 `fs.rs` 一致。

**存储与界面**

- **只改大小写的重命名永远失败**（P2）：`note.md → Note.md` 被拒，提示还写着「target already exists: Note.md」——用户请求的名字被告知已存在。现在允许（Windows 需要经由临时名两步完成，实测直接 rename 会"成功"但磁盘上还是原名），并且返回**新的拼写**给调用方（解析发生在移动前，直接复用会拿到旧大小写）。
- **插件的"安全策略"提示在每次启动时弹出**（P2）：即使 vault 里根本没有 `plugins/` 目录，也会显示一句英文安全提示（还会往每个 vault 写一条插件审计记录）。现在先列目录：没有插件就什么都不说——功能没被请求过，不是静默失败。提示文案也接进了 i18n（此前是硬编码英文）。

**验证**：Rust 156、desktop 1313、editor-core 585、plugin-host 100、Playwright 全绿；`typecheck`/`lint`/`clippy -D warnings` 全绿。真机（CDP 驱动 dev 构建）7/7：回收站三条在无关重命名后名字与内容都完好、大小写重命名成功并回报新名字、用户 `.tmp` 在保存后仍在、历史被占位时保存成功且带回警告、正文确实落盘、无插件 vault 启动后没有任何提示。

### 2026-09-13（第二十轮）

第四批审计剩下的三块（editor-core 用户输入路径、界面与可访问性、服务与状态层）修完，全部有「在旧代码上验证过会失败」的测试，并在真机上抽查复验。

**编辑器（12 条）**

- **作者写的 `<br />` 被解析阶段删除**（P1）：commonmark preset 的 `visitEmptyLine` 会无条件 splice 掉值为 `<br>`/`<br/>`/`<br />`/`<br >` 的 html 节点——那本意只是「空段落标记」这一个约定。于是 `line1<br />line2` 打开成 `line1line2`，下次保存把丢换行的结果写回文件；表格单元格里更严重，因为 GFM 单元格里这是**唯一**能写换行的方式。现在哨兵只把行内 `<br>` 送过 transformer，块级标记仍按原约定处理。
- **表格剪贴板劫持所有 Ctrl+V**（P1）：复制过一次单元格后，往**任何**表格里粘贴都会用旧缓冲区覆盖当前单元格，而且 `preventDefault()` 让原生 paste 根本不触发——往单元格粘图片彻底失效，缓冲区还能跨文档、跨编辑器实例存活。现在拦截要求「当前是单元格选区」且「缓冲区属于当前文档」。
- **光标在单元格里插入块级内容会拆表**（P1）：分隔线、组件、表格对话框、插入图片、AI 插入、行间公式都会把表格拆成两张（GFM 单元格只接受段落，ProseMirror 的 fitter 只能把块「提升」出去）。现在这些在单元格里被拒绝（文档一字不变，而不是被重新排列），行内内容照常插入，`insertTable` 也拒绝。
- **在单元格里输入 `---` 拆表**（P1）：preset 的分隔线输入规则没有 schema 守卫，第三个按键就拆表。现在换成带守卫的同 regex 规则（输入规则是「首个匹配者生效」，所以必须替换而不是追加）。
- **单元格里 Shift+Enter 的硬换行保存后什么都不剩**：现在写成 `<br />`，与解析侧同一约定。
- **单元格里公式的 `|` 变成 `\|`**：LaTeX 里 `\|` 是双竖线，渲染结果与作者所写不同。现在单元格内的公式有对应的反解。
- **公式里的 `$` 会被腰斩**：`a$b` 写成 `$a$b$`，会被读成公式 `a` 加文本 `b$`。含 `$` 的 latex 改用 `$$…$$` 包裹。
- **表格对话框行数下限不一致**：步进器允许 1、对话框 clamp 到 2，用户请求的尺寸被静默改写。现在共用同一组上下限。
- **切笔记后第一次 Ctrl+Z 被吞掉**：上一篇的历史还在栈上，其逆操作经位置映射后变成空操作，表现为「撤销坏了」。打开文档时重建编辑状态。
- **代码块里粘贴富文本会拆开代码块**：现在代码块内只取纯文本。
- **引用编号每键全量重算**（实测 800 处引文约 96ms/按键）：每个文档版本只算一次，chip 读缓存。

**界面与键盘（14 条）**

- **Tab 被 AI 补全吞掉**（P1）：焦点出不了编辑器；未配置 AI 时每次误按还弹错误。现在只在 AI 可用时触发，且不重复处理 ProseMirror 已消费的 Tab（表格里 Tab 换格不再同时触发补全），无补全时放行默认行为。
- **输入法下 Enter/Esc 被抢**（P1）：重命名对话框、文件树内联重命名、属性面板都不检查合成态，按 Enter 选词会直接提交（文件可能被改成半截拼音），按 Esc 想取消候选词会关掉整个对话框。现在统一走 `keyGuard`，覆盖全应用的 Enter/Tab/Escape 处理器。
- **文件树无法用键盘操作**：文件名是 `<span>`（Enter 无效），唯一的 Tab 停靠点是看不见的删除按钮。现在文件名是按钮、caret 有可访问名与 `aria-expanded`、删除按钮在聚焦时显示。
- **对话框**：模板选择器不接管焦点（第一次 Esc 无效）；一次 Esc 会关掉**所有**打开的对话框（它们都监听 window，而 `stopPropagation` 取消不了同 target 的其它监听器）——现在有模态栈仲裁；冲突提示与 AI 写入授权把焦点放在破坏性/放行按钮上（回车即生效）——现在焦点落在对话框本身；设置面板与命令面板声明了 `aria-modal` 却没有焦点陷阱；插件授权/完整性对话框完全没有 role/trap/Esc。
- **文案**：大纲与历史面板在列表有内容时仍显示「没有内容」提示；AI 设置区四个标签硬编码英文（对应翻译早已存在却零引用）；冲突提示英文句式把路径占位符置空，读作 `Disk content of  changed`。

**状态与服务（8 条）**

- **`suppressReapply` 是模块级布尔**：A 标签的后台保存会 arm 它，而被消费的往往是**切标签**那次内容变化 → 编辑器模型里还是上一篇的文字，下一次按键把它写进当前笔记。现在按标签记账。
- **收藏/最近跨 vault 被剪枝删除**：只有一份存储，剪枝谓词却是「当前 vault 的索引里有吗」。现在按 vault 分桶，旧格式会迁移（移动而非复制）。
- **documentList / view / bootstrap 裸用 localStorage**：getter 抛错的 webview 里 store 构造即抛（白屏），配额满时点收藏会抛到事件处理器。现在统一走 persistence 端口。
- **窗口几何物理/逻辑像素混用**：125%/150% 缩放下保存的尺寸下次启动被裁成整屏并贴到左上角，副屏窗口被拉回主屏。现在采集与还原同一坐标系，边界取窗口所在显示器。
- **拼写建议弹窗坐标过期**：文档变化后点击建议会改错位置，文档变短还会抛 `RangeError`。
- **`savedContent` 存的是序列化结果而非磁盘字节**：CRLF 文件上 `disk === savedContent` 永不成立，任何外部触碰都被当成真实修改（干净标签被 reload 丢光标，脏标签弹不存在的冲突）。现在有 path 的文件保留磁盘字节。
- **附件角标可能写入旧 vault 的计数**：debounce 路径丢了 seq 守卫。
- **源码面板撤销历史是「每编辑器」而非「每文档」**：切笔记后第一次 Ctrl+Z 会把**上一篇**删掉的文字插进当前笔记（50ms debounce 还会把它发布给 tab、标脏并自动保存）。

**验证**：Rust 156、editor-core 639、desktop 1313、plugin-host 100、Playwright 137 全绿；`typecheck`/`lint`/`clippy -D warnings` 全绿。真机复验：模板选择器打开/跨导航/Esc/连续三次开关、焦点确实在弹窗内，共 5/5 且零控制台输出（此前 e2e 报的崩溃被证实是**巡检脚本**删掉了 Vue 拥有的 `.dialog-overlay`，而非产品缺陷——该脚本已改为先按 Esc 让应用自己关闭）。同轮另外修正了两处**测试自身**的问题：CSP 用例断言「插件目录连列都不列」（新契约是先列目录、不读代码，因为「有插件但加载不了」才值得提示）；e2e 的 `list_dir` mock 对任何路径都返回同一份列表，导致目录看起来包含自己、vault 遍历永不终止、页面卡死。

**待办（审计已交回、本轮未处理）**：`search_notes` 的 100 条截断没有标记；存储层错误信息仍是裸 OS 文案；`list_history`/`list_trash` 在目录不可读时返回空；`clear_trash` 部分成功即报错；AI 的 `usage` 未采集；watcher 的 `WRITE_LOCK` 是进程级（跨 vault 串行）。

### 2026-09-13（第二十一轮）

第五批审计（导出/搜索/恢复/会话，以及**首次**并发与竞态专项）交回后，本轮修完其中已核实的部分。

**保存与重载的竞态（三条，全部为静默数据问题）**

- **同一标签并发保存**（P1）：Ctrl+S 连点、或自动保存定时器撞上手动保存时，会写两次（等于两次历史快照），而且**后完成**的那次赢得状态而不是后发起的那次——先发起、后完成的保存会用更旧的文本覆盖 `savedContent` 并清掉 `dirty`，界面显示「已保存」而窗口对磁盘的认知已经过时，随后 watcher 事件（disk ≠ savedContent）被判成「外部修改」。现在第二次保存会等待前一次，且仅当期间有新输入时才再写一次。
- **保存在切换 vault 之后落地**（P1）：写盘发生在按键之后的若干个 await（flush、资源搬迁），而它是在写的那一刻读 `vault.value` 的。于是切换 vault 期间在飞的保存会把**旧 vault 的笔记写到新 vault 根部**——用户凭空多出一篇自己没建过、内容是别的 vault 的笔记，并且会进索引、进搜索。现在写在写之前校验「仍是发起时那个 vault」，否则保持脏。
- **外部改动触发的自动重载吞掉输入**：重载是异步的，而它正是「用户可能开始打字」的时刻；无条件赋值会把期间的按键丢掉并清 `dirty`，于是已经排上队的自动保存发现无内容可存——那段文字存在了一瞬就消失了，任何地方都没有副本。现在若标签在读取期间发生变化就放弃重载。「以磁盘为准」是用户在冲突提示里**显式**选择的，仍然无条件生效。

**查找/替换（两条，会改错文字）**

- **替换使用了上一次的匹配范围**：范围是防抖缓存的，跨笔记（或外部重载）后仍然生效，于是在 B 里按 A 的偏移替换——**改掉 B 里无关的文字并自动保存**；新文档更短时抛 `RangeError`（未捕获，表现为「按钮没反应」）。现在替换前逐个校验范围（在当前文档内、仍然包含所查文本、不重叠），不合格就丢弃。
- **超长查询词让正则编译失败**：V8 对模式长度有上限，抛出的 SyntaxError 从输入事件里冒出来，面板停在上一次查询的范围上——此时点「全部替换」替换的是用户早已放弃的那次搜索的匹配。超长查询退回字面量扫描（语义相同）。

**导出（两条，导出内容与所见不一致）**

- **硬换行在导出里消失**：mdast 把 shift+Enter 建模成**没有子节点**的 `break`，渲染器没有这个分支，而「渲染子节点」对无子节点返回空串——于是两行被粘成一行，导出的文件里出现了作者从未写过的句子（HTML/PDF 都是）。
- **表格列对齐丢失**：GFM 把对齐放在 table 节点上，渲染器从未读取，右对齐的数字列导出后变成左对齐。

**恢复提示**

- **第二个提示会顶掉第一个，被顶掉的调用方永远等不到结果**：告警卡只有一个槽位，后来的提示直接覆盖前一个而不结算它的回调——其中一个回调正是 vault 切换的 promise，切换在等它。于是「未命名文档」提示显示期间来一个恢复提示，点「打开文件夹」就**完全没有反应**（无报错、无进度）。现在提示排队、逐个显示。
- **`.tmp` 扫描与 GC 并发**：提示里列出的文件可能在毫秒前已被 GC 删除，而恢复失败被 `.catch(() => {})` 吞掉——用户点「恢复」，什么都没有发生。现在先 GC 再扫描，恢复失败会报告哪些文件没能移动。

**验证**：desktop 1322、editor-core 643、plugin-host 100、Rust 158、Playwright 137 全绿；`typecheck`/`lint`/`clippy -D warnings` 全绿。新增测试全部在**旧代码上验证过会失败**（tabs 3 条、查找/替换 3 条、导出 3 条、提示队列 1 条）。真机（CDP 驱动 dev 构建）6/6：跨笔记的陈旧替换没有改动另一篇、连续两次保存只产生一次历史快照、标签在保存后干净、正文确实落盘、第一个提示被正确结算、第二个提示在前一个被回答后显示。**如实记录一处探针自身的弱点**：跨笔记替换那条真机探针里 `stale` 为 0（切换后范围已被清空），所以那条断言实际证明的是「没有改错」，而不是「用陈旧范围也不会改错」——后者由单测（显式注入陈旧范围，旧代码上失败）覆盖。

### 2026-09-13（第二十二轮）

本轮由「全场景审计（真机 + 代码）」驱动，重点是**应用对用户说了假话或什么也没说**的那些路径：写盘失败称成功、回调抛错无提示、监听没建立却装作在跟踪、重命名自己的文件却被判成外部删除。

**P1 应用内重命名把自己的标签页摘掉（真机 3/3 复现）**
- 台账：在笔记列表点开 `note.md` → 文件夹视图右键重命名 → 标签立刻变成「未命名」，并弹出「已在应用之外移动或删除」；磁盘上 `renamed.md` 内容正确。
- 根因：watcher 把重命名报告为**父目录**的 modified，`externalDocSync.checkTabsUnder` 会对该目录下每个标签页做一次读取来判存在性；此时旧的 `renamePathInTabs` 还没跑，标签仍指向已不存在的旧名 → `onMissing` → `detachMissingPath`。
- 修复：移动操作先**声明**该路径（`tabs.beginMove/endMove/isPendingMove`，声明不是计时器，覆盖整个操作；目录声明覆盖内部笔记），外部变更服务跳过被声明的路径。补一条修路：重命名已落地但正文改写失败时，内联重命名与拖拽都会把标签重新指向真实存在的文件并让编辑器采纳其字节（脏标签保留用户文字）。
- 证据：`externalDocSync` 3 例 + `tabs` 2 例 + `FileTree` 2 例，其中 6 例在修复前源码上确认失败（stash → 跑 → pop）。

**P2 聊天层的「静默丢失」四处**
- `PersistencePort.set` 吞掉配额异常 → `chatSession` 的「去掉图片重试」永不执行 → 整段对话在下次启动消失。现在端口返回是否写入成功（源码兼容），store 据此重试并提示；连纯文本都写不下时如实告知。
- `imageNotice` 被面板转换丢弃且从不渲染 → 附件无声消失。现在往返并在气泡下方显示。
- 一条消息的图片**张数**无上限（只限单张大小），而它们进的是同一个请求。上限 6 张 + 提示。
- 先流出文字再失败的回复被当作完整答复。现在标记 `interrupted`。

**P2 长笔记只送开头**：上下文预算改为「开头 + 结尾」两段保留（省略提示插在缺失处），选区仍从开头截断。另外草稿改为按会话寄存（切走存、切回还原、删除会话丢弃、发送后遗忘）。

**P1 插件回调不隔离**：工具栏按钮/命令的回调运行在激活 try/catch 与 `emitLifecycle` 隔离之外，抛异常会从 DOM 处理器冒出去，没有插件名也没有提示。现在注册时包一层隔离，报错走生命周期同一条通道，来源写作 `toolbar:<id>` / `command:<id>`，每会话只提示一次、每次都写日志；新增 `PLUGIN_CALLBACK_ERROR`。

**P2 文件监听建立失败被吞**：`indexVault` 订阅失败后静默继续，界面看不出任何异样，而所有外部改动都不再被跟踪。现在报告一次，并且「重建索引」会重试订阅（恢复时告知）。

**同时修掉**：搜索覆盖层排队中的延迟刷新在面板销毁后仍会执行（真实使用是关闭时偶发报错，测试里直接让 desktop 测试进程带着未处理错误退出）。

**验证**：desktop 1356+、editor-core 643、plugin-host 103、`typecheck` / `lint` 全绿；每条行为改动都在修复前源码上确认过测试失败；真机（CDP 驱动 dev 构建）复现 P1 并确认修复后标签跟随新名。

**并行处理（子代理，同一轮）**
- **三个死开关落地**：`confirmBeforeDelete` / `autoSyncScroll` / `renderTaskChecklist` 从「可改可存但无人消费」变成真实行为；删除路径另加在途保护。真机 10/10（关掉开关后单击即删、滚动不再联动、任务项变纯文本且点击不切换）。
- **「跟随系统强调色」成真**：新增 Rust 命令读 `AccentColorMenu`（回退 `ColorizationColor`），按 Lab 距离映射到既有色板（**色板未动**）；读不到时回退主题取色并在设置里如实说明。真机 7/7。
- **`create_new_file`（仅创建不覆盖）**：后端用 `hard_link` 发布暂存字节，使「检查 + 创建」成为一步；`ensureDailyNote` 改用它，遇到 `AlreadyExists` 视为「别人先建了」。
- **模板行尾空格**：默认日记模板 + 9 个模板文件共 14 处行尾空格清理（每篇从模板新建的笔记都会继承）。
- **插件装饰画两遍（真机发现）**：`viewDecorations()` 会同时收集视图顶层 `decorations` prop **和**每个插件自己的 `props.decorations`，而覆盖层 provider 又把插件装饰合并进自己那份 → 非幂等装饰（widget）出现两次（AI ghost 两个 span）。已让 provider 只返回自己的标记；新增一个挂真编辑器、断言 `.ghost-text` 恰好 1 个的用例（修复前为 2）。

**第三批（并行子代理 + 本人，同一轮）**
- **引用库（带真机验收）**：一条坏条目导致整库读成空（citation-js 一次性解析）→ 改为逐条解析（BibTeX 花括号配平 + RIS `ER  -`），跳过的条数明确告知；任何 `.json` 都被当 CSL 库 → 只有顶层数组且产出可用条目才算库；不在库里的键渲染成 `[3]` 与正常引用无法区分 → 宿主注入解析器，渲染为 `[?]` 且不占编号；引用库只在打开 vault 时加载一次 → fs 事件（防抖）重新加载并刷新芯片；「无标题」被说成「未在库中找到」→ 分开。真机证据：坏 `.bib` 载入 2 条 + 「1 条被跳过」提示；未知键在文档里是 `[?]`、面板里是「未在引用库中找到」；外部改写 `.bib` 后徽标 3 → 2 → 3。
- **`.tmp` 恢复闭环（带真机验收）**：扫描结果无法表达「不完整」，而恢复/GC 都不可逆 → 新增 `complete` 标记，不完整时不给恢复提示、不执行 GC；目录列举失败不再等同于「目录是空的」。真机走通：提示 → 恢复（移动进 `attachments/2026-09/` 并删原文件）→ 被**已关闭**笔记引用的文件不动 → 8 天前孤儿被清扫 → 提示到点击之间文件被删时报告「1 个无法恢复」。
- **删除笔记带走它自己的 `_assets`**：此前只移动 `.md`，图片目录永远留在磁盘上（附件面板只遍历 vault 级 `attachments/`，既列不出也回收不了）。现在两者一次进回收站：先探测目录是否存在（笔记删掉后再探测，「出错」与「本来没有」无法区分）→ 删笔记 → 删目录；目录失败作为**部分结果**单独提示。文件夹行刻意不走这条路径（文件夹删除自带整棵子树，误把文件夹名当笔记名会指向无关的兄弟目录）。
- **「从模板新建」换名重试**：改为 `create_new_file`（只创建不覆盖）+ 按 `name-1`、`name-2` 重试，重试逻辑放进 `services/noteCreation.ts` 以便测试。
- **聊天单条消息附件总量上限** 20 MB（此前只限单张与条数，六张 10 MB 就是约 80 MB 的 base64 文本进一次 IPC）。
- **附件面板切换 vault 的迟到解析**：`resolveSrcs` 补上 run 令牌守卫（与 `reload()` 一致），不再显示上一库的缩略图。

**第四批（本人，同一轮）**
- **真实 AI 端到端验收**（`apps/desktop/ai-lab/286-live-ai.cjs`，对 `https://tokenflux.dev/v1` 的 `deepseek-flash` 真发包，**6/6**）：流式补全、`ai-done` 带完整正文、**思考深度「高」= 165 个推理增量 vs「不思考」= 0**（同一问题同一模型）、不存在的模型名返回带服务商说明的 403、中途取消 3 ms 返回。
- **插件写入纳入写入策略**（P1，与「AI 权限管理」直接相关）：未声明任何权限的插件此前可以无条件改写文档（宿主把真实编辑器交给了它），而声明 `ai` 的插件反而没有能力。现在发布给插件的是**受策略约束的句柄**：只读接口透传，写入走 `useAiPermissionStore().ask()`，拒绝时报错并抛出（不静默）。真机无从复现（生产 CSP 不加载库内插件），但单元用例覆盖了拒绝/询问/直写三条路径。
- **`suppressReapply` 的抑制加 TTL**：没有期限的一次性抑制会吞掉下一次真实的内容变化（外部改写/冲突重载），让编辑器停留在过期文本并在下次保存时写回覆盖。
- **笔记上下文长度改为设置项**（默认 6000，范围 1000–32000）：此前写死 2000，长文档下用户无法让模型看到自己正在写的部分。
- **`CONTENT_SEARCH_CONCURRENCY` 去掉重复声明**，收敛到唯一来源。

**查证后确认「不是 bug」的一项**：插入空表格后，磁盘上每个单元格写成 `<br />`（`| <br /> | <br /> | <br /> |`）。真机复现（`apps/desktop/ai-lab/292-table-empty.cjs`）确认这是**有意为之**：单元格在 schema 里必须持有段落，而 Milkdown 对「没有内容的段落」统一写 `<br />` 标记，这样重新打开时单元格不会塌掉（remark 对真正空的单元格的解析会让段落消失，进而可能丢列）。我按「空单元格就该写成空」改了一版，结果 editor-core 里三条把该约定钉住的用例立刻失败（其中一条就叫「keeps the empty-cell marker round-tripping」），并且我的改动还会误删用户自己写在单元格里的真实换行（`<br />` 是同一种拼写）。结论：**按约定保留**，改动退回；`table/stringify.ts` 与 `tableBlockInsert.test.ts` 回到原状（`git checkout`）。这条记在这里，是为了下一个人不要把它当 bug 再改一遍——要改的话，得先让解析端能在不写标记的情况下保住空单元格。

**第五批（本人，收尾）**
- **`ai` 权限不再是空头支票**：插件主机此前根本没有 AI 接口，于是「声明了 `ai` 的插件」什么也拿不到，而「什么都不声明的插件」反而能绕过应用去够模型——正是权限对话框想要防止的那种倒挂。现在宿主向**声明过 `ai`** 的插件提供 `ctx.ai.complete(prompt)`（没声明就拿不到，靠伸手是拿不到的），而模型仍然属于应用：主机只接受由应用注入的 provider（`setPluginAiProvider`），应用侧适配器走自己的聊天补全入口，因此端点、Key、token 预算都由用户设置决定，插件无法读取 Key 或改指向。适配器补了两条插件调用独有、而聊天面板靠界面提供的东西：**60 秒上限**（插件调用没有可见的停止按钮）与**拒绝把空回答当成功**（写进文档就是删内容），两者都以可读消息 reject，由宿主已有的回调隔离变成用户可见提示。
- **首启路径真机验收**（`apps/desktop/ai-lab/293-first-run.cjs`，打包版 4/4）：无 vault 记录时显示欢迎页且不渲染主界面；空 vault 能打开、列表是空的而不是坏的；**Node 直接写入**（模拟别的程序建文件）的笔记 1 秒内出现在列表；点开后有可编辑面板。

**第六批（本人）：历史版本恢复的屏幕不同步（P1，数据完整性）**
- 真机复现（`apps/desktop/ai-lab/300-history-definitive.cjs`）：保存出第二版 → 从历史面板点「恢复」→ **磁盘回退了，编辑器仍显示被丢弃的第二版**，而且一直不回退。
- 根因：`applyContent` 的幂等守卫比较 `content === session.appliedContent`，而 `appliedContent` 是「编辑器**打开时**的文本」；用户之后的输入写进了 `lastLocalMarkdown`，活动文档早已不是它。于是「恢复到打开时那一版」这个最常见的情形被判定为「已应用」而跳过。
- 后果链：用户以为恢复没生效 → 继续打字 → 编辑器把自己的（陈旧）序列化写回标签并保存 → **刚被丢弃的版本连同新按键一起回到文件里**，恢复被静默撤销。
- 修复：守卫改为同时要求「文本是最后一次应用的」**且**「此后没有被编辑过」（两个 session 字段只有在没有输入时才相等）。真机 8/8：磁盘、屏幕、5 秒后的回写、保存、以及**恢复后继续输入**（最后一项修复前会把旧版本带回来）全部正确。单元：新用例在修复前失败（`expected "spy" to be called 2 times, but got 1 times`），并配一条「真正重复的内容仍然跳过」的反向用例。

**本轮结束时仍未处理**（下一轮候选）：`search_notes` 全链路与其一次性内容搜索辅助函数目前无 UI 消费者（属死代码，建议删除或接入命令面板）；`packages/plugin-host` 的 `PluginContext` 仍不提供 `ctx.ai`（声明 `ai` 的插件目前拿不到 AI 能力，只是写入被策略约束）；插件治理文件以外的插件持久化「停用」开关仍不存在。

## 验证与交付

```bash
pnpm --filter @nekowite/desktop test
pnpm --filter @nekowite/desktop typecheck
pnpm --filter @nekowite/desktop exec eslint <changed files>
pnpm --filter @nekowite/desktop build
# 每次用户可感知改动交付前，统一产出免安装 Windows 可执行文件：
bash scripts/package-win.sh
# 产物：release/nekowite_<version>_x64.exe
# 如仍需安装包：PORTABLE=0 bash scripts/package-win.sh
```

## 构建产物

- 免安装可执行文件（最新）：`release/nekowite_0.1.0_x64.exe`（未签名），SHA-256：`c3709a7c3fbb68788e286bfbd9fe76227918a2d283df430d594a208b7e7ef289`（含第二十一轮的并发竞态修复、导出硬换行与表格对齐、查找替换范围校验）。打包产物真机验证（CDP 驱动 exe）：`line1<br />line2` 打开后两半都还在、无编辑保存后 `<br />` 逐字节保留、单元格里的 `$\|x\|$` 打开后 LaTeX 是 `|x|`、只改大小写的重命名成功且目录项确实变成新拼写，共 5/5。限制如实记录：生产包没有模块加载器，无法像 dev 构建那样 `import()` 源码模块直接调用 store，因此涉及 store 的断言由 dev 构建真机验证与单元测试覆盖。
- 上一版产物（同一日早些时候）：SHA-256 `8d3a7ecd05a07dfde3dad53901fbc4e263e9ab55ec3ff3cbdb958ca243b09c3c`（含第十八轮的公式首次打开修复与文件夹重命名守卫）。
- 更早：SHA-256 `fcadcd7b77cde27ebb621ad182e7ece9d1b7144e02141f8af665ef4046ef8bf6`（第十七轮的移动笔记引用修复、聊天中断保留、长 frontmatter 元数据、文件夹删除后的列表刷新、链接解析 Windows 修复）。
- Windows x64 NSIS 安装包：`release/nekowite_0.1.0_x64-setup.exe`（未签名）。
- 原生可执行文件：`apps/desktop/src-tauri/target/release/nekowite.exe`（17 MB）。
- 当前产物未使用 Authenticode 签名；Windows SmartScreen 可能提示“未知发布者”。如需正式分发，应先配置代码签名再重新打包。
- `release/` 与 `target/` 均为本地构建产物，不纳入 Git；源码、测试与打包记录由 Git 管理。
