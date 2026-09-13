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
3. 选择本目录：`C:\Users\Lenovo\Documents\ChatGPT\NekoWrite\docs\mdx-demo`
4. 在文件树中打开 `demo.mdx`

### 方式二：浏览器 demo

由于浏览器 demo 使用内存 vault，无法读取本地文件，建议使用方式一。

## 验证要点

- 图片是否显示、尺寸/对齐是否生效
- Callout 是否渲染为彩色信息框
- FloatBox 是否可以拖拽、缩放、旋转
- 公式是否渲染（KaTeX）
- 引用是否出现在侧栏
- Wikilink 是否可以点击跳转
- MDX 往返是否保持原始语法
- 源码/渲染/对照视图切换
