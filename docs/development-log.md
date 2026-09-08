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

## 验证命令

```bash
pnpm --filter @nekowite/desktop test
pnpm --filter @nekowite/desktop typecheck
pnpm --filter @nekowite/desktop exec eslint <changed files>
pnpm --filter @nekowite/desktop build
pnpm --filter @nekowite/desktop tauri build --bundles nsis
```

## 构建产物

- Windows x64 NSIS 安装包：`release/nekowite_0.1.0_x64-setup.exe`（5.3 MB，未签名）。
- 原生可执行文件：`apps/desktop/src-tauri/target/release/nekowite.exe`（17 MB）。
- 当前产物未使用 Authenticode 签名；Windows SmartScreen 可能提示“未知发布者”。如需正式分发，应先配置代码签名再重新打包。
- `release/` 与 `target/` 均为本地构建产物，不纳入 Git；源码、测试与打包记录由 Git 管理。
