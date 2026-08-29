# NekoWite 设计文档

- 日期：2026-08-29
- 状态：已确认
- 定位：开源、类 Word 的所见即所得 MDX 编辑器（桌面应用）

## 1. 产品概述

NekoWite 是一个开源桌面 MDX 编辑器，提供类似 Word/Google Docs 的所见即所得编辑体验，但磁盘上的文件始终是可读的 Markdown/MDX 文本。

**产品本质是 MDX**：MDX/JSX 自定义组件是一等公民、核心卖点。文档中可任意嵌入自定义组件，保存时以 MDX 语法保真写盘。

深度参考 helloMDX（hellomdx.com）的产品形态，但作为开源项目开放自由：

- 用户可写插件，注册自定义 MDX 组件、工具栏按钮与命令
- 三态视图：对照分屏（源码+渲染）/ 单独源码 / 单独渲染
- 路线图后期支持浮动元素（自由画布辅助能力）

## 2. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面壳 | Tauri v2（Rust 后端） | 轻量（~10MB）、现代、文件系统/自动更新能力足够 |
| 前端框架 | Vue 3 + TypeScript | 用户选定；Milkdown 官方支持 Vue 集成 |
| 状态管理 | Pinia | Vue 生态标准 |
| 编辑内核 | Milkdown（ProseMirror + remark） | 插件化程度最高、自定义块/文档结构最灵活、remark 往返保真最佳 |
| MDX/JSX | 自写自定义节点（editor-core/mdx） | 把 JSX 组件做成 Milkdown 自定义块节点 |

## 3. 范围与路线图

### 范围红线（不做）
- 审阅批注 / 修订（track changes）
- 跨设备协作、在线多人编辑
- 导出 DOCX（只做 PDF + HTML）
- 自带云存储服务

### 版本路线

| 版本 | 内容 |
|---|---|
| **v1.0 核心体验** | 应用壳（文件树、多标签、状态栏、设置、打开/新建/保存）；工具栏所见即所得（H1–H6、粗/斜/删/行内码、有序/无序/任务列表、引用、链接、图片、代码块、分隔线）；表格网格编辑；YAML frontmatter 保留；**三态视图**（对照分屏/单独源码/单独渲染）；**MDX/JSX 组件节点**（内置一组示例组件）；Markdown/MDX 往返保真（remark 管道）；外部编辑热重载；**用户插件骨架**（vault/plugins/ 注册自定义 MDX 组件 + 工具栏按钮 + 命令） |
| v1.1 数学 | MathLive 可视化公式编辑 + 公式键盘 + `$…$`/`$$…$$` 往返 |
| v1.2 引用 | `.bib/.ris/CSL` 导入、`@citekey` 侧栏引用、自动编号 |
| v1.3 导出 | PDF + HTML 导出（含渲染后的数学与组件） |
| v1.4 AI | AI ghost-writer：BYOK（OpenAI/Claude/Gemini/Grok/本地 LM Studio/Ollama），Tab 接收 |
| v1.5 浮动元素 | 浮动图片/文本框/贴纸，可任意摆放（自由画布辅助能力） |
| v1.6 深度插件 | 生命周期钩子、样式主题、更全注册面、插件沙箱（webview/worker） |

## 4. 架构分层

```
NekoWite
├── app-shell           应用壳
│   ├── ui/             Vue3：主窗口布局、文件树、多标签、状态栏、设置
│   ├── stores/         Pinia：tabs、打开文档、视图模式
│   └── view/           视图控制器：源码视图 / 渲染视图 / 对照分屏
├── editor-core         编辑内核（Milkdown + ProseMirror + remark）
│   ├── editor/         Milkdown 实例封装，对外 API：openDoc/saveDoc/insert/commands
│   ├── mdx/            MDX/JSX 自定义节点（自定义组件 ↔ markdown 保真）
│   ├── serialize/      remark 序列化/解析管道（往返保真）
│   └── registry/       插件注册表（Milkdown 插件 + 应用模块统一注册）
├── feature-plugins     功能=插件（每个独立）
│   ├── table/          表格网格编辑
│   ├── math/           v1.1 MathLive
│   ├── citation/       v1.2
│   ├── export/         v1.3 PDF+HTML
│   ├── ai/             v1.4
│   └── float/          v1.5 浮动元素
├── plugin-host         用户插件宿主
│   └── loader/         vault/plugins/ 扫描、动态加载、API 注入
└── tauri/              Rust 后端：fs、文件监听 watch、自动更新、窗口
```

