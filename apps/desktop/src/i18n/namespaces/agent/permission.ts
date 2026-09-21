/** The permission prompt’s own copy. */
export const permission = {
  en: {
    permission: {
      argumentsPending: 'The engine has not sent the arguments yet',
      argumentsUnreadable: 'The engine sent arguments this app could not read',
      expired: 'No longer waiting — this request has already been resolved',
      /* ACP temporary grants and the engine's saved-rule API are different stores.
         Consent must not promise that the settings list can revoke both. */
      lastingGrant: '“Always allow” can suppress later prompts, including in other sessions. Its lifetime depends on the engine. Settings → {section} → {page} → “{surface}” lists saved rules only: bundled OpenCode ACP keeps temporary grants in memory that this list cannot revoke. Choose “Allow once” for limited approval.',
    },
  },
  zh: {
    permission: {
      argumentsPending: '引擎还没有发送参数',
      argumentsUnreadable: '引擎发送了本应用无法读取的参数',
      expired: '已不再等待——该请求已被处理',
      lastingGrant: '「始终允许」可能让后续操作不再询问，包括其他会话中的操作；有效期由引擎决定。「设置 → {section} → {page} → {surface}」只列出持久化规则，内置 OpenCode ACP 的内存临时授权无法在那里撤销。仅批准本次操作请选择「允许一次」。',
    },
  },
} as const
