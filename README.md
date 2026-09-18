# NekoWite

> 把 Markdown / MDX 的可控性，带回像 Word 一样自然的写作体验。

A local-first desktop knowledge base: WYSIWYG writing, files that stay plain Markdown.

本地优先的开源桌面知识库：在所见即所得里写作，文件仍是你自己的 Markdown。

[![CI](https://github.com/NekoRain404/NekoWite/actions/workflows/ci.yml/badge.svg)](https://github.com/NekoRain404/NekoWite/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-1f6feb?logo=opensourceinitiative&logoColor=white)](LICENSE)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-24c8db?logo=tauri&logoColor=white)](https://tauri.app/)
[![Vue 3](https://img.shields.io/badge/Vue-3-42b883?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**[功能](#核心能力)** · **[使用](#使用)** · **[从源码运行](#从源码运行)** · **[文档](#文档)** · **[贡献](#参与贡献)** · **[许可证](#许可证)**

![NekoWite 编辑器界面](docs/assets/nekowite-editor.png)

## 为什么是 NekoWite

- **写作时看成稿**：默认所见即所得，随时切到源码或左右对照。
- **文件始终是你的**：知识库就是一个普通文件夹，带 YAML frontmatter，可被 Git 和其它编辑器使用；外部改动会热重载。
- **复杂内容不必绕路**：表格、数学公式、参考文献和 MDX 组件写在同一份文档里。
- **写完就能发出去**：导出渲染后的 PDF / HTML；需要时用自己的 API Key 接 AI 起草、改写和续写。

## 核心能力

| 场景 | 你可以做什么 |
| --- | --- |
| **专注写作** | 多标签、文件树、全文搜索、三态视图、命令面板 |
| **结构化内容** | Markdown / MDX 往返保真、YAML frontmatter、表格网格、Callout / FloatBox |
| **研究与引用** | 导入 `.bib`、`.ris`、CSL，侧栏管理 `@citekey` 并自动编号 |
| **公式与发布** | MathLive 可视化编辑 `$…$` / `$$…$$`，导出 HTML 与 PDF |
| **AI 辅助** | 自备密钥；续写（Tab）、侧栏聊天、选区改写 / 润色 / 翻译。可接 OpenAI、Claude、Gemini、Grok、DeepSeek，或本地 LM Studio / Ollama |
| **个人工作流** | 每日笔记、模板、维基链接、知识图谱、历史版本、回收站、主题 |

## 适合谁

**长文作者**：在一个知识库里维护章节、设定和素材，随时在源码与成稿之间切换。

**研究与知识工作者**：把公式、参考文献、表格和说明放在同一份可版本化的文档中。

**喜欢扩展的人**：内置 Callout、FloatBox、文档状态随应用提供。用户插件的加载器已经写好，但发行版出于隔离尚未完成，**不会加载** vault 里的第三方插件。

## 使用

1. 启动后选择一个文件夹，它就成为你的**知识库**（空文件夹也可以）。
2. 直接在中间编辑区写作；`Ctrl+S` 保存，默认还会自动保存。
3. 用底部状态栏在「渲染 / 源码 / 对照」之间切换。
4. 需要 AI 时：设置 → AI，填写服务商、模型和密钥（密钥加密存在本机，界面只显示已配置）。

侧栏里的「云同步」是占位，目前**不会**把知识库传到网上。

更完整的界面说明见 [用户指南](docs/USER-GUIDE.md)，隐私边界见 [PRIVACY.md](docs/PRIVACY.md)。

## 从源码运行

环境：Node.js 22、pnpm 11。跑桌面应用还需要 Rust stable 和 [Tauri v2 系统依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
git clone https://github.com/NekoRain404/NekoWite.git
cd NekoWite
pnpm install

# 浏览器里预览前端
pnpm dev

# 完整桌面应用
pnpm tauri dev
```

### 打包成单个可执行文件

```bash
# Linux（本机构建，产物为 ELF）
pnpm --filter @nekowite/desktop exec tauri build --no-bundle
# 二进制：apps/desktop/src-tauri/target/release/nekowite
# 可复制为：release/nekowite_<version>_x64

# Windows 便携版（在 Windows 上、Git Bash 中执行；免安装，双击运行）
bash scripts/package-win.sh
# 产物：release/nekowite_<version>_x64.exe
```

Linux 二进制依赖系统里的 GTK / WebKitGTK。Windows 便携版不需要安装器。

**支持的架构只有 x86_64（Linux / glibc）。** `scripts/package-linux.sh` 产出的每一个产物——`nekowite_<version>_x64`、deb、rpm、`nekowite_<version>_amd64.AppImage`——都是这一个架构，而随包内置的 OpenCode 引擎是 `scripts/fetch-opencode-linux.sh` 固定的单一制品 `opencode-linux-x64@1.18.29`，即 `x86_64-unknown-linux-gnu`。所以在 arm64 机器上，AppImage 与 deb/rpm 都执行不起来（内核直接拒绝这个 ELF）；musl 发行版（如 Alpine）同样不行，因为该引擎是动态链接 glibc 的。从源码在本机构建也一样：构建出的应用是本机架构，但内置的引擎仍是 x86_64，启动引擎时才会失败——**这个架构不是「尚未支持」，而是本版本只交付这一个。**

## 项目状态

当前版本 **1.0.0**。面向写作者的核心能力（编辑、知识库、公式、引用、导出、AI）已经能用。还没有官方 GitHub Release 渠道、没有自动更新；Windows 便携 exe 是主要用户交付物，Linux 可从源码打出单个二进制。插件沙箱仍在路线图上。

## 开发

```bash
pnpm typecheck       # 全仓库类型检查
pnpm lint            # ESLint
pnpm test            # Vitest
pnpm test:e2e        # Playwright
pnpm build           # 桌面前端

cd apps/desktop/src-tauri
cargo test
```

```text
apps/desktop/              Vue 界面与 Tauri 壳
packages/editor-core/      Markdown / MDX 解析、编辑与序列化
packages/plugin-host/      插件加载、权限与生命周期
docs/                      用户指南与设计文档
```

约定见 [docs/dev.md](docs/dev.md)，测试范围见 [docs/test-plan.md](docs/test-plan.md)。

## 插件

内置插件始终可用。用户放在知识库 `plugins/` 里的插件，加载器、权限确认和完整性校验都已实现，但**打包版不会执行它们**：当前 CSP 不允许窗口内 `import(blob:)`，插件又与主窗口共用运行环境，做不到真正隔离。设置里会写明这一点，而不是假装开关有效。

原因见 [docs/PLUGIN_ISOLATION.md](docs/PLUGIN_ISOLATION.md)，API 见 [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md)。

最小形态（仅开发 / 测试环境）：

```ts
import { definePlugin } from '@nekowite/plugin-host'

export default definePlugin({
  name: 'Quote',
  toolbar: [{
    id: 'quote.insert',
    label: '插入 Quote',
    run: () => {},
  }],
})
```

插件可声明 `ai`、`fs`、`network`、`clipboard` 权限；未声明的敏感能力默认拒绝。在发行版开放加载之前，请只在你信任的环境里试验本地插件。

## 文档

面向使用者：

- [docs/USER-GUIDE.md](docs/USER-GUIDE.md) — 打开知识库、编辑、搜索、引用、导出、配置 AI
- [docs/PRIVACY.md](docs/PRIVACY.md) — 哪些数据会离开本机、本机存了什么

面向开发与发布：

- [docs/SECURITY.md](docs/SECURITY.md) — 安全模型里已强制 / 未实现的项
- [docs/RECOVERY.md](docs/RECOVERY.md) — 历史、回收站、冲突与崩溃恢复
- [docs/RELEASING.md](docs/RELEASING.md) — 维护者：版本号、门禁与打包
- [docs/PERF.md](docs/PERF.md) · [docs/A11Y.md](docs/A11Y.md)
- [CHANGELOG.md](CHANGELOG.md)
- [CONTRIBUTING.md](CONTRIBUTING.md) · [.github/SECURITY.md](.github/SECURITY.md)

## 路线图

- 更完整的跨平台打包与发布渠道
- webview / worker 级别的插件沙箱
- 更丰富的主题、模板
- 更稳定的 E2E 与插件文档

## 参与贡献

欢迎 Issue、文档改进和 Pull Request。流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。改动编辑器行为、文件读写或插件权限时，请补上对应测试，并在 PR 里说明兼容性影响。

发现安全问题请走 [私有漏洞报告](.github/SECURITY.md)，不要开公开 Issue。

## 许可证

[MIT](LICENSE) © 2026 NekoWrite contributors
