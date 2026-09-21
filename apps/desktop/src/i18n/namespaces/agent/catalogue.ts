/** The catalogue page: engines this app could install or upgrade. */
export const catalogue = {
  en: {
    /* The ACP catalogue: what the public registry publishes, and the one thing this app does about
       it. Two rules run through every sentence here.

       **A listing is not a measurement.** What an engine can do is established by a handshake and
       a session negotiation, and a catalogue entry describes a program nobody has run — so no
       sentence here offers a feature, a capability or a slash command, and `unverified` says why.

       **Nothing is offered that cannot be done.** The registry publishes three distribution kinds
       and this app acts on one: a package manager's invocation, where the *manager* owns the
       artifact's provenance. The other two would make NekoWite the downloader, and §3.3's digest
       check has no anchor for an entry that arrives over a network (§3.3: 不能从同一不可信响应同时获取
       二进制和摘要便声称可信). So the archive arms state the reason and draw no control — the failure
       「不能让按钮看起来可用、点击后才发现不支持」. `gates.untransferable` carries which checks those are. */
    catalogue: {
      section: {
        title: 'Available agents',
        hint: 'Engines published in the Agent Client Protocol registry. This app reads the listing; it does not install anything from it.',
      },
      list: {
        loading: 'Reading the registry...',
        unreadable: 'The catalogue could not be read.',
        retry: 'Try again',
        empty: 'The registry listed no agents.',
        version: 'Listing v{version}',
      },
      freshness: {
        current: 'Read from the registry just now.',
        stale: 'This listing is out of date: {detail}',
        unavailable: 'The registry could not be reached: {detail}',
      },
      standing: {
        viaManager: 'Runs through {manager}. The package manager fetches and verifies it — this app does not, and records the result as your own installation.',
        archiveOnly: 'Only published as a download for {platform}. Using it would make NekoWite the downloader, which this app does not do: {reason}',
        unsupported: 'Published for {published} only, and not for this machine.',
        unrecognised: 'Published as {kinds}, which this app cannot read.',
      },
      /* What the registry never says, drawn on every row whatever its standing is. The rule is
         §3.4's capability row: only a handshake and a session negotiation establish these. */
      unverified: 'What this engine can do is not known from the registry. Features, slash commands and configuration are established by talking to it, after it is registered and started.',
      gates: {
        title: 'Why there is no install button',
        hint: 'Installing a third-party binary is a supply-chain decision. §3.3 requires a download to pass these checks first, and these are the ones a registry entry cannot support: {checks}',
      },
      action: {
        use: 'Use this program',
        used: 'Added {agentId}. Start it from the registry list above.',
      },
      defects: {
        title: 'This entry cannot be used',
      },
      license: 'Licence: {license}',
      licenseLink: 'Read the terms',
      repository: 'Source',
      website: 'Website',
    },
  },
  zh: {
    /* ACP 目录：公开注册表发布了什么，以及本应用对此做的唯一一件事。这里每一句话都受两条规则约束。

       **列表不是实测。** 引擎能做什么由握手与会话协商确定，而目录条目描述的是一个谁都没运行过的程序
       ——所以这里没有一句话提供功能、能力或斜杠命令，`unverified` 说明了原因。

       **做不到的事不提供。** 注册表发布三种分发方式，本应用只对其中一种采取行动：包管理器的调用，
       其产物的来源由**包管理器**负责。另外两种会让 NekoWite 变成下载方，而 §3.3 的摘要校验对一份来自
       网络的条目没有锚点（§3.3：不能从同一不可信响应同时获取二进制和摘要便声称可信）。因此归档类条目
       说明理由、不画任何控件——正是「不能让按钮看起来可用、点击后才发现不支持」所指的失败。
       `gates.untransferable` 承载的是这些校验里无法落地的那几个。 */
    catalogue: {
      section: {
        title: '可用的智能体',
        hint: '发布在 Agent Client Protocol 注册表中的引擎。本应用只读取这份列表，不从中安装任何东西。',
      },
      list: {
        loading: '正在读取注册表…',
        unreadable: '无法读取目录。',
        retry: '重试',
        empty: '注册表中没有列出任何智能体。',
        version: '列表 v{version}',
      },
      freshness: {
        current: '刚从此注册表读取。',
        stale: '这份列表已过期：{detail}',
        unavailable: '无法访问注册表：{detail}',
      },
      standing: {
        viaManager: '通过 {manager} 运行。由包管理器获取并校验——本应用不做这件事，并把结果记录为「你自己的安装」。',
        archiveOnly: '只发布了面向 {platform} 的下载包。使用它会让 NekoWite 成为下载方，而本应用不做这件事：{reason}',
        unsupported: '只发布了 {published} 的版本，没有本机的。',
        unrecognised: '以 {kinds} 形式发布，本应用无法识别。',
      },
      /* 注册表从不会说的东西，无论某行状态如何都会画出来。规则来自 §3.4 的能力行：只有握手与
         会话协商才能确定这些。 */
      unverified: '注册表无法说明这个引擎能做什么。功能、斜杠命令与配置，都要在它注册并启动之后、通过和它对话才能确定。',
      gates: {
        title: '为什么没有安装按钮',
        hint: '安装第三方二进制是一个供应链决策。§3.3 要求一次下载先通过这些校验，而以下是注册表条目无法支持的校验：{checks}',
      },
      action: {
        use: '使用这个程序',
        used: '已添加 {agentId}。请在上面的注册表列表中启动它。',
      },
      defects: {
        title: '此条目无法使用',
      },
      license: '许可证：{license}',
      licenseLink: '阅读条款',
      repository: '源码',
      website: '网站',
    },
  },
} as const