### 数据流

```
磁盘 .md/.mdx ⇄ Rust fs/Watcher ⇄ Vue store（tabs/视图）
             ⇄ editor-core（ProseMirror doc ⇄ remark markdown）⇄ 渲染
```

- 编辑时 editor-core 序列化回 markdown 写盘
- 外部改动由 watcher 触发热重载（未保存的 tab 不动）
- 对照分屏 = 同一文档的两个投影，靠 store 单向数据流同步，不做双向镜像

## 5. 三态视图（v1.0 核心）

- **对照（分屏）**：左源码右渲染，实时同步滚动/光标
- **单独·源码**：只显示 markdown/mdx 原文
- **单独·渲染**：只显示所见即所得效果（默认模式）

同一文档的两个投影，由 view 控制器 + store 单一数据源驱动。

## 6. 用户插件系统

### 目录结构

```
vault/plugins/<id>/
├── plugin.json        # { id, name, version, main }
└── index.ts           # export default definePlugin({...})
```

### 插件 API v1（最小闭环）

- `registerComponent({ name: 'Callout', component })`：注册 MDX 组件，文档中以 `<Callout>…</Callout>` 书写；对应 Milkdown 自定义 JSX 节点
- `registerToolbar({ group, items })`：往工具栏加按钮，按钮动作 = 插入组件或执行命令
- `registerCommand({ id, run })`：可被快捷键/菜单调用

### 加载与序列化

- 启动时 Rust 扫 `plugins/` → 前端动态 `import()` → 注册进 editor-core 注册表
- 自定义组件存为 MDX JSX 节点，用 remark-mdx 风格管道保证「保存=所见」
- 插件卸载时，文档中已有节点保留为源码文本，不丢内容

### 安全

- v1 插件在应用进程内直接运行（与 Obsidian 一致），文档声明风险提示
- 插件沙箱（webview/worker）列入 v1.6

### 失败处理

- 单个插件加载/运行异常 → 隔离禁用该插件并提示，不影响主程序与其他插件

## 7. 错误处理策略

- **文件读写失败**（权限/占用/磁盘满）：Rust 捕获 → toast + 状态栏提示；写入失败保留内存副本，提供「重试/另存为」
- **MDX/Markdown 解析失败**：自动回退源码视图显示原文，不阻塞编辑；保存时按可解析部分序列化
- **外部编辑冲突**：无未保存改动 → 直接热重载；有未保存改动 → 弹窗选择「覆盖磁盘 / 保留本地」（首版只做前两者）
- **插件异常**：隔离禁用 + 提示
- **错误分级**：Rust 层错误（fs/updater）统一错误码回传；前端统一错误通知组件

## 8. 测试策略

- **editor-core（vitest 单测，重点）**：markdown/MDX ⇄ ProseMirror doc 往返保真（JSX 节点、frontmatter、表格、嵌套）；插件注册/卸载；视图控制器状态机
- **feature-plugins（vitest + 组件测试）**：各功能插件序列化与命令行为
- **Rust 侧（cargo test）**：fs 读写、watcher 事件、路径处理
- **E2E（Playwright + Tauri WebDriver）**：打开→编辑→保存→磁盘断言；三态视图切换；热重载
- **CI（GitHub Actions）**：lint（ESLint + oxlint）+ 单测 + 类型检查 +（可选）构建

## 9. 文件格式

- 打开 `.md` 与 `.mdx` 文件
- 保存沿用原文件扩展名
- 自定义组件语法仅在 MDX 语义下生效；纯 markdown 文件中的组件以源码文本形式保留
