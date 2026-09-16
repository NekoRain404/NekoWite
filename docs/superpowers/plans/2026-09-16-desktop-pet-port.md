# NekoWite DesktopPet 移植开发计划

> For agentic workers: 实施时使用 `executing-plans`，或在明确授权子代理协作后使用 `subagent-driven-development`，逐项测试与复核。本文、AGENTS.md、路线图和其他设计文档只能由主代理修改。实现子代理不得覆盖、重写、移动或删除它们。

**Goal:** 优先将 DesktopPet 的主要桌面交互、角色体系和设置迁入 Linux NekoWite；桌宠作为轻量交互与任务提醒入口，共享既有 Agent 后端。先完成可验证的移植，再决定精简，不退化为只会显示通知的图标。

**Architecture:** 复用上游可移植的 TypeScript/Rust 逻辑，Vue 重建设置与交互视图，Tauri 托管独立桌宠窗口。运行时提供可信任务状态和单一通知决策，桌宠不直接驱动模型、读取凭据或独立管理 ACP 进程。设置并入 NekoWite，数据使用受控持久化与跨窗口快照。

**Tech Stack:** 现有 Vue 3、Pinia、TypeScript、Canvas 2D、Tauri 2、Rust；沿用 Vitest/Playwright/Cargo 测试。新增插件、依赖及锁文件改动需经维护者确认；不能复制上游 package.json、lockfile、Tauri 配置覆盖本项目。

**状态:** 开发规划，尚未实施或运行上游程序。已克隆源码并读取关键实现；未声称 Linux 兼容、素材可分发或功能移植已经完成。本文是总体计划，任务进入开发时由主代理补齐对应源码差异、完整测试代码及精确文件白名单，不能用此文代替每项的代码审查。

## 1. 已确认的要求

- 平台仅 Linux，验证 AppImage/deb/rpm；不扫描或修改 `NekoWite_win`。
- 优先搬运和移植 DesktopPet；不先进行大幅删减，不重新设计一套等价桌宠引擎。
- 桌宠负责基本交互、状态表现与任务完成提醒；复杂对话、工具权限和变更审阅仍在主面板。
- 所有面向用户的桌宠设置进入 NekoWite 设置页，不保留独立 DesktopPet 设置程序。
- 默认对接内置 OpenCode，契约同时支持后续外置 Agent；桌宠不硬编码某个 Agent 的名字、模型或状态输出格式。
- 保留现有主题、强调色与项目规范。业务文件 300 行规划拆分、400 行执行拆分、500 行停止追加；测试超过 800 行按行为域拆分。
- 本轮仅交付源码参考和文档，不修改业务实现。具体功能移除必须列出原因并获用户确认。

“保留功能”不等于无需改造地复制所有进程、云服务、系统钩子和权限。应用外壳合并、安全边界修正和 Linux 不支持项的显式降级属于必要移植工作，不是产品精简。

## 2. 源码基线与许可

| 项目 | 固定内容 |
| --- | --- |
| 上游 | https://github.com/Imzl-zl/desktop-pet |
| 本地只读目录 | `references/desktop-pet/` |
| 获取方式 | `git clone --depth 1`，保留其独立 Git 元数据，不作为子模块提交 |
| 核对日期 | 2026-09-16 |
| HEAD | `be171a01273a1ed92a27bcdf72f8a58768bac421` |
| 代码许可 | 根 `LICENSE` 为 MIT，保留原版权和许可全文；依赖另行核对 |
| 素材边界 | README 明确角色素材各自授权，应用代码 MIT 不覆盖图库全部素材 |
| Linux 来源 | 上游 `windows/` 实际为 Windows/Linux 共用 Tauri 应用；名称不代表应引入 Win32 实现 |

参考源码不进入 workspace、测试收集、发布包、资产目录或 sidecar；`.gitignore` 只防误提交，不能替代构建/打包白名单。不得对参考目录做格式化或业务修复。必要更新由主代理显式刷新并记录新提交，不自动拉取浮动 main。

正式复制代码前，由主代理维护 `docs/architecture/desktop-pet-port-ledger.md`，逐项记录：源提交、路径/符号、目标文件、许可证、保留行为、修改原因、测试证据和已知差异。发布前新增 `third-party/desktop-pet/LICENSE` 保留原文，并在项目第三方声明/关于页展示来源。素材逐包记录作者、来源、许可和再分发条件；不把下载成功当授权证明。

## 3. 已读源码与迁移边界

以下路径均相对 `references/desktop-pet/`。已直接阅读 README、LICENSE、关键代码与目录；表中未全量审查的模块仍需对应任务开工时检查，不把文件名当作实现完备证据。

