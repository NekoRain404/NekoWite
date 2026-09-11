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

- 免安装可执行文件：`release/nekowite_0.1.0_x64.exe`（未签名），SHA-256：`ca34bce2a3dc876cde7db9d4dcd4d7e7015ce06116d5ca0758dc669b8227c992`（含分隔条按指针拖拽、命令面板状态机、源码面板冲刷顺序，以及控制台洁净度巡检）。
- Windows x64 NSIS 安装包：`release/nekowite_0.1.0_x64-setup.exe`（5.3 MB，未签名）。
- 原生可执行文件：`apps/desktop/src-tauri/target/release/nekowite.exe`（17 MB）。
- 当前产物未使用 Authenticode 签名；Windows SmartScreen 可能提示“未知发布者”。如需正式分发，应先配置代码签名再重新打包。
- `release/` 与 `target/` 均为本地构建产物，不纳入 Git；源码、测试与打包记录由 Git 管理。
