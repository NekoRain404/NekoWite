# NekoWite 测试计划（执行面清单）

> 这份文档回答两件事：**仓库实际跑哪些测试、怎么跑**（§1），以及**每个功能域由哪些文件守着、哪里还没人守**（§2、§3）。
> 权威是代码本身：合并门禁是 `.github/workflows/ci.yml`，本地等价的一条命令是 `bash scripts/gate.sh`。
> 下面每个「已覆盖」都指向一个真实存在的文件；GAP / PARTIAL 的行写清缺的是哪一件事——状态栏空着不等于没问题，所以这里没有空格子。

## 1. 验证面

### 1.1 入口与它的边界

| 入口 | 跑什么 |
|---|---|
| `bash scripts/gate.sh`（加 `--with-e2e` 才跑 Playwright） | 本地全量：`verify`、`fmt`、`clippy`（带 110 行告警上限）、`instruments`、`scripts`、`harness`、`build`、`rust`。每步都跑完再汇总，任一步失败则退出码 1 |
| `pnpm verify` | `typecheck → lint → test → perf → build → check:export-css`（`package.json:19`）。**不含** e2e、cargo 测试、三个 instrument、两个 shell 套件与 harness 测试 |
| `pnpm test` | `pnpm -r test`：三个 workspace 包各跑一次 vitest |
| `pnpm --filter @nekowite/desktop e2e` | Playwright，经 `scripts/run-e2e.mjs` 先要一个空闲端口 |

CI 分两个 job：`check` 跑 typecheck、lint、三个 instrument、两个 shell 套件、harness、test、perf、build、check:export-css、e2e；`rust` 跑 cargo test、build、clippy、fmt。

### 1.2 四个 vitest 项目（各自独立一次 `vitest run`，没有 workspace 文件）

| 配置 | include | 环境 |
|---|---|---|
| `apps/desktop/vite.config.ts:177` | `src/**/*.test.ts`、`../../docs/mdx-demo/__validation/**/*.test.ts` | happy-dom |
| `apps/desktop/vitest.perf.config.ts:15` | `perf/**/*.test.ts` | happy-dom，超时 120s |
| `packages/editor-core/vitest.config.ts` | `src/**/*.test.ts` | happy-dom |
| `packages/plugin-host/vitest.config.ts` | `src/**/*.test.ts` | node |

`references/` 不在 `pnpm-workspace.yaml` 里且被 `.gitignore:77` 忽略，不属于本仓库的测试面。`*.test.mjs` 也不属于上表任何一项——WebKit 量测 harness 的两个 `node:test` 文件由 `pnpm --filter @nekowite/desktop test:webkit-harness` 跑。

### 1.3 Playwright

46 个 spec、297 个用例（`npx playwright test --list` 实测）。`apps/desktop/playwright.config.ts` 的 `testDir` 是 `./e2e`，配置里的端口默认 1420。

**用 `pnpm e2e`，不要直接调 playwright**：`scripts/run-e2e.mjs` 先向系统要一个空闲端口并把它交给配置，直接调用则用 1420——那是 `pnpm tauri dev` 自己占的端口，谁先起谁赢，后起的会把前一个的服务踢掉。CI 跑的是直接调用（`ci.yml:62`），因为 CI 里没有第二个进程抢这个端口。

### 1.4 Rust

76 个集成目标（`apps/desktop/src-tauri/tests/*.rs`）加单元测试。从仓库根：

```bash
NEKOWITE_REQUIRE_PROCESS_TESTS=1 cargo test --locked --no-fail-fast \
  --manifest-path apps/desktop/src-tauri/Cargo.toml
```

`NEKOWITE_REQUIRE_PROCESS_TESTS=1` 把「需要真实进程、这台机器上跑不了」从跳过变成失败；本地不加它时那几条会静默跳过。只跑一个目标加 `--test <名字>`。

### 1.5 三个 instrument 与三个非 vitest 套件

