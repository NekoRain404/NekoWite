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
    },
  },
} as const
