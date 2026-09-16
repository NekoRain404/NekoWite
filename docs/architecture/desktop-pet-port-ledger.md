# DesktopPet 移植台账

**维护者:** 主代理（DesktopPet 计划 §2、§10 的 D0）。实现子代理只提交证据，不修改本文件。
**对应计划:** `docs/superpowers/plans/2026-09-16-desktop-pet-port.md`（只读）

本文件是 D0 的交付物，也是 §2 要求的「来源固定 + 逐项移植记录」。它同时记录**两个计划之间的文件所有权冲突**——这是并行开发最先会撞上的地方，不写下来就会被两个代理各自改一遍。

## 1. 来源固定

| 项 | 值 |
| --- | --- |
| 上游 | `https://github.com/Imzl-zl/desktop-pet` |
| 本地只读目录 | `references/desktop-pet/`（**已 gitignore，不得进入 workspace、测试收集、构建输入、发布包、资产目录或 sidecar**） |
| 获取方式 | `git clone --depth 1`，保留其独立 `.git`，**不作为子模块提交** |
| 固定提交 | `be171a01273a1ed92a27bcdf72f8a58768bac421` |
| 核对日期 | 2026-09-16 |
| 代码许可 | **MIT**，`Copyright (c) 2026 Nguyễn Thành Đạt`（根 `LICENSE`） |
| 素材边界 | 根 MIT **不覆盖全部角色素材**；README 声明角色素材各自授权。素材**逐包**记录作者/来源/许可/再分发条件，**不把「下载成功」当授权证明** |
| Linux 来源 | 上游 `windows/` 实为 Windows/Linux **共用**的 Tauri 应用；目录名不代表应引入 Win32 实现 |

`.gitignore` 只防误提交，**不能替代构建/打包白名单**（计划 §2）。`sys_windows.rs` 不进入产品：窗口枚举仅 Win32 有实现，非 Windows 返回空数组，攀爬功能不得宣称 Linux 已支持。

## 2. 上游体量清点（实测行数）

`windows/` 下 10,311 行 TypeScript + Rust。超过 300 行的文件在迁入时**必须拆分**（计划 §9：不能先复制超长文件再承诺以后整理）：

| 文件 | 行数 | 迁移方式（计划 §3） |
| --- | --- | --- |
| `src/settings.ts` | **1827** | 全量盘点设置项，按本项目设置页迁入。**不嵌 HTML、不留全局 DOM 查询、不留第二套 localStorage** |
| `src/i18n.ts` | **1126** | 不复制整份字典，按 §10.1 只加桌宠命名空间 |
| `src-tauri/src/lib.rs` | **892** | 按窗口/设置/资源/提醒拆出可复用行为。**禁止复制第二个 Tauri Builder 或全套 invoke handler** |
| `src/main.ts` | **774** | 原生 DOM 应用入口，不整体挂载进 Vue |
| `src/bubble.ts` | **665** | 保留布局/字段/模板与显示行为，按领域拆分；模型进纯服务，DOM 拼接改 Vue，**动态文本不直接插 HTML** |
| `src-tauri/src/transcript.rs` | 435 | 外部 Agent 监控的可选扩展方向，内置 ACP 不走 hooks |
| `src-tauri/src/cli.rs` | 427 | 同上 |
| `src/demo.ts` | 325 | 演示事件必须隔离，不进入真实历史/奖励/通知 |
| `src/pet.ts` | **314** | 优先复制，分离切帧/播放/命中测试；配置、时钟、随机源改为注入 |
| `src-tauri/src/hooks.rs` | 309 | 后续用户主动开启；**不得自动探测或读取用户登录凭据与私人聊天记录** |
| `src-tauri/src/server.rs` | 283 | 外部监控桥：仅监听本机、验证用户/来源、限速限量；**不得开放局域网控制端口** |
| `src/floating-ball.ts` | 276 | 保留悬浮球；不重复建立系统托盘/进程/设置窗口 |
| `src/care.ts` | 236 | 保留本地成长/等级/成就规则；注入时间与随机，按任务幂等结算 |
| `src/activity.ts` | 219 | 活动表现 |
| `src/roam/*.ts` | 192+172+148+139+101+… | 保留运动逻辑；窗口/指针/屏幕坐标封装为 Linux 平台能力，**不搬 Win32 API** |
| `src/popover.ts` | 178 | 任务弹层；任务入口路由到 NekoWite |
| `src/state.ts` | 167 | **借鉴**任务投影与情绪聚合，**不复制为第二份任务事实源** |
| `src/usage.ts` / `src/sync.ts` / `src/history.ts` | 156/129/109 | 历史不复制聊天数据库；云同步单独开关与服务评审 |
| `src/catalog.ts` + `projectpets.ts` | 108/… | 角色库、项目绑定；资源落入受管缓存，路径绑定转稳定 `vaultId` |
| `src/icons.ts` | 110（64 KB） | 图标资源 |
| `src-tauri/src/statemap.rs` | 102 | 状态映射 |
| `src-tauri/src/sys_windows.rs` | 138 | **不进入产品** |

## 3. 依赖差距（计划 §10.1：仅经评审批准后由集成者修改）

上游 `windows/package.json` 用了 **4 个我们没有的 Tauri 插件**：