| 命令 | 失败条件 |
|---|---|
| `python3 scripts/check-reachability.py` | 有 import 指向不存在的文件（先跑对照：扫描被人为弄瞎时必须报错） |
| `python3 scripts/check-dead-exports.py` | 对照失明，或「没有任何调用点」的导出数超过文件里的 `CEILING`（现为 85） |
| `python3 scripts/check-channels.py` | Rust 发出的事件在前端没有名字，或前端 `listen` 的事件没有发出点 |
| `bash scripts/boot-probe.test.sh` | 45 条断言：启动探针的崩溃 / 早退 / 存活三条路径、取消语义、HOME 与六个 XDG/TMPDIR 的隔离（`xvfb-run`、`dbus-run-session`、`pkill` 都是 mock） |
| `bash scripts/package-linux.test.sh` | 46 条断言：打包脚本的 6 个场景（缺件 / 陈旧 / 缺 portable / 校验失败 / 发布失败 / 成功），含「只 `exit 0` 的假 rpm 必须被拒绝、真 rpm 必须被选中」与「三个 XDG 目录与 TMPDIR、npm 缓存都必须落在本次运行的临时目录里」 |
| `pnpm --filter @nekowite/desktop test:webkit-harness` | harness 自己的 5 个 `node:test` 用例：HiDPI 裁剪换算、探针「什么都没量到」的判定规则 |
| `node apps/desktop/e2e/webkit/drive-app.mjs`（需 `xvfb-run`，需要已构建的应用） | **真实应用**的真机探针（不属于上面的 gate，原因见 §4）：页面是否 Tauri 页、生产 CSP 是否在应用内生效（`eval` 对照 + `blob:` 导入被拒）、知识库是否打开、笔记是否用原生点击打开、图片是否经 `asset://` 渲染、真实按键输入的文字是否被 `Ctrl+S` 写到磁盘 |
| `node apps/desktop/e2e/webkit/drive-app.mjs --print`（同上，另需 `xwininfo` / `xprop` / `xdotool`） | 上面那条再加一步：右键菜单里的「导出 PDF」。读数：打印帧里确实是渲染后的整篇文档（`@page` 规则、正文、`asset://` 图片已解析）→ **有没有出现真正的 GTK 打印对话框**（`xwininfo` 取 X 树，`xprop` 排除 tooltip/弹出类，尺寸排除 1×1 与 10×10 辅助窗，并存一张截图）→ 关掉对话框后打印帧有没有被移除；没有对话框时，把同一批调用分别在**应用自己的打印帧**与主框架里重做，读 `beforeprint`/`afterprint` |
| `node apps/desktop/e2e/webkit/probe-print-dialog.mjs`（需 `xvfb-run`） | 同一批调用在 **WebKitGTK 自带浏览器**（MiniBrowser）里的对照：主框架与隐藏 `srcdoc` 帧各自 `window.print()` 后 `beforeprint` 是否触发、有没有对话框窗口。对照项是探针自己启动的 `xmessage` 窗口——它必须被看见，否则整轮判为「无法归因」并以 1 退出 |
| `node apps/desktop/e2e/webkit/probe-csp-frame.mjs`（需 `xvfb-run`） | 应用自己的 CSP 会不会拦掉它自己的导出帧：`frame-src 'none'` 下网络帧必须被拒并报 `violations=frame-src<-http`，而三个功能用的 `srcdoc` 帧必须照常加载；两者都带无策略对照 |
| `node apps/desktop/e2e/webkit/probe-egress.mjs`（需 `xvfb-run`，需要已构建的应用） | 运行中的应用到底连了谁、什么时候连：用一个只记录、不代理成功的本地代理（`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`）罩住应用，再分段量——启动与空闲十秒（必须一条都没有）、注册表**新鲜缓存**（必须一条都没有，这也是仪器自身的对照）、注册表**陈旧缓存**（必须恰好一条 `cdn.agentclientprotocol.com:443`）、宠物形象库（必须恰好一条 `pets.thenightwatcher.online:443`）、渲染一篇带远程图片与行内公式的笔记（必须一条都没有，且公式必须渲染成 MathLive 标记、本地图片必须经 `asset://` 加载成功）。任何 `docs/PRIVACY.md` 没列出的主机出现即失败；最后以**从页面发起的一次导航**作为对照，证明这个代理确实看得到 WebView 自己的网络栈 |

`pnpm perf` 单列：`vitest run --config vitest.perf.config.ts`，断言 `docs/PERF.md` 的预算。`check:export-css` 单列：`node scripts/check-katex.ts`，读 `dist/assets/*.js`，因此必须在 `pnpm build` 之后跑。

## 2. 覆盖清单（功能域 → 真实测试 → 状态）