| 上游模块 | 迁移方式 | 必要适配 |
| --- | --- | --- |
| `windows/src/pet.ts`，314 行 | 优先复制并分离切帧、播放、命中测试 | 配置、时钟和随机源改为注入；按实际帧变化绘制；处理销毁与资源失败 |
| `windows/src/bubble.ts`，665 行 | 保留布局、字段、模板和显示行为，按领域拆分 | 模型进入纯服务，DOM 拼接改 Vue，动态文本不直接插 HTML |
| `windows/src/settings.ts`，1827 行；`settings.html` | 全量盘点设置项，按本项目设置页面迁入 | 不直接嵌入 HTML，不保留全局 DOM 查询、重复初始化与第二套 localStorage 状态 |
| `windows/src/state.ts` | 借鉴任务投影与情绪聚合，不复制为第二份任务事实源 | 复合身份、终态、超时、授权绑定按第 6 节修正 |
| `windows/src/care.ts`，236 行 | 保留本地成长、等级和成就规则；开工时核对所有数据依赖 | 注入时间/随机，按任务幂等结算，不伪造未知 token |
| `catalog.ts`、`projectpets.ts` | 保留角色库、重命名、项目绑定、装饰角色 | 资源落入受管缓存；路径绑定转为稳定 vaultId；动态资源经过验证 |
| `roam/{engine,environment,modes,physics,window,types}.ts` | 保留可移植运动逻辑和配置 | 把窗口、指针、屏幕坐标封装为 Linux 平台能力；不搬 Win32 API |
| `floating-ball.ts`、`popover.ts`、`reactive.ts`、`activity.ts` | 保留悬浮球、任务弹层和活动表现 | 不重复建立系统托盘/进程/设置窗口；任务入口路由到 NekoWite |
| `history.ts`、`usage.ts`、`sync.ts` | 本地历史/统计与可选同步分别迁移 | 历史不复制聊天数据库；云同步单独开关、授权与服务评审 |
| `src-tauri/src/lib.rs`，892 行 | 按窗口、设置、资源和提醒拆出可复用行为 | 禁止复制第二个 Tauri Builder、应用更新器或全套 invoke handler |
| `src-tauri/src/{hooks,server,transcript}.rs` | 保留外部 Agent 监控的可选扩展方向 | 内置 ACP 不走 hooks；不得自动探测/读取用户登录凭据和私人聊天记录 |
| `src-tauri/src/sys_windows.rs` | 不进入产品 | 窗口枚举仅 Win32 有实现，非 Windows 返回空数组；攀爬不能宣称 Linux 已支持 |

### 3.1 必须修正，不能机械搬运的行为

1. `state.ts` 的部分删除/授权查找只按 session ID 匹配；迁入后必须完整匹配 Agent、profile、vault、实例、会话、任务，避免多引擎冲突。
2. 上游会清理沉默超过约 5 分钟的工作/等待会话；NekoWite 不得用沉默推断任务完成。运行时状态为准，连接异常显示未知/中断。
3. 上游 working 情绪优先于 waiting；迁入后待授权必须可见，不能被另一项工作无限遮住。视觉情绪与逐任务提醒独立。
4. 上游设置大量直接写 localStorage 并广播通知；合并后只有一个持久化写入权威，事件带版本，防止桌宠窗口用旧状态覆盖主窗口。
5. `catalog.ts` 从远端取目录，错误返回空列表；迁入后区分离线、空库、损坏、授权不明，保留已安装角色，禁止失败时重新下载覆盖。
6. 上游是原生 TypeScript/DOM 而非 Vue。可复用算法不等于可直接挂载整个 UI；不得把 1800 行脚本塞入 Vue `onMounted`。

## 4. 功能保留与交付分组

| 组别 | 移植内容 | 首次发布要求 |
| --- | --- | --- |
| A 核心桌宠 | 透明角色窗口、切帧动画、状态映射、缩放、拖动、命中测试、点击、右键入口 | 必须完成；Linux 不支持的窗口能力有明确回退 |
| B 任务提醒 | 工作/待授权/结束状态、气泡、声音、系统通知、点击返回任务 | 必须完成；成功/取消/失败/受限结束不能混淆 |
| C 完整本地设置 | 角色库、导入/创建、动画绑定、气泡样式与词句、声音、实时预览、减少动态效果 | 必须完成，不只保留三四个开关 |
| D 本地扩展交互 | 悬浮球、装饰角色、多任务弹层、项目角色、可支持的漫游模式 | 在首轮移植任务内保留；按能力和资源上限交付，不静默删掉 |
| E 本地养成与记录 | 成长、成就、角色状态、历史、可靠来源的用量统计 | 保留目标；规则可复用，数据采集需适配，不能为了升级主动消耗 token |
| F 在线和外部集成 | 在线角色库、hooks、云资料/排行榜/跨设备恢复 | 保留设计和迁移清单，显式选择开启；不得默认连接原作者服务或写入外部 CLI 配置 |

先让 A/B/C 跑通，再交付 D/E，最后单独验证 F。F 未完成不阻塞本地版本，但发布说明必须列出未迁入部分，不能宣称“上游全部功能等价”。F 的网站/账户服务是独立部署范围，不因为移植客户端就取得上游服务运营权限。

不移植的重复外壳：DesktopPet 自己的设置窗口、独立应用退出、独立更新器、独立开机启动注册和 macOS/Windows 安装流程。它们分别合并到 NekoWite 的设置、生命周期和更新流程，而不是删除对应用户能力。

## 5. NekoWite 设置整合

### 5.1 页面层次

```text
NekoWite 设置
├── 常规 / 外观 / 编辑器 / 导出 / AI / 插件（现有）
└── 桌宠
    ├── 常规与交互：启用、显示、窗口行为、点击动作、悬浮球
    ├── 角色与动画：角色库、导入/创建、名称、大小、动画映射、预览
    ├── 气泡与消息：主题、透明度、字体、布局、词句、多任务字段
    ├── 通知与声音：完成/失败/等待、勿扰、声音、测试提醒、隐私
    ├── 养成与统计：等级、成就、近期统计、休息提醒、清理记录
    ├── 项目与多角色：库绑定、主角色、装饰角色、数量上限
    └── 高级与集成：外部监控、诊断、配置导入/导出、可选在线服务
```

