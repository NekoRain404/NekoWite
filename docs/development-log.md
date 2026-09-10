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

- 免安装可执行文件：`release/nekowite_0.1.0_x64.exe`（17,255,424 字节，未签名），SHA-256：`acc1a3f7dceb6999240211abc390f0e2c00a765963db57077bd0039d11dbed53`（含源码模式光标回跳与 `Ctrl+Shift+Z` 重做修复）。
- Windows x64 NSIS 安装包：`release/nekowite_0.1.0_x64-setup.exe`（5.3 MB，未签名）。
- 原生可执行文件：`apps/desktop/src-tauri/target/release/nekowite.exe`（17 MB）。
- 当前产物未使用 Authenticode 签名；Windows SmartScreen 可能提示“未知发布者”。如需正式分发，应先配置代码签名再重新打包。
- `release/` 与 `target/` 均为本地构建产物，不纳入 Git；源码、测试与打包记录由 Git 管理。