| 上游依赖 | 本项目现状 | 用途 | 处置 |
| --- | --- | --- | --- |
| `@tauri-apps/api` | **已有** | — | 直接用 |
| `@tauri-apps/plugin-notification` | **缺** | D5 系统通知投递 | 需评审。§7.2 要求「无动作能力不显示无效按钮」；Linux 通知可用性本身待实测 |
| `@tauri-apps/plugin-process` | **缺** | 生命周期/退出 | 需评审。§7.1 要求托盘与退出语义并入宿主，**不创建第二个退出菜单** |
| `@tauri-apps/plugin-autostart` | **缺** | 开机启动 | §5.2：使用宿主现有能力；**没有现成能力则独立立项，不能注册第二套启动项** |
| `@tauri-apps/plugin-updater` | **缺** | 独立更新器 | §4：**不移植独立更新器**，合并进 NekoWite 更新流程 |

上游用 Vite 5 + Vitest 4；本项目是 Vite + Vitest 3.2.7，**不复制上游 lockfile 或 vite/tsconfig 配置**。上游 `windows/src/catalog.test.ts` 是唯一现存测试（76 行），可作为迁移参考但不构成我们的测试覆盖。

## 4. 与 ACP 计划的文件所有权冲突（并行开发必读）

两个计划共用同一仓库。以下文件**两个计划都需要改**，必须单一所有者，否则会出现「各自都改对、合并后注册错东西」：

| 共享文件 | ACP 计划所有者 | DesktopPet 计划需要者 | 处置 |
| --- | --- | --- | --- |
| `R/src/lib.rs` | **T4** | D3（轻量入口）、D12 | **串行**：先由 T4 完成 ACP 注册，D12 再增量加桌宠入口 |
| `R/src/commands/mod.rs` | **T4** | D12 | 同上 |
| `R/src/state/app_state.rs` | **T4** | D3/D12 | 同上 |
| `S/app/AppShell.vue` | **T16** | D12（设置定位） | 串行，D12 在后 |
| `S/features/settings/types.ts` | **T16** | D12 | 串行 |
| `S/features/settings/components/{SettingsPanel,SettingsNavigation}.vue` | **T16** | D12 | 串行 |
| `apps/desktop/vite.config.ts`、`R/tauri.conf.json` | 未占用 | **D12**（多入口） | 归 D12 |
| `R/Cargo.toml`、前端清单与锁文件 | T2 已加 ACP SDK | D12（插件） | 每次改动单独评审，**不得并发改** |

**依赖方向（计划 §6.1）：** 桌宠复用 `S/platform/gateways/agent-contracts.ts` 的 `AgentIdentity`、`AgentEvent`、`AgentRunResult`，**不新造一套不兼容 ACP 的事件**。该契约由 ACP 计划的 T1 交付（已完成），因此 D1 可以开工；但**桌宠的任务投影（D4/D5）要有真事件可投影，必须等 ACP 运行时产出事件**——即 ACP 在 Rust 侧领先，桌宠在 TS 侧可以并行。

**可安全并行的分工：**

| 通道 | ACP 计划 | DesktopPet 计划 |
| --- | --- | --- |
| TypeScript（无编译争用） | T1 ✅、T5、T6–T11 | **D1、D2**、D7a/b/c、D9、D11 |
| Rust（**必须串行排队**） | T2 ✅、T2b、T3、T3a、T4 | D3、D4、D5、D6、D8、D10、D12 |

## 5. 逐项移植记录

**目前为空——尚无上游代码进入产品源码。**

需要登记时的格式（计划 §2 / §10.2）：上游固定提交、源路径与符号、目标文件、许可证、保留的行为、修改原因、测试证据、已知差异。

**发布前必须完成的义务：**
- 新增 `third-party/desktop-pet/LICENSE` 保留原许可全文，并在第三方声明/关于页展示来源（计划 §2）。
- 素材**逐包**记录作者、来源、许可与再分发条件（§2、§8）。
- 发行包检查**不含** `references/desktop-pet/`、上游 `.git`、云服务源码、Win32 依赖、原作者更新端点、私人凭据或无许可素材（§12）。

## 6. 上游行为中必须修正、不得机械搬运的项（计划 §3.1）

实现代理**逐条对照**，这些是上游的已知缺陷而非风格差异：

1. `state.ts` 的部分删除/授权查找**只按 session ID 匹配** → 迁入后必须完整匹配 Agent、profile、vault、实例、会话、任务，避免多引擎冲突。
2. 上游**用沉默约 5 分钟推断任务完成** → NekoWite 不得以沉默推断完成；运行时状态为准，连接异常显示未知/中断。
3. 上游 working 情绪优先于 waiting → **待授权必须可见**，不能被另一项工作无限遮住。
4. 上游设置大量**直接写 localStorage 并广播** → 合并后只有一个持久化写入权威，事件带版本，防止桌宠窗口用旧状态覆盖主窗口。
5. `catalog.ts` 远端取目录**失败时返回空列表** → 区分「离线 / 空库 / 损坏 / 授权不明」，保留已安装角色，**禁止失败时重新下载覆盖**。
6. 上游是原生 TS/DOM 而非 Vue → **不得把 1800 行脚本塞进 `onMounted`**。