这是同一个设置容器内的子导航，不再开独立设置程序。桌宠右键“设置”打开主窗口并定位到 `desktop-pet` 及指定子页；主窗口隐藏时先安全唤起，不依赖 DOM 是否已挂载。预览放当前设置内容区，不套新的完整应用窗口。

### 5.2 上游设置映射

| 上游设置/功能 | 新位置 | 合并规则 |
| --- | --- | --- |
| General：语言、开机启动、版本、退出 | NekoWite 常规/关于/应用生命周期 | 使用宿主现有能力；没有现成能力则独立立项，不能注册第二套启动项 |
| General：通知、完成/等待声音、自定义音频 | 桌宠/通知与声音 | 保留上传、试听和恢复默认；补失败/取消策略与通知隐私 |
| General：Reduce motion | 桌宠/常规与交互 | 跟随系统/应用减少动态效果；桌宠可以更保守，不能反向解除全局限制 |
| Pet：主角色显示、选择、浏览、创建、重命名 | 桌宠/角色与动画 | 保留；浏览联网需用户发起，本地导入可离线 |
| Pet：大小、状态动画、待机动画列表/顺序/间隔 | 桌宠/角色与动画 | 保留即时预览；未知动画行明确回退，不读任意越界帧 |
| Pet：额外装饰角色、漫游模式/速度 | 桌宠/项目与多角色、常规与交互 | 保留；按平台能力禁用不可用模式，提供一键收回所有角色 |
| Bubble：主题、透明度、字体、待机消息、活动回应 | 桌宠/气泡与消息 | 默认跟随宿主主题；保留明确的局部外观覆盖 |
| Bubble：布局、行数、分组、过滤、排序、图标、字段预设 | 桌宠/气泡与消息 | 从当前 Agent 注册表生成列表，兼容未知 Agent，不固定上游名单 |
| Bubble：自定义词句、Agent 覆盖、快捷气泡、点击动作 | 桌宠/气泡与消息、常规与交互 | 纯文本模板；状态标签不可被自定义文案伪装成另一种结果 |
| Care：等级、成就、角色名称和数据 | 桌宠/养成与统计 | 本地数据保留；缺少 token 时显示未知，用完成任务驱动可验证奖励 |
| Care：登录、恢复、同步、排行榜 | 桌宠/高级与集成 | 默认关闭，服务来源与隐私评审通过后启用，不能借用原项目 OAuth 身份 |
| Advanced：Agent hooks、多 Agent 气泡、历史、演示 | 高级与集成、气泡与消息、养成与统计 | 内置任务无需装 hook；演示事件隔离，不进入真实历史/奖励/通知 |

实现前对固定源码逐项生成“上游控件 -> 新控件 -> 测试 -> 状态”的核对表，放主代理维护的移植记录。不能仅按 README 搬几个选项就标记设置迁移完成；不可用选项说明原因，不显示可点击但无效果的控件。

### 5.3 配置语义

- 主开关、角色选择、视图参数、消息配置、通知、养成、项目绑定分为独立 schema，带版本与显式默认值。不得把一个无类型对象贯穿所有组件。
- 所有数值验证有限性、范围和整数要求；越界旧值在迁移阶段确定回退，界面和后端使用同一规则。
- 试调外观即时预览，提交持久化成功后确认；保存失败展示错误并保持可重试状态，不伪装成功。防抖写入不得丢掉关闭设置前最后一次修改。
- 资源、音频和历史不以大块 base64 存入 localStorage；使用应用受管数据目录，配置仅存资源标识。
- 桌宠是应用级功能，不把全局配置/养成写进当前笔记库；现有 vault 文件持久化适配器不能直接当全局存储用。
- 跨窗口使用带 revision 的快照/更新，后端串行校验写入；旧 revision 冲突拒绝并重新加载，事件不能作为无需授权的配置写入口。
- 恢复本页默认只影响当前域，不清空角色库/养成；重置养成、删除素材、删除历史分别确认。
- 导入原 DesktopPet 数据由用户明确选文件；仅读受支持字段，预览差异、备份再迁移，不扫描真实用户目录、不改原数据。

## 6. Agent 接线与可靠提醒

### 6.1 单一任务事实源

```text
OpenCode / 可选外置 ACP Agent
                |
       NekoWite Rust Agent 运行时
                |
    校验身份、顺序、终态与权限归属
                |
       桌宠任务投影 / 提醒决策
           |                |
    桌宠窗口快照       一次性系统通知/声音
           |
       点击打开对应会话或审阅
```

当前已存在 `src/platform/gateways/agent-contracts.ts` 及其 `events.ts`。开工重新读取，因为 ACP 开发正在进行；复用 `AgentIdentity`、`AgentEvent`、`AgentRunResult`，不新造一套不兼容 ACP 事件。事件里未有的运行开始/权限解除应来自宿主快照或由契约负责人补充，不能猜测文本 token 就代表开始/结束。

身份至少包含 `agentId/profileId/runtimeEpoch/vaultId/sessionId/runId`；授权再绑定 requestId。业务键用结构化元组或明确编码，不以未转义冒号拼接后做后缀匹配。原始聊天内容、推理文本、凭据和工具完整输出不发给桌宠窗口。

### 6.2 终态映射

