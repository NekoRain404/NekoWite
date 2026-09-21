/** The two sentences every settings page shares: where a value came from, and “try again”. */
export const origin = {
  en: {
    retry: 'Try again',
    origin: {
      host: 'Set by this app',
      engine: 'The engine’s own discovery',
      session: 'Published by the engine for this session',
    },
  },
  zh: {
    retry: '重试',
    origin: {
      host: '由本应用设置',
      engine: '引擎自己的发现规则',
      session: '由引擎为该会话发布',
    },
  },
} as const