| 域 | 真实测试 | 状态 |
|---|---|---|
| Vault 打开/切换/恢复 | `stores/vault-session.test.ts`、`app/app-bootstrap.test.ts`、`app/vault-switch-refused-save.test.ts`、`src-tauri/tests/vault_auth_test.rs`、`e2e/app.spec.ts` | COVERED |
| 编辑器 三视图/保存/关闭保存 | `e2e/app.spec.ts`、`e2e/editor-input.spec.ts`、`e2e/save-roundtrip.spec.ts`、`e2e/lifecycle.spec.ts`、`features/editor/controller/editor-persistence.test.ts`、`app/close-requested-unsaved-keystroke.test.ts` | COVERED（撤销粒度见下） |
| 撤销粒度 | `packages/editor-core/src/history-typing.test.ts`、`history-switch.test.ts`、`table/ops.test.ts`、`image/attrs.test.ts` | COVERED：一次键入 burst（十个字符）`undoDepth` 为 1、一次撤销回到打开时的文本；相隔超过分组间隔的两段输入是两步；一次多行插入是一步。第二个用例同时是第一个的对照——同一段代码、同样的插入，只有时间不同就读到 2 而不是 1 |
| MDX 往返/未知 JSX/边界 | `packages/editor-core/src/mdx/roundtrip.test.ts`、`mdx/byte-fidelity.test.ts`、`mdx/parse-resilience.test.ts`、`mdx/mdx-document.test.ts`、`docs/mdx-demo/__validation/validate.test.ts` | COVERED（含 fuzz：`editor-roundtrip-fuzz.test.ts`、`serialize-fuzz.test.ts`） |
| 图片 粘贴/拖入/落盘/失败恢复 | `features/editor/composables/use-image-intake.test.ts`、`ui/EditorPane.imageIntake.test.ts`、`features/attachments/services/attachment-import.test.ts`、`attachment-paths.test.ts`、`e2e/image-insert.spec.ts`、`e2e/image-render.spec.ts`、`ui/ImagePanel.test.ts` | COVERED |
| 表格 行列/剪贴板/列宽/往返 | `packages/editor-core/src/table/ops.test.ts`、`table/clipboard.test.ts`、`table/resize.test.ts`、`table/stringify.test.ts`、`table-clipboard-guard.test.ts`、`ui/TableMenu.test.ts`、`e2e/table-resize-handle.spec.ts` | COVERED |
| 数学公式 解析/往返/节点视图/对话框 | `packages/editor-core/src/math/smoke.test.ts`、`nodes.test.ts`、`atoms.test.ts`、`dialog.test.ts`、`dialog-upgrade-window.test.ts`、`views.test.ts` | COVERED：`$…$`/`$$…$$` 的解析与保存往返、节点形状、对话框的升级顺序都有用例。`views.test.ts` 是**库晚到**那条竞态的回归用例（`mathlive` 的导入被闸住，放行后才 resolve），对照是同一篇笔记、库已就位；真机前后读数见 `docs/audits/2026-09-21-fixes-applied.md` §26 |
| 搜索索引 全文/增量/持久化/取消 | `features/search/index.test.ts`、`features/search/services/index-storage.test.ts`、`index-shard-store-race.test.ts`、`features/vault/services/index-persistence.test.ts`、`features/vault/services/vault-index.test.ts`、`services/content-search.test.ts` | COVERED |
| 图谱 解析/重建/过滤器 | `services/link-graph.test.ts`、`features/graph/components/GraphPanel.test.ts`、`services/graph-layout-client.test.ts`、`e2e/usage-search-graph.spec.ts` | COVERED |
| 插件 授权前不执行/超时/审计/CSP | `packages/plugin-host/src/runtime.test.ts`、`lifecycle.test.ts`、`trust.test.ts`、`governance.test.ts`、`services/security-regression.test.ts`、`services/plugins.test.ts`、`e2e/security-csp.spec.ts` | COVERED |
| 安全 vault 绑定/Key 掩码/KDF/路径 | `src-tauri/tests/vault_auth_test.rs`、`keys_test.rs`、`key_vault_status_test.rs`、`fs_test/path_policy.rs`、`asset_scope_test.rs`、`services/security-regression.test.ts`、`services/paths.test.ts` | COVERED |
| 持久化/窗口 | `platform/persistence/persistence.test.ts`、`stores/window-state.test.ts`、`app/window-state.test.ts`、`src-tauri/tests/main_window_test.rs`、`src-tauri/tests/desktop_pet_settings_test/geometry.rs` | COVERED：版本迁移、几何 clamp 与校验、主窗口身份与重建、桌宠窗口几何的 Rust 侧（`apply_window_geometry`）都有用例。**没有任何用例能证明 `setSize` / `setPosition` 真的移动了窗口**——那是窗口管理器的行为，下面 §3 单列 |
| 导出 HTML/PDF | `services/export.test.ts`、`export-renderers.test.ts`、`export-page.test.ts`、`features/notes/composables/use-note-export.test.ts`、`use-export-settings.test.ts`、`NoteListPanel.noteMenu.test.ts`、`packages/editor-core/src/export/golden.test.ts` | COVERED：HTML 与渲染器有断言（含 golden 逐字节）；PDF 一侧覆盖到打印文档的内容、`@page` 规则、iframe 生命周期，以及由 `beforeprint`/`afterprint` 决定的返回值（`printed` / `no-print-started`）与两个调用点各自的提示。**打印对话框本身、以及它写出的那个文件**没有任何自动化证据——那是操作系统的窗口，测试驱动不了；但「本机到底弹不弹」已有真机读数，见 §3 |
| 恢复/无障碍 | `app/recovery-closed-loop.test.ts`、`stores/tab-recovery.test.ts`、`stores/untitled-rescue.test.ts`、`services/announcer.test.ts`、`composables/use-focus-trap.test.ts`、`features/settings/components/SettingsPanel.focus.test.ts` | COVERED |