| 已有事件/结果 | 桌宠状态与提醒 |
| --- | --- |
| 快照确认正在执行 | working；无百分比猜测，不因暂时无文本停止工作 |
| `permission-request` | waiting-input；提示需要确认，点击去原权限 UI，桌宠不自行授权 |
| `run-finished` + `end-turn` | 本轮执行结束；可提醒“本轮已完成”，不能据此承诺用户全部目标和文件写入均成功 |
| `run-finished` + `max-tokens` / `max-turn-requests` | stopped/attention；说明到达限制，不播放成功庆祝 |
| `run-finished` + `refusal` | attention；展示无法继续，不算成功 |
| `run-finished` + `cancelled` 或取消类失败 | cancelled；默认无成功音，不算失败奖励 |
| `run-failed` 非取消类 | failed；保留任务入口，详情在主面板 |
| 运行时崩溃、连接丢失 | interrupted/unknown；不能转为 done，不自动重发可能有副作用的任务 |

本轮结束、会话归档、整个项目目标完成是三回事。只有运行时确实提供目标级任务标识时才展示目标级完成。

### 6.3 去重、恢复与聚合

- 一份后端提醒账本负责是否发通知，多个角色/窗口只展示，不能各自播音或发系统通知。
- 终态按完整任务键去重；等待授权按任务键 + requestId 去重；宿主 sequence 去除重放并发现缺口。补快照先恢复静态状态，再接增量，不重播全部历史庆祝。
- 在同次应用运行内，关开桌宠或重连不重复提醒；重启读取已处理账本。系统通知投递和持久化无法保证原子恰好一次，采用先记录再投递的至多一次尝试，崩溃空窗可能漏外部提示，但未读列表可恢复；测试并说明此边界。
- 终态不能被旧工作事件复活；同一任务后续轮次须有新 runId。重复/乱序事件不增加 XP。
- 多任务列表持续显示每个任务；聚合角色优先呈现待授权/失败等需关注状态，再工作，再短暂完成，再待机。另一个任务执行中，已完成任务仍进入未读，不被聚合情绪吞掉。
- 建议默认气泡 6 秒、3 秒内多个完成合并、同一批只播一次声音。待授权未读不因气泡消失而丢失；参数注入时钟测试，不写死到组件定时器。
- 当前正在查看该任务时抑制重复系统通知；勿扰禁声音和弹出，保留未读。退出勿扰不把所有过期事件重新弹一遍。
- 通知标题默认不含笔记内容/路径；用户明确开启才展示任务标题。通知动作使用宿主签发的有限目标标识，不接受任意 URL/命令/文件路径。
- 点击时重验库与会话归属；库已关闭则提示是否打开，不能后台切走未保存笔记。历史不可恢复时打开只读记录，不新建重复任务。

## 7. 窗口、动画与 Linux 限制

### 7.1 生命周期与能力

- 桌宠采用独立、按需创建的 Tauri webview；入口只初始化桌宠，不挂载 AppShell、编辑器、整套索引和 Agent 客户端。
- Tauri 管理窗口标识与角色实例关联；前端不能自选任意 label 去关闭主窗口。多角色数量受后端上限控制，建议默认最多 3 个、可配置硬上限 5 个，需性能验证后确认。
- 禁用桌宠销毁动画/监听/计时器，不取消后台 Agent 任务；切角色不重启运行时；隐藏时停止动画绘制但保留后端提醒。
- 托盘入口合并宿主，不创建第二个退出菜单；无托盘的 Linux 环境仍能从主设置恢复隐藏桌宠。
- 关闭主窗口、隐藏主窗口、退出整个应用保持现有语义。只有用户显式开启“关闭后驻留”并完成未保存处理后才可后台留驻，不能由桌宠改变退出行为。
- 桌宠窗口的 capabilities 独立且最小化；后端 IPC 验证调用窗口身份。仅限制前端按钮或只写 capabilities 文件不能替代自定义命令授权检查。

### 7.2 平台验证与回退

| 能力 | 验证目标 | 不可用时 |
| --- | --- | --- |
| 透明、无边框、置顶、不抢焦点 | GNOME/KDE，Wayland/X11 | 保留可关闭的小窗口或应用内停靠模式，说明当前环境限制 |
| 拖动与位置恢复 | 多屏、负坐标、缩放、热插拔、重启 | 请求 compositor 支持的拖动；找不到屏幕则回可见区域，提供重置位置 |
| 鼠标穿透 | 透明区和角色可点区、菜单打开/关闭 | 不宣称像素命中检测等于系统穿透；无支持则使用紧凑交互窗口 |
| 漫游/跟随指针 | 全局指针与主动定位是否可用 | 保留 stay，其他模式显示不可用；不绕过桌面安全限制 |
| 窗口攀爬 | 上游 Linux 没有窗口枚举实现 | 不复制 Win32；作为单独平台适配任务，不伪装已支持 |
| 系统通知与动作 | 权限拒绝、勿扰、桌面实现差异 | 未读任务入口始终可用；无动作能力不显示无效按钮 |

### 7.3 动画与资源预算

- 保留上游精灵动画、状态行、待机播放列表和用户映射；角色状态切换与窗口动效分离。
- 外壳/气泡出现建议 320-450ms，退场 180-260ms，轻微回弹；快速开关从当前状态反向运行，不排队。用户允许的 500ms 是上限选择，不是所有动画强制统一时长。
- 精灵按素材帧率刷新，壳层位移/透明度使用 compositor 可合成属性；不每帧读布局、发 IPC 或序列化全部任务。
- 只加载当前角色及小规模预览，图库缩略图按需加载；角色切换后释放旧图片、Object URL、Canvas 和监听。
- reduced-motion 保留静态状态、文本和未读，禁漫游/弹跳等非必要运动。减少动作不能关闭任务提示。
- 验收记录相同机器关闭/开启桌宠的 CPU、RSS、GPU 和编辑器帧时间差；建议单角色开启后输入 p95 延迟增幅不超过 10%，超过则分析而非增加动画时长掩盖。性能数值是目标，不是现有测量结果。

