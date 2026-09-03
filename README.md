# NekoWite

NekoWite 是一个开源类 Word 的 MDX 所见即所得（WYSIWYG）编辑器，基于 Tauri v2 桌面壳构建。它把 Markdown 的轻量与 MDX 的可扩展性结合：自定义无边框标题栏与侧栏（搜索/文件树/引用/回收站/主题），中间所见即所得编辑，支持对照分屏（源码/渲染/对照三态视图）、表格网格编辑、YAML frontmatter 保留、外部编辑热重载、右栏文档信息（引用与历史版本）、AI ghost-writer，以及用户插件系统（自定义 MDX 组件 + 工具栏按钮 + 命令）。

## 技术栈

- **桌面壳**: Tauri v2（Rust），文件读写与目录监听由 Rust 命令层提供
- **前端**: Vue 3 + TypeScript + Pinia + Vite
- **编辑器**: Milkdown v7（ProseMirror + remark），MDX/JSX 自定义节点与序列化管道
- **测试**: Vitest（单元/往返）、Playwright（E2E 关键路径）、GitHub Actions CI（typecheck + lint + test + e2e）

## 快速开始

```bash
pnpm install
pnpm dev            # 启动 Vite dev server (localhost:1420)
pnpm tauri dev      # 启动完整桌面应用（需要 Tauri/Rust 环境）
```

## 测试

```bash
pnpm typecheck      # 全仓库类型检查
pnpm lint           # ESLint 检查
pnpm test           # 全仓库单测（vitest）
pnpm test:e2e       # 桌面壳 E2E（Playwright，浏览器模式，针对 Vite dev server）
```

E2E 在浏览器模式下运行（不依赖 Tauri 进程），通过 `page.addInitScript` 注入 Tauri `invoke` 的 mock 来提供文件系统夹具数据，因此无需真实文件系统即可验证「打开 vault → 文件树 → 打开标签 → 编辑 → 三态视图切换」的关键路径。Tauri 命令层的正确性由 Rust 侧的 cargo 测试覆盖。

## 功能总览

项目功能完整（v1.0–v1.6 全部已实现，单测 196 个全绿），适合自用与学习参考。

- ✅ **v1.0 核心体验**: 应用壳（文件树/多标签/状态栏/设置）、工具栏 WYSIWYG 编辑、表格网格编辑、YAML frontmatter 保留、三态视图（对照分屏/单独源码/单独渲染）、MDX/JSX 组件节点、Markdown/MDX 往返保真、外部编辑热重载、用户插件骨架
- ✅ **v1.1 数学**: MathLive 可视化公式编辑 + 公式键盘 + `$…$` / `$$…$$` 往返
- ✅ **v1.2 引用**: `.bib/.ris/CSL` 导入、`@citekey` 侧栏引用、自动编号
- ✅ **v1.3 导出**: PDF + HTML 导出（含渲染后的数学与组件）
- ✅ **v1.4 AI**: AI ghost-writer，BYOK（OpenAI/Claude/Gemini/Grok/本地 LM Studio/Ollama），Tab 接收
- ✅ **v1.5 浮动元素**: 浮动图片/文本框/贴纸，可任意摆放（自由画布辅助能力）
- ✅ **v1.6 深度插件**: 生命周期钩子、样式主题、更全注册面、插件沙箱（webview/worker）

## 插件开发

插件通过 `definePlugin` 定义，可注册自定义 MDX 组件、工具栏按钮与命令。下面的最小示例注册一个 `Quote` 组件：

```ts
import { defineComponent, h } from 'vue'
import { definePlugin } from '@nekowite/plugin-host'

const Quote = defineComponent({
  props: {
    author: { type: String, default: '' },
    children: { type: String, default: '' },
  },
  setup(props) {
    return () =>
      h('blockquote', { class: 'my-quote' }, [
        h('p', { innerHTML: props.children }),
        props.author ? h('footer', props.author) : null,
      ])
  },
})

export const quotePlugin = definePlugin({
  name: 'Quote',
  components: { Quote }, // 注册 MDX 组件 <Quote>...</Quote>
  toolbar: [
    {
      id: 'quote.insert',
      label: '插入 Quote',
      run: () => console.log('插入 Quote 组件'),
    },
  ],
  commands: [
    {
      id: 'quote.count',
      run: () => console.log('统计引用'),
    },
  ],
})
```

注册的组件可直接在文档中通过 MDX 语法使用：

```mdx
# 我的文档

<Quote author="NekoWite">你好，世界。</Quote>
```

插件由 `@nekowite/plugin-host` 的加载器/激活器管理：`loadPlugin` 负责加载并校验（必须有 default export），`activatePlugin` 负责注册并与 `onLoad` 生命周期联动；激活失败时自动回滚已注册项，保证插件隔离与错误处理。
