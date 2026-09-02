# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本语义遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-08-29

这是 NekoWite 的首个完整发布，涵盖 v1.0–v1.6 全部计划功能。

### Added

- **v1.0 核心体验**：应用壳（文件树/多标签/状态栏/设置）、工具栏 WYSIWYG 编辑、表格网格编辑、YAML frontmatter 保留、三态视图（对照分屏/单独源码/单独渲染）、MDX/JSX 组件节点、Markdown/MDX 往返保真、外部编辑热重载、用户插件骨架
- **v1.1 数学**：MathLive 可视化公式编辑 + 公式键盘 + `$…$` / `$$…$$` 往返
- **v1.2 引用**：`.bib/.ris/CSL` 导入、`@citekey` 侧栏引用、自动编号
- **v1.3 导出**：PDF + HTML 导出（含渲染后的数学与组件），KaTeX 字体内嵌为 data URI 的自包含导出
- **v1.4 AI**：AI ghost-writer，BYOK（OpenAI/Claude/Gemini/Grok/本地 LM Studio/Ollama），Tab 接收，加密密钥存储
- **v1.5 浮动元素**：浮动图片/文本框/贴纸，可任意摆放（自由画布辅助能力），导出时保留绝对定位
- **v1.6 深度插件**：生命周期钩子（onLoad/onActivate/onDocChange/onSave 等）、活动编辑器追踪、更全注册面、插件沙箱（webview/worker）