## 8. 资源、养成与在线服务

- 兼容上游 `pet.json + spritesheet` 及其切帧行为；导入后先校验再复制到受管资源目录，不在笔记正文执行包内脚本。
- 校验文件数、总字节、图像宽高/总像素、帧数、元数据深度；建议初始包总量 20 MiB、单图 4096x4096、音频 5 MiB，固定 fixture 验证后再调整。
- ZIP 检查路径穿越、绝对路径、符号链接、解压炸弹和重名覆盖；支持普通本地文件导入不代表必须新增 ZIP 依赖。
- 下载经后端受限客户端执行：HTTPS、域名/重定向策略、超时、大小、内容类型；拒绝内网/回环地址跳转。目录和素材不当作可信 HTML。
- 在线图库使用明确配置的服务端点，不直接把上游域名带入产品默认联网行为。缓存与离线角色不依赖服务可用性。
- 保留本地 XP/成就规则，但结算必须按实际可信完成事件；token 未知不是 0，也不能按文字长度推算真实用量。不得自动读取其他 CLI 的登录文件来展示订阅额度。
- 外部 hooks 为后续用户主动开启功能：安装前展示具体配置差异，保留备份，卸载只撤回本工具写入部分。不得把未签认的 socket 消息作为 ACP 授权或真实完成事实。
- 外部监控桥若需要 socket，仅监听本机、验证用户/来源、限制大小和速率；外部来源与宿主任务分别标注。不得开放局域网控制端口。
- 休息提醒、云同步和排行榜各自可关闭。网络身份、服务条款、素材许可和数据流未确认前，只交付本地模式，不运行上游云部署脚本。

## 9. 目标文件树与解耦

按任务增量创建，禁止先生成所有空文件。下列为目标结构，不表示当前已存在；同目录测试省略重复条目。

```text
references/desktop-pet/                  # 已克隆，只读，忽略且不打包
third-party/desktop-pet/LICENSE           # 正式复制代码时添加原许可
docs/architecture/desktop-pet-port-ledger.md # 主代理维护来源与差异
apps/desktop/
├── desktop-pet.html                     # 轻量独立入口，构建接线由集成者处理
├── src/
│   ├── app/
│   │   ├── desktop-pet-entry.ts          # 桌宠入口，不启动编辑器
│   │   └── desktop-pet-composition.ts    # 注入依赖、任务路由、设置定位
│   ├── features/desktop-pet/
│   │   ├── index.ts                     # 明确公共入口
│   │   ├── components/
│   │   │   ├── DesktopPetRoot.vue
│   │   │   ├── PetSprite.vue
│   │   │   ├── PetBubble.vue
│   │   │   ├── PetTaskList.vue
│   │   │   ├── PetContextMenu.vue
│   │   │   ├── PetFloatingBall.vue
│   │   │   └── PetCarePanel.vue
│   │   ├── rendering/
│   │   │   ├── sprite-slicer.ts
│   │   │   ├── sprite-player.ts
│   │   │   ├── sprite-hit-test.ts
│   │   │   └── animation-bindings.ts
│   │   ├── motion/
│   │   │   ├── pet-motion.ts
│   │   │   └── pet-physics.ts
│   │   ├── services/
│   │   │   ├── pet-task-view.ts          # 快照到展示，不决定通知投递
│   │   │   ├── pet-bubble-layout.ts
│   │   │   ├── pet-message-template.ts
│   │   │   ├── pet-care-rules.ts
│   │   │   └── pet-library-policy.ts
│   │   ├── stores/pet-session.ts         # usePetSessionStore，只保存视图状态
│   │   └── composables/use-pet-lifecycle.ts
│   ├── features/desktop-pet-settings/
│   │   ├── index.ts
│   │   ├── components/
│   │   │   ├── DesktopPetSettings.vue    # 子导航与装配
│   │   │   ├── PetGeneralSettings.vue
│   │   │   ├── PetCharacterSettings.vue
│   │   │   ├── PetBubbleSettings.vue
│   │   │   ├── PetNotificationSettings.vue
│   │   │   ├── PetCareSettings.vue
│   │   │   ├── PetProjectSettings.vue
│   │   │   ├── PetIntegrationSettings.vue
│   │   │   └── PetSettingsPreview.vue
│   │   ├── services/pet-settings-policy.ts
│   │   └── composables/use-pet-settings.ts
│   ├── platform/gateways/
│   │   ├── pet-contracts.ts             # 中立模型；增长时按事件/配置/资源拆
│   │   ├── tauri-pet.ts
│   │   └── memory-pet.ts
│   └── i18n/namespaces/desktop-pet.ts
├── src-tauri/
│   ├── capabilities/desktop-pet.json
│   ├── src/commands/desktop_pet.rs       # 校验调用窗口与请求，委派服务
│   ├── src/desktop_pet/
│   │   ├── mod.rs
│   │   ├── window_host.rs               # 窗口数量、label、生命周期
│   │   ├── linux_capabilities.rs         # 已验证能力与降级
│   │   ├── task_projection.rs           # 宿主可信任务到最小快照
│   │   ├── notification_policy.rs       # 去重、合并、勿扰和未读
│   │   ├── notification_delivery.rs     # 原生投递，注入接口
│   │   ├── settings.rs                  # schema、revision、原子写入
│   │   ├── resources.rs                 # 导入、校验、受管缓存
│   │   ├── history.rs                   # 有限任务索引，不存聊天全文
│   │   └── care_ledger.rs               # 奖励结算幂等账本
│   └── tests/
│       ├── desktop_pet_ipc_test.rs
│       ├── desktop_pet_notification_test.rs
│       ├── desktop_pet_settings_test.rs
│       ├── desktop_pet_resources_test.rs
│       └── desktop_pet_care_test.rs
└── e2e/
    ├── desktop-pet-settings.spec.ts
    └── desktop-pet-tasks.spec.ts
```

