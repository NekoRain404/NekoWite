/** The status words a capability can report. */
export const capabilityStatus = {
  en: {
    capabilityStatus: {
      available: 'verified on this machine',
      degraded: 'partly working',
      unavailable: 'not available',
      unverified: 'not verified yet',
    },
  },
  zh: {
    capabilityStatus: {
      available: '本机已验证',
      degraded: '部分可用',
      unavailable: '不可用',
      unverified: '尚未验证',
    },
  },
} as const
