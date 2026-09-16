/** The agent panel's command menu — the list the engine publishes for a session. */
export const agent = {
  en: {
    agent: {
      commandMenu: {
        aria: 'Command suggestions',
        waiting: 'Waiting for this session to publish its commands',
        empty: 'This session has no commands',
        noMatch: 'No command matches',
        unavailable: 'The command list could not be received',
      },
      permission: {
        argumentsPending: 'The engine has not sent the arguments yet',
        argumentsUnreadable: 'The engine sent arguments this app could not read',
        expired: 'No longer waiting — this request has already been resolved',
      },
    },
  },
  zh: {
    agent: {
      commandMenu: {
        aria: '命令建议',
        waiting: '正在等待本会话公布命令',
        empty: '本会话没有可用命令',
        noMatch: '没有匹配的命令',
        unavailable: '未能收到命令列表',
      },
      permission: {
        argumentsPending: '引擎还没有发送参数',
        argumentsUnreadable: '引擎发送了本应用无法读取的参数',
        expired: '已不再等待——该请求已被处理',
      },
    },
  },
} as const