业务层不 import Tauri；平台层不 import Vue feature；Rust 决定可信状态/一次性副作用，TypeScript 只做可测试的展示和养成规则计算。规则计算结果提交后仍由后端校验来源、任务归属与幂等；不能让任意窗口提交 XP。可改为后端执行规则，但不得前后端维护两份规则真相。

`sprite-slicer` 是本来已有算法的移植，不必重写动画引擎。`bubble.ts/settings.ts/lib.rs` 的大文件必须在迁入时分拆，不能先复制超长文件再承诺以后整理。复杂取消、窗口恢复、通知去重和数据迁移旁写原因注释；复制的算法保留来源说明。

## 10. 任务拆分、接线与回退

缩写：`S=apps/desktop/src`，`R=apps/desktop/src-tauri`，`E=apps/desktop/e2e`。分配时将花括号、目录和“及测试”展开成精确文件白名单。下面是行为任务，不授权一次改整个 feature；共享文件只由指定集成者串行处理。

| 编号 | 行为与文件范围 | 验收/测试组 | 回退风险 |
| --- | --- | --- | --- |
| D0 | 主代理维护移植记录/许可；清点固定提交设置与依赖；不改业务 | 来源可追溯，功能映射无遗漏；素材许可单列 | 低；未批准依赖不改锁文件 |
| D1 | `S/platform/gateways/{pet-contracts,memory-pet}.ts` 及测试 | 纯内存可演示全部状态、设置冲突和能力降级；V1 | 低，先冻结跨层契约 |
| D2 | `S/features/desktop-pet/rendering/*.ts`、`components/PetSprite.vue` 及相应测试 | 复用切帧行为、空帧/损坏图/命中/销毁；V2 | 中，角色资源表现 |
| D3 | `R/src/desktop_pet/{mod,window_host,linux_capabilities}.rs`；`S/app/desktop-pet-entry.ts`、`desktop-pet.html`、Root/lifecycle | 仅一轻量入口，关闭/重开无泄漏；R1/E2 与原生矩阵 | 高，窗口/生命周期 |
| D4 | `R/src/desktop_pet/task_projection.rs`；`S/features/desktop-pet/services/pet-task-view.ts` 及测试 | 同名会话、多任务、旧实例事件隔离；V3/R2 | 高，任务归属 |
| D5 | `R/src/desktop_pet/{notification_policy,notification_delivery,history}.rs` 与 notification 测试 | 完成/等待/失败、去重、勿扰、恢复、投递失败；R2 | 高，重复或漏提示 |
| D6 | `R/src/desktop_pet/settings.rs` 与 settings 测试；`S/features/desktop-pet-settings/services/pet-settings-policy.ts`、composable 及测试 | schema/revision/原子失败/迁移/未知字段策略；R3/V4 | 高，配置丢失 |
| D7a | `DesktopPetSettings.vue`、`PetGeneralSettings.vue`、`PetNotificationSettings.vue`、`PetSettingsPreview.vue` 及测试 | 主开关/通知/预览真实生效、重开保留；V5/E1 | 中，设置集成 |
| D7b | `PetCharacterSettings.vue`、`PetBubbleSettings.vue` 及测试 | 原控件映射完整，尺寸/动画/词句保存与回显；V5/E1 | 中，控件较多需按页提交 |
| D7c | `PetCareSettings.vue`、`PetProjectSettings.vue`、`PetIntegrationSettings.vue` 及测试 | 本地扩展入口保留；未验证网络能力明确不可用；V5/E1 | 中，避免假开关 |
| D8 | `R/src/desktop_pet/resources.rs` 与 resources 测试；`S/features/desktop-pet/services/pet-library-policy.ts` 及测试 | 导入/创建/删除/缓存事务、安全与离线；R4/V6 | 高，文件和网络 |
| D9 | `PetBubble.vue/PetTaskList.vue/PetContextMenu.vue`、bubble/layout/template 服务及测试 | 多任务、长中文、纯文本、点击准确路由；V3/V7/E2 | 中，信息和导航 |
| D10 | `R/src/desktop_pet/care_ledger.rs` 与 care 测试；`pet-care-rules.ts`、`PetCarePanel.vue` 及测试 | 幂等奖励、日期/时区、无 token、导入回退；R5/V8 | 中，本地进度 |
| D11a | `motion/pet-motion.ts`、`pet-physics.ts` 及测试 | 漫游/拖动中断/坐标缩放/不支持模式回退；V9 | 中，Linux 能力 |
| D11b | `PetFloatingBall.vue`、项目角色的独立服务/测试 | 按 D1 契约冻结后补精确文件；上限、收回、绑定不影响其他库；V9/E2 | 中，多窗口消耗 |
| D12 | 集成者负责第 10.1 节共享装配点、`tauri-pet.ts`、`commands/desktop_pet.rs` 及测试 | 真实 IPC 限权、设置定位、构建多入口、主界面不回归；R1/V10 | 高，共享代码 |
| D13 | `E/desktop-pet-{settings,tasks}.spec.ts`、对应 perf fixture 与审计结果 | Linux 原生/安装包/性能门禁，全部差异有记录 | 中，不能以浏览器代替原生 |

