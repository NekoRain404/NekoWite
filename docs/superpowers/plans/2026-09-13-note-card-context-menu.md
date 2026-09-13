# 笔记卡片右键菜单实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为笔记列表卡片接入以目标路径为上下文的打开、收藏、重命名、HTML/PDF 导出和删除右键菜单。

**Architecture:** 在 `NoteListPanel` 持有菜单坐标和目标路径，菜单项按目标笔记状态计算。文件操作复用现有 tabs、fileTree、noteDelete、export 服务；必要时抽出一个小型目标内容解析/操作适配层，避免直接依赖活动标签。`ContextMenu` 保持平面菜单，不增加 submenu API。

**Tech Stack:** Vue 3 `<script setup>`, Pinia stores, lucide-vue-next, Vitest/Testing Library, 现有 Tauri fs gateway。

---

### Task 1: 建立目标笔记操作边界

**Files:**
- Create: `apps/desktop/src/services/noteActions.ts`
- Test: `apps/desktop/src/services/noteActions.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖目标内容解析：活动标签返回其最新内容；未打开笔记通过 vault reader 读取；不存在目标返回明确错误。覆盖菜单操作所需的 `NoteActionTarget` 类型只包含 `path` 和可选 `tabId`，不读取全局 active tab。

- [ ] **Step 2: 运行测试确认失败**

运行 `npx --yes pnpm vitest run apps/desktop/src/services/noteActions.test.ts`，预期因服务和导出函数不存在而失败。

- [ ] **Step 3: 实现最小适配层**

定义可注入依赖：`read(vault,path)`, `findTab(path)`, `flushEdits()`, `openTab(path)`；实现 `readTargetContent`，优先返回匹配路径的 tab 内容，找不到时读取 vault 文件。适配层不得调用 `tabs.activeTab` 作为 fallback。

- [ ] **Step 4: 运行测试确认通过**

再次运行同一 Vitest 命令，预期全部通过。

- [ ] **Step 5: 提交**

运行 `git add apps/desktop/src/services/noteActions.ts apps/desktop/src/services/noteActions.test.ts && git commit -m "refactor: isolate note action target resolution"`。

### Task 2: 为 NoteCard/NoteListPanel 接入右键菜单

**Files:**
- Modify: `apps/desktop/src/ui/NoteCard.vue`
- Modify: `apps/desktop/src/ui/NoteListPanel.vue`
- Test: `apps/desktop/src/ui/NoteListPanel.test.ts`

- [ ] **Step 1: 写失败组件测试**

在每个测试中右键非活动卡片，断言菜单包含“打开、收藏/取消收藏、重命名、导出 HTML、导出 PDF、删除”；点击“打开”调用目标路径；点击收藏只切换目标路径；菜单关闭后再次右键另一张卡片，操作目标随之更新。

- [ ] **Step 2: 运行测试确认失败**

运行 `npx --yes pnpm vitest run apps/desktop/src/ui/NoteListPanel.test.ts`，预期当前 NoteCard 没有 `contextmenu` 监听且菜单项断言失败。

- [ ] **Step 3: 实现菜单状态和事件**

在 `NoteListPanel.vue` 增加 `noteMenu = ref<{ x:number; y:number; path:string } | null>(null)`、`noteMenuItems` 和 `onNoteMenuSelect`；给 `NoteCard` 增加 `contextmenu` emit，在卡片根元素使用 `@contextmenu.prevent`。菜单图标使用 `FolderOpen/Star/StarOff/PencilLine/Download/FileDown/Trash2` 等 lucide 图标；删除项添加 `separator: true, danger: true`。

- [ ] **Step 4: 接入打开和收藏**

`open` 调用 `tabs.openTab(target.path)`；收藏调用 `documentList.toggleFavorite(target.path)`。菜单标签通过 `documentList.isFavorite(target.path)` 计算，不缓存旧状态。

- [ ] **Step 5: 运行组件测试确认通过**

运行同一 Vitest 命令，预期菜单渲染、目标切换和收藏测试通过。

- [ ] **Step 6: 提交**

运行 `git add apps/desktop/src/ui/NoteCard.vue apps/desktop/src/ui/NoteListPanel.vue apps/desktop/src/ui/NoteListPanel.test.ts && git commit -m "feat: add note card context menu"`。

### Task 3: 接入重命名和删除安全流程

**Files:**
- Modify: `apps/desktop/src/ui/NoteListPanel.vue`
- Modify: `apps/desktop/src/services/noteActions.ts`
- Test: `apps/desktop/src/ui/NoteListPanel.test.ts`
- Test: `apps/desktop/src/services/noteDelete.test.ts` (若现有测试文件存在则追加)

- [ ] **Step 1: 写失败测试**

测试非活动已打开笔记重命名时调用 `flushEdits` 后再执行移动，并更新 tabs 路径；测试未打开笔记删除会调用 `deleteNoteWithAssets`；测试删除确认开启时第一次选择只打开确认，不调用 delete；测试重复选择不会发起第二次删除。

- [ ] **Step 2: 运行测试确认失败**

运行 `npx --yes pnpm vitest run apps/desktop/src/ui/NoteListPanel.test.ts apps/desktop/src/services/noteDelete.test.ts`，预期新增断言失败。

- [ ] **Step 3: 实现重命名**

复用 FileTree 的 `NoteMoveIo` 绑定和 `moveNote`，执行前 `flushEdits()`，成功后 `tabs.renamePathInTabs(from,to,moved)`，最后刷新 `documentList`/file tree。名称校验和错误通知沿用现有文案。

- [ ] **Step 4: 实现删除**

维护 `deleting = new Set<string>()`；打开 tab 时使用 `tabs.deleteTabFile`，未打开时使用 `deleteNoteWithAssets`；完成后清理确认态、刷新索引并让 store 修剪收藏/最近项。

- [ ] **Step 5: 运行测试确认通过**

重复运行 Task 3 命令，预期通过且无未处理 rejection。

- [ ] **Step 6: 提交**

运行 `git add apps/desktop/src/ui/NoteListPanel.vue apps/desktop/src/services/noteActions.ts apps/desktop/src/ui/NoteListPanel.test.ts apps/desktop/src/services/noteDelete.test.ts && git commit -m "feat: support safe rename and delete from note menu"`。

### Task 4: 接入目标笔记 HTML/PDF 导出

**Files:**
- Modify: `apps/desktop/src/services/export.ts`
- Modify: `apps/desktop/src/ui/NoteListPanel.vue`
- Test: `apps/desktop/src/services/export.test.ts`
- Test: `apps/desktop/src/ui/NoteListPanel.test.ts`

- [ ] **Step 1: 写失败测试**

断言未打开目标从 vault 读取后传给 `exportHtml`/`exportToPdf`；断言 `notePath` 等于右键路径；断言活动 tab 的未提交内容在导出前触发 `flushEdits`；取消保存对话框不调用写入或通知。

- [ ] **Step 2: 运行测试确认失败**

运行 `npx --yes pnpm vitest run apps/desktop/src/services/export.test.ts apps/desktop/src/ui/NoteListPanel.test.ts`，预期缺少目标路径参数时失败。

- [ ] **Step 3: 实现导出处理器**

HTML 调用 `saveFileDialog(exportBaseName(path)+'.html', vault)` 后校验 vault 范围，再调用 `exportHtml(source,vault,savePath,{title:exportBaseName(path),notePath:path,refs:refsMap()})`。PDF 调用 `exportToPdf(source,{title:...,notePath:path,refs:...})`。两者都用 `readTargetContent` 并捕获 `describeExportError`。

- [ ] **Step 4: 修正导出服务上下文**

确保 `toRenderOptions` 在 `opts.notePath` 存在时优先使用它解析附件；只有设置为空时才回退活动 tab。保持现有 HTML data URL 和 PDF display URL 行为。

- [ ] **Step 5: 运行测试确认通过**

重复运行 Task 4 命令，预期通过。

- [ ] **Step 6: 提交**

运行 `git add apps/desktop/src/services/export.ts apps/desktop/src/ui/NoteListPanel.vue apps/desktop/src/services/export.test.ts apps/desktop/src/ui/NoteListPanel.test.ts && git commit -m "feat: export the note selected by context menu"`。

### Task 5: 全量验证与 Windows 交付

**Files:**
- No source changes unless verification finds a regression.

- [ ] **Step 1: 类型检查、lint、测试和构建**

在仓库根目录运行项目既有命令：`npx --yes pnpm typecheck`、`npx --yes pnpm lint`、`npx --yes pnpm test`、`npx --yes pnpm build`。每条命令都必须以退出码 0 完成。

- [ ] **Step 2: 运行桌面交互验收**

启动开发应用，分别对活动和非活动卡片右键，验证菜单定位、键盘导航、导出内容、重命名后的标签路径和删除后的列表刷新；确认 `NekoWite_win` 不参与扫描或打包输入。

- [ ] **Step 3: 打包便携 Windows 可执行文件**

通过全部检查后运行 `bash scripts/package-win.sh`，复制 `release/nekowite_<version>_x64.exe` 并计算 `sha256sum`，将路径和 SHA-256 写入交付说明。

- [ ] **Step 4: 提交验证结果**

记录测试数量、构建产物和任何未覆盖风险；只有命令输出确认成功后才能宣称完成。
