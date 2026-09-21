# Linux Beta 试用与验收

## 当前结论

维护者已确认本轮用于本地试用，不执行公开发行或系统级安装。
本机 AppImage 最终复验退出 0，真实新建、编辑、保存、关闭重开及进程重启读回通过；
证据：`test-results/native-beta-smoke/run-72OCrN/`。
本轮本地 Beta 交付完成；下方发行兼容性与 AI 授权限制仍保留，不视为已经修复。

2026-09-20：当前源码已生成本地 Linux Beta 候选包，基本编辑路径通过自动化验证。
这不是全平台兼容或公开发行合规完成声明。包内版本仍为 `1.0.0`，不要据此标记为正式版。

## 试用要求

- 仅 Linux x86_64；当前主程序要求 glibc 2.39 或更新版本。
- deb/rpm 依赖 WebKitGTK 4.1 与 GTK 3；其元数据尚未显式约束 glibc 最低版本。
- 不保证 Ubuntu 22.04 等旧发行版能运行；需要旧系统支持时，应在对应基线重建和验证。
- 首次试用使用笔记库副本，并保留独立备份。不要同时用旧程序和候选程序编辑同一库。
- 先完全退出旧实例，再启动新包，避免单实例机制把操作转交旧程序。

## 本地候选包

在仓库根目录运行：

```bash
./release/nekowite_1.0.0_amd64.AppImage
```

此外提供 `release/nekowite_1.0.0_amd64.deb` 和
`release/nekowite-1.0.0-1.x86_64.rpm`。本轮没有执行系统级安装。
便携程序 `release/nekowite_1.0.0_x64` 必须与 `release/opencode` 放在同一目录。
旧包保留于 `release/superseded/build.Gxa38B/`；不要将恢复旧包等同于恢复笔记数据。

## 已验证

- 根目录 typecheck、lint、测试和构建通过；5864 项单元测试，lint 有 462 条既有警告。
- 58 项基本交互测试通过，覆盖中文合成输入、源码保真、对照滚动、图片表格、
  搜索图谱以及新建、重命名、删除和恢复。此组测试模拟 IPC，不替代原生验证。
- 8 项严格保存浏览器测试通过，保存后关闭标签再打开。
- AI/桌宠交互组首次 70 项通过、1 项旧授权文案断言失败；将该断言改为验证
  持久规则与临时授权的区别后，失败项独立复验通过。未修改生产行为。
  覆盖任务取消、会话滚动、变更展示、设置、任务提示、尺寸和减少动画选项。
- 发布目录的原生程序及三个包的解包入口均通过真实键盘输入、磁盘保存、标签重开和进程重启读回。
- AppImage 原文件也通过上述原生流程，未设置 `APPIMAGE_EXTRACT_AND_RUN`。
- 三个包的内置引擎身份、ACP 握手、离线握手及 notices 文件检查通过。

## 仍需处理

- 公开分发前，维护者必须处理 `THIRD-PARTY-NOTICES.txt` 中 citeproc 的
  `UNRESOLVED` 许可证分支及记录的其他分发义务；自动化打包不会替维护者作此决定。
- ACP 的临时持续授权不等于设置中的持久授权记录；当前不能用该列表撤销临时授权。
  真实授权撤销测试曾失败，不能宣称此问题已解决。
- 未验证干净系统上的 deb/rpm 安装、升级、卸载，以及不同桌面/发行版和实体输入法组合。
- 当前包未声明最低 glibc 依赖，因此旧系统可能安装成功但启动失败。

## 证据与复验

- 全量日志：`test-results/beta-2026-09-20/`。
- 发布便携程序：`test-results/native-beta-smoke/run-nKOXkJ/`。
- deb/rpm/AppRun：分别为 `run-xQBRRR`、`run-gDfmln`、`run-WziO8h`。
- AppImage 原文件：`test-results/native-beta-smoke/run-40CiC1/`。
- 复验命令：

```bash
BIN="$PWD/release/nekowite_1.0.0_amd64.AppImage" node apps/desktop/e2e/native-beta-smoke.mjs
```

需要本机提供 `tauri-driver`、`WebKitWebDriver`、`xvfb-run` 和 `dbus-run-session`。
测试只使用仓库内独立配置与笔记目录，保留失败截图及日志。