D11b 所需的新服务文件由主代理在 D1 契约冻结后写入该任务白名单；在此之前不得分派实现。F 组云端/hooks 各自另立子计划，明确端点与配置权限后再执行，不隐含授权全站搬运或上游服务部署。

### 10.1 共享装配点

- `S/features/settings/types.ts`：增加 `desktop-pet` section，子页独立类型，不把所有子页铺到全局侧栏。
- `S/features/settings/components/{SettingsPanel,SettingsNavigation}.vue`、`features/settings/index.ts`：导入公开入口并传递合法初始定位；焦点切换沿用现有规则。
- `S/app/{AppShell.vue,app-dialogs.ts,app-lifecycle.ts,app-bootstrap.ts}`：先读现状，再由集成者最小接线；桌宠不重写未保存确认或退出流程。
- `S/app/desktop-pet-composition.ts`：只装配 gateway、任务导航、设置入口；使用 `features/desktop-pet/index.ts` 的公开接口。
- `S/i18n/index.ts` 及当前命名空间注册入口：按实际现有结构添加桌宠文案，不复制整份上游 i18n 字典。
- `apps/desktop/vite.config.ts`、`R/tauri.conf.json`、`R/src/{lib.rs,commands/mod.rs}`、`R/capabilities/desktop-pet.json`：多入口、注册、权限按需增量修改。
- `R/Cargo.toml`、前端 package 清单和锁文件：仅在依赖评审批准后由集成者修改。上游 Electron/Swift/Win32 依赖不得引入。

### 10.2 顺序与每任务步骤

顺序：`D0 -> D1 -> D2/D3/D6 -> D4/D5 -> D7a/D7b/D8/D9 -> D10/D11/D7c -> D12 -> D13`。D12 的最小接线可随前面任务分批提交，但共享文件始终单人所有；先闭环 A/B/C，再完成 D/E，不把所有功能塞进一次大合并。

每个任务必须执行：

- [ ] 读取固定上游符号、本项目契约和 `git status --short`，记录用户/其他代理变更。
- [ ] 给一个行为写失败测试；先运行，确认因缺失行为失败而不是环境/导入错误；同时列明相关上游行为差异。
- [ ] 复制获准代码到目标模块并保留来源；只改框架接线/平台边界和明确缺陷，不无理由重写算法。
- [ ] 注入时钟、随机、窗口、资源、网络、存储与通知依赖；补取消/并发/失败/旧状态用例。
- [ ] 运行最小测试，确认非零用例，再运行类型/lint；集成阶段跑全测与构建。
- [ ] 检查行数、来源声明、主题、无越权 IPC、无遗留监听；主代理更新移植记录和验收状态。
- [ ] 提交前复核 diff；只有用户授权 Git 提交才执行小型 `feat:`/`test:`/`fix:` 等提交，不提交参考 clone 或测试凭据。

回退通过关闭桌宠功能开关和移除装配引用，不影响 Agent 工作、笔记保存或原设置页。已导入的角色/养成保留，不用删除数据实现回退。schema 升级需保留备份；遇到新版本数据，旧程序只读/报错，禁止按默认值覆盖。

## 11. 测试命令与具体用例

以下文件需由对应任务创建；命令不是本次已通过的结果。现有测试脚本允许无测试通过，因此定向测试要求输出实际用例数，不能只有 exit 0。

```bash
# V1 契约和内存 gateway
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/platform/gateways/memory-pet.test.ts --passWithNoTests=false
# V2 切帧/动画/命中
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/desktop-pet/rendering --passWithNoTests=false
# V3 任务投影
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/desktop-pet/services/pet-task-view.test.ts --passWithNoTests=false
# V4 设置策略
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/desktop-pet-settings/services/pet-settings-policy.test.ts --passWithNoTests=false
# V5 设置组件
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/desktop-pet-settings/components --passWithNoTests=false
# V6 角色库策略
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/desktop-pet/services/pet-library-policy.test.ts --passWithNoTests=false
# V7 气泡和菜单
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/desktop-pet/components --passWithNoTests=false
# V8 养成
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/desktop-pet/services/pet-care-rules.test.ts --passWithNoTests=false
# V9 运动
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/features/desktop-pet/motion --passWithNoTests=false
# V10 真实 gateway 参数和卸载
npx --yes pnpm --filter @nekowite/desktop exec vitest run src/platform/gateways/tauri-pet.test.ts --passWithNoTests=false
# R1-R5
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test desktop_pet_ipc_test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test desktop_pet_notification_test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test desktop_pet_settings_test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test desktop_pet_resources_test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test desktop_pet_care_test
# E1-E2
npx --yes pnpm --filter @nekowite/desktop e2e e2e/desktop-pet-settings.spec.ts
npx --yes pnpm --filter @nekowite/desktop e2e e2e/desktop-pet-tasks.spec.ts
```