## 3. 明确没人守的地方

- **系统打印对话框**：PDF 的最后一跳——用户点「打印」之后系统对话框做了什么、文件落在哪里——没有自动化证据，因为那是操作系统的窗口（`xwininfo` 只能证明窗口有没有出现，不能驱动它的按钮）。送进对话框之前的一切现在都有读数：渲染内容、`@page` 纸张规则、`asset://` 图片是否解析、iframe 的挂载与清理（`services/export.test.ts`），以及**本机是否真的弹出对话框**（`drive-app.mjs --print`）。2026-09-22 的读数是否定的：WebKitGTK 2.52.6 上 `window.print()` 被接受、`beforeprint` 不触发、对话框不出现、也不抛异常；同一批调用在 WebKitGTK 自带的浏览器里（`probe-print-dialog.mjs`，带 `xmessage` 对照，也在 `kwin_x11` 下重跑过）同样什么都不发生。所以「导出 PDF 什么也没发生」现在会明确报错，并给出「导出 HTML → 浏览器打印」的替代路径。
- **几何操作真的生效**：主窗口的 `win.setSize` / `win.setPosition`（`app/window-state.ts`）与桌宠窗口的 `apply_window_geometry` 都只测到「参数算对了、传下去了」。**「回显」不等于「生效」**：2026-09-22 实测过一件同类的事——在没有窗口管理器的 Xvfb 里，WebDriver 的 `Set Window Rect` 会把你给的数字（800x600、1280x836、1600x1000）原样回显，而内容区始终是 1024x732。窗口管理器是否照做，只有在有 WM 的真实会话里才能回答；这条与 `e2e/webkit/` 的那条前提是同一件事。
- **`pnpm test:e2e` 是个陷阱**：它直接调 playwright（§1.3）。CI 用它没问题，本地在有 `pnpm tauri dev` 时用它会抢端口。

以上都不是「大概没问题」，而是「没有证据」：写在这里是为了让下一个改动它的人知道自己在无人区。（曾经还有两条——撤销粒度、以及 `use-note-export.ts` 完全没有测试——已在后续两轮补上，见 §2 的对应行。）

## 4. 需要人工复查的风险点

自动化覆盖不到、需要人对着程序看一遍的：

- 编辑器实例的销毁是否单所有权（`destroy` 只发生一次），`runtime.dispose` 是否在 App 卸载时真的被调用。
- Vault 注册失败时是否阻止切换（有测试，但仍值得在真机上看一次提示是否可读）。
- 资源泄漏：ProseMirror、DOM、Worker、AbortController、timer、listener。
- 图片 `asset://` scope：**普通情况已经有真机读数**——`node apps/desktop/e2e/webkit/drive-app.mjs`
  在真实应用里用原生点击打开一篇带图的笔记（2026-09-22：`src=asset://localhost/%2F…`、
  `naturalWidth=64`），也就是「前端要路径 → `media.rs` 只放行这一个文件 → 窗口取回」这条链在发货的
  应用里跑通了。仍然是人工的：图片先暂存在 `.tmp/`、保存后才移入 `<笔记名>_assets/` 的那一段。
- 安全边界：插件是否真的隔离（架构级残留）、Key 不出现在 URL 或日志、路径逃逸被拒。
- **为什么 `drive-app.mjs` 不在 gate 里**：它需要**已构建的应用**、`WebKitWebDriver` 与一个显示器
  （`tauri-driver` 把应用交给 WebDriver 驱动）。gate 的 `scripts` 步骤在缺这些东西的机器上只能跳过，
  而「跳过读起来像通过」正是这套程序一直在拆的形状，所以它是**手动**探针，读数写在提交与账本里。

## 5. 怎么重新跑一遍

```bash
bash scripts/gate.sh --with-e2e     # 全量，本地的权威命令
bash scripts/gate.sh --only verify  # 只跑 typecheck/lint/test/perf/build/export-css

# 单个域（示例）
pnpm --filter @nekowite/desktop exec vitest run features/search
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --test vault_auth_test
pnpm --filter @nekowite/desktop exec playwright test e2e/image-insert.spec.ts
```

修 bug 的顺序按 `AGENTS.md`：先写一条能复现症状的失败测试，再改实现，最后跑 gate。早先写的「修复后循环验证 ≥10 次」是当时没有单一入口时的替代品——现在一次 `scripts/gate.sh` 就覆盖全部步骤，改完跑它，并把它打印的计数（而非退出码）当作读数。
