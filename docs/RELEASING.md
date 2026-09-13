# 发布流程（1.0，Windows）

> 面向维护者：把当前工作区变成一次公开发布的清单。命令都在仓库根目录、用 Git Bash 执行。

## 1. 版本号（4 个文件 + 变更日志）

| 文件 | 字段 |
| --- | --- |
| `package.json` | `version` |
| `apps/desktop/package.json` | `version` |
| `apps/desktop/src-tauri/tauri.conf.json` | `version`（**打包脚本用它决定产物文件名**） |
| `apps/desktop/src-tauri/Cargo.toml` | `[package] version`（改完构建一次，让 `Cargo.lock` 同步） |

- `CHANGELOG.md`：把 `## [Unreleased]` 的内容整理成 `## [1.0.0] - YYYY-MM-DD`。
- 已知不一致（发布前要处理）：`apps/desktop/src/ui/StatusBar.vue` 里界面显示的版本号是硬编码的 `v0.1.0`，与 `tauri.conf.json` 的 1.0.0 不符。

## 2. 门禁（全绿才打包）

与 CI（`.github/workflows/ci.yml`）一致：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @nekowite/desktop build
pnpm --filter @nekowite/desktop check:export-css
pnpm --filter @nekowite/desktop exec playwright install chromium   # 首次需要
pnpm test:e2e
cd apps/desktop/src-tauri && cargo test --locked && cargo clippy --all-targets --locked && cargo build --locked
```

注意 `bash scripts/package-win.sh` 自己只跑 desktop 的 test / typecheck / lint；**Rust 的 test / clippy / build 不在脚本里**，需要先手动跑过。

## 3. 打包

```bash
# 便携版（默认；免安装，双击直接运行）
bash scripts/package-win.sh
#   产物：release/nekowite_<version>_x64.exe

# 可选：NSIS 安装包
PORTABLE=0 bash scripts/package-win.sh
#   产物：release/nekowite_<version>_x64-setup.exe
```

- 脚本先用 `node -p` 读 `tauri.conf.json` 的 version 拼出文件名，然后在构建前 `taskkill` 掉正在运行的旧版本进程（避免 exe 被占用）。
- 便携版走 `tauri build --no-bundle`（不生成安装器）；`PORTABLE=0` 走 `tauri build --bundles nsis`。
- `release/` 在 `.gitignore` 里，产物不入库。

## 4. 签名现状与 SmartScreen

- **当前二进制没有代码签名。** `tauri.conf.json` 的 `bundle` 里没有 `windows` 签名配置，CI 与 `scripts/package-win.sh` 都没有签名步骤。
- 后果：首次运行未签名程序时 Windows SmartScreen 会拦截（「Windows 已保护你的电脑」），需要点「更多信息 → 仍要运行」；部分企业策略会直接阻止。发布说明里必须写清楚这一点。
- 复核方式（拿到 exe 后）：在 PowerShell 里运行 `Get-AuthenticodeSignature release/nekowite_1.0.0_x64.exe`，未签名时 `Status` 为 `NotSigned`。
- 代码签名证书（OV/EV、时间戳服务）属于待决事项；拿到证书后再在 `bundle.windows` 里配置证书指纹或自定义签名命令。

## 5. 记录 SHA-256

- `scripts/package-win.sh` 最后会对产物执行 `sha256sum`，把输出抄下来。
- 建议同时写进发布说明与 `CHANGELOG.md` 对应版本条目（仓库历史里有先例：`docs: pin the verified portable exe hash`）。
- 分发时只发布 `release/` 里的产物；源码以 git tag（例如 `v1.0.0`）为准。

## 6. 人工验收（自动化覆盖不到）

在一台干净机器上，双击便携版：

1. 打开一个测试文件夹作为知识库；新建、编辑、`Ctrl+S` 保存，重启确认内容还在。
2. 删除一篇笔记 → 回收站恢复；连续保存几次 → 历史版本可对比并恢复。
3. 导出 HTML 与 PDF（PDF 走系统打印对话框）。
4. 配置本地模型（默认 `http://localhost:1234/v1`），验证 Tab 续写、聊天、选区改写；关掉「启用 AI 功能」后确认不再发请求。
5. 打开设置 → AI →「最近的 AI 活动」，确认有记录且不含正文。
6. 确认知识库里出现 `.nekowite/`，删除笔记后出现 `.nekowite-trash/`；`%APPDATA%\dev.nekowite.app\.nekowite\stronghold.bin` 存在且非明文。
7. 首次启动确认 SmartScreen 表现与发布说明一致。

## 7. 待决事项（不是工程工作）

- **代码签名证书**：见第 4 节；没有它，每次发布都要在说明里解释 SmartScreen 提示。
- **许可证**：工作区里已有一份 MIT 的 `LICENSE`（尚未提交），`package.json` 与 `apps/desktop/package.json` 也加了 `"license": "MIT"`；发布前需要最终确认这一选择并提交。
- **自动更新端点**：当前没有更新检查（没有 updater 插件、没有端点）。若要发布后可自动升级，需要先决定托管位置与更新签名密钥。
- **macOS / Linux 构建**：图标资源已包含 `.icns`，但仓库没有对应的 CI 与打包脚本；跨平台发布需要单独的构建流水线。