| 行为域 | 必须覆盖的回归案例 |
| --- | --- |
| 动画 | 稀疏精灵表、全透明图、非法尺寸/映射、切角色加载竞争、卸载后无帧回调、DPR 命中一致 |
| 设置 | 保存失败/磁盘满、最后一次滑动未落盘、旧版本迁移、两窗口同时更新、重复打开不多订阅、预览不发真实通知 |
| 任务 | 两 Agent 同 sessionId、旧 epoch、runId 复用拒绝、取消后迟到完成、受限结束不算成功、长时间无事件不丢任务 |
| 权限 | 桌宠窗口伪造授权/文件写入 IPC 被拒、待授权状态不会被另一个工作任务永久遮住、过期请求按钮不能继续操作 |
| 提醒 | 一次完成多窗口只投递一次、重放去重、勿扰解除不补弹、隐藏仍有未读、投递失败不丢记录、崩溃空窗边界 |
| 资源 | 路径穿越、符号链接、重定向到本机、超大解码/压缩包、包中脚本、下载取消、删除正在展示资源、断网用缓存 |
| 养成 | 重复事件零重复奖励、跨午夜/时区变化、缺失 token、被取消任务、预览数据隔离、导入回退不破坏已有进度 |
| 多角色 | 数量超限后端拒绝、主角色关闭不关任务、全收回、库改名/关闭、其他窗口无共享可变本地状态污染 |
| 导航 | 已隐藏主窗口、不同库、未保存笔记拒绝切换、已删除会话、通知动作过期、设置子页恢复和键盘焦点 |

安全测试必须穿过真实 IPC 授权入口，而不是只测内部函数。原生测试使用仓库内隔离数据根和假通知接收器，不写开发者真实 profile，不调用未授权模型。

## 12. 发布与性能门禁

```bash
npx --yes pnpm typecheck
npx --yes pnpm lint
npx --yes pnpm test
npx --yes pnpm build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
git diff --check
```

- Linux AppImage/deb/rpm 均验证安装、主界面、独立桌宠入口、资源定位、透明窗口、禁用/恢复和退出清理；前端 build 通过不代表包可运行。
- GNOME/KDE 与 Wayland/X11 记录实测矩阵、版本和能力降级；环境不可得标未验证，不使用“跨平台”宣传替代证据。
- Playwright 检查设置页 1280x820、860x560、深浅主题、长中文/路径、125%/150% 缩放与 reduced-motion；桌宠检查不同角色大小、气泡不越屏、菜单无重叠。
- Canvas 验证非空透明像素、正确切帧、不同状态截图及播放前后像素变化；浏览器截图不能证明原生置顶/穿透/焦点正确，须另做真实 Tauri 验证。
- 单角色/上限多角色分别记录空闲、连续事件、图库滚动、编辑器输入的 CPU/RSS/帧时延；连续开关 50 次后监听、窗口和计时器计数回基线。
- 禁用后无角色渲染定时器、无后台图库轮询；养成/任务记录只保留必要后端逻辑，不挂载隐藏完整编辑器。
- 发行包检查不含 `references/desktop-pet/`、上游 `.git`、云服务源码、Win32 依赖、原作者更新端点、私人凭据或无许可素材。
- 发布清单包含移植来源/版本/许可、功能差异、已验证 Linux 环境、默认联网行为与隐私说明。

## 13. 子代理协作与完成定义

```text
你负责本计划中一个明确编号的 Linux 桌宠移植任务。
主代理必须提供精确文件白名单、固定上游路径/符号、输入输出契约、验收用例和测试命令。
references/desktop-pet/ 为只读来源；AGENTS.md、路线图、specs、plans、移植记录禁止修改。
优先复用上游行为，不自行删减功能；遇到平台差异、许可证或安全缺口先报告。
不得整体复制 package/lock/Tauri Builder，不修改真实用户配置，不自动连接上游云服务。
与其他 Agent 共享文件仅由集成者接线；发现契约变化不得自行越界补丁。
先写失败测试，再小范围移植与适配；业务文件遵守 300/400/500 行规则。
报告：来源符号、改动文件、保留/改变行为、测试命令和退出码、未验证 Linux 能力、回退风险。
不得自行 Git 提交、覆盖用户变更、执行清理或改写受保护文档。
```

里程碑：

1. M0：固定源码/许可/设置映射完成，能力缺口明确，依赖批准。
2. M1：单角色 + 真实任务闭环 + 设置统一入口；成功/失败/待授权提醒可靠。
3. M2：主要本地设置、资源导入、气泡与声音完整迁入，断网可用。
4. M3：养成、多角色、项目绑定、可用漫游与历史；与上游差异逐项记录。
5. M4：Linux 三种包、性能/安全/回归报告；在线和外部监控功能单独出具可用性报告。

最终验收不能只看桌宠能显示：任务结束能正确提醒并定位，设置只在 NekoWite 内维护，多个 Agent 不串任务，用户笔记不受影响，主要上游本地功能有实测映射，Windows 专用实现未引入，未完成项没有伪装为可用。

## 14. 资料与本次验证边界

- [上游仓库](https://github.com/Imzl-zl/desktop-pet)、[固定源码树](https://github.com/Imzl-zl/desktop-pet/tree/be171a01273a1ed92a27bcdf72f8a58768bac421)。
- [固定版本 README](https://github.com/Imzl-zl/desktop-pet/blob/be171a01273a1ed92a27bcdf72f8a58768bac421/README.md)、[MIT 许可](https://github.com/Imzl-zl/desktop-pet/blob/be171a01273a1ed92a27bcdf72f8a58768bac421/LICENSE)。
- [ACP 集成总计划](2026-09-16-opencode-acp-integration.md)。

本次实际执行仅为克隆、只读源码检查、文档和参考目录忽略规则更新。未安装上游依赖、未运行上游应用、未复制业务实现、未运行产品测试或修改现有业务/锁文件。上面的测试和性能指标是后续开发门禁，不是已通过结果。
