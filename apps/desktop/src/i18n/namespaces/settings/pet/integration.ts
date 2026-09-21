/** The advanced page: what is not offered, and what this machine was verified to do. */
export const integration = {
  en: {
    integration: {
      note: 'What this machine was verified to do, and what this build does not offer.',
      capabilities: {
        title: 'What this machine can do',
        note: 'Each line is what the host reported for one capability. Where a capability cannot be used, what happens instead is stated beside it - a control that saved a setting no code reads would leave you believing the pet does something it does not.',
        noReport: 'The host has reported nothing about this machine yet, so there is no claim to show for any capability. An empty list would have read as "none of these work", which is a different claim.',
        fallback: 'instead: {fallback} - {detail}',
      },
      onlineTitle: 'Online services and external integrations',
      systemTitle: 'The host and local data',
      notOfferedNote: 'None of these is drawn as a switch that is off: an off switch says the feature is there and merely switched off, and these are not in this build. Each line says what it would need.',
      rows: {
        'care-sync': {
          name: 'Sign in, restore, sync, leaderboard',
          reason: 'Not offered: off by default, and off until the service\'s source and its privacy terms are agreed. The original project\'s login identity is never borrowed.',
        },
        'external-monitor': {
          name: 'External agent monitoring (hooks, local bridge)',
          reason: 'Not offered: switching this on is the user\'s decision, with the exact configuration shown and backed up first, and nothing here writes to another tool\'s files.',
        },
        update: {
          name: 'The pet updates itself',
          reason: 'Not offered: updates go through the app\'s own flow. A second updater was rejected, not deferred.',
        },
        autostart: {
          name: 'Starts with the system',
          reason: 'Not offered: the app registers one startup entry or none. A pet that registered its own would be the second one.',
        },
        process: {
          name: 'Quit or restart the app from the pet',
          reason: 'Not offered: exiting stays the main window\'s decision, so the pet has no path that could change it.',
        },
        'import-export': {
          name: 'Importing an existing DesktopPet configuration',
          reason: 'Not offered yet: the import reads a file you pick, shows the differences and keeps a backup before writing. Until that path exists, nothing here reads another install\'s data.',
        },
      },
    },
  },
  zh: {
    integration: {
      note: '本机已验证的能力，以及本版本不提供的功能。',
      capabilities: {
        title: '本机能力',
        note: '每一行是宿主对一项能力的上报。能力不可用时，旁边写明改用什么方式——一个能保存、却没有代码读取的设置，会让你以为桌宠做了它并没有做的事。',
        noReport: '宿主还没有上报任何关于本机能力的结论，所以这里对任何一项都没有说法。显示成空列表会被读成「这些全都不可用」，那是另一回事。',
        fallback: '改用：{fallback}——{detail}',
      },
      onlineTitle: '在线服务与外部集成',
      systemTitle: '宿主与本地数据',
      notOfferedNote: '这些都不会显示成关闭状态的开关：一个「关」的开关意味着功能已经存在、只是没开，而它们在本版本里并不存在。每一行写明了它需要什么。',
      rows: {
        'care-sync': {
          name: '登录、恢复、同步、排行榜',
          reason: '不提供：默认关闭，并且在服务来源与隐私条款确定之前一直关闭。不借用原项目的登录身份。',
        },
        'external-monitor': {
          name: '外部 Agent 监控（hooks、本机桥）',
          reason: '不提供：开启这件事要由用户决定，先看清具体配置差异并留好备份；这里不会写另一个工具的配置文件。',
        },
        update: {
          name: '桌宠自行更新',
          reason: '不提供：更新走应用自己的流程。第二个更新器是被否决的，不是推迟的。',
        },
        autostart: {
          name: '随系统启动',
          reason: '不提供：应用只注册一个开机启动项，或者一个都没有。桌宠自己注册就是第二个。',
        },
        process: {
          name: '从桌宠退出或重启应用',
          reason: '不提供：退出始终由主窗口决定，桌宠没有能改变它的路径。',
        },
        'import-export': {
          name: '导入已有的 DesktopPet 配置',
          reason: '尚未提供：导入只读你选中的文件，先展示差异、留好备份再写入。在这条路径存在之前，这里不会去读另一个安装的数据。',
        },
      },
    },
  },
} as const
