# NekoWite MDX Demo Vault

这是一个用于**验证 NekoWite 编辑器功能**的示例 vault，覆盖：

- [demo.mdx](demo.mdx)：综合示例（图片、Callout、FloatBox、公式、引用、表格、任务、代码、Wikilink）
- [image-demo.mdx](image-demo.mdx)：图片的尺寸、对齐、标题、引用式、远程图片
- [components-demo.mdx](components-demo.mdx)：Callout / FloatBox / 嵌套组件
- [math-citation-demo.mdx](math-citation-demo.mdx)：行内/块级公式、引用、表格、代码
- [mdx-roundtrip-demo.mdx](mdx-roundtrip-demo.mdx)：JSX 属性表达式、布尔属性、未知组件、不完整标签
- [notes/neko-notes.md](notes/neko-notes.md)：Wikilink 目标笔记
- [notes/mdx-syntax.md](notes/mdx-syntax.md)：语法速查
- [refs.bib](refs.bib) / [refs.ris](refs.ris)：引用文献库
- [attachments/](attachments/)：SVG 图片资源

## 如何验证

### 方式一：作为真实 vault 打开（推荐）

1. 启动应用：`pnpm tauri dev`
2. 点击界面上的“打开 folder / vault”按钮
3. 选择本目录：`<仓库根>/docs/mdx-demo`
4. 在文件树中打开 `demo.mdx`

### 方式二：浏览器 demo

`pnpm dev` 后在浏览器打开 `http://localhost:1420`。此时没有 `window.__TAURI_INTERNALS__`，
`apps/desktop/src/platform/gateways/index.ts` 会自动选择内存适配器
（`createMemoryFsGateway`），因此**读不到本目录的本地文件**，只能验证渲染与交互：
建议使用方式一。

### 方式三：自动化验证（不需要人工点界面）

`apps/desktop/vite.config.ts` 的 vitest 项目已包含
`docs/mdx-demo/__validation/**/*.test.ts`，它把本目录的七个文件逐个打开、往返保存并渲染一遍：

```bash
# 只跑本目录的验证（约 1.3s）
pnpm --filter @nekowite/desktop exec vitest run __validation
# 或随整个仓库的测试一起跑（pnpm verify / scripts/gate.sh / CI 都会跑）
pnpm test
```

因此这里的“验证要点”里，凡是能被断言的部分（往返语法、公式渲染、组件渲染）都有回归
测试兜底；界面交互（拖拽、缩放、旋转、视图切换）才需要方式一的人工确认。

## 验证要点

- 图片是否显示、尺寸/对齐是否生效
- Callout 是否渲染为彩色信息框
- FloatBox 是否可以拖拽、缩放、旋转
- 公式是否渲染（KaTeX）
- 引用是否出现在侧栏
- Wikilink 是否可以点击跳转
- MDX 往返是否保持原始语法
- 源码/渲染/对照视图切换
