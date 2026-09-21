/** The fallback arms of PetFallback. */
export const capabilityFallback = {
  en: {
    capabilityFallback: {
      none: 'nothing is substituted',
      'docked-window': 'the pet lives inside the app window',
      'closable-window': 'a plain window you can close, with the limit stated',
      'clamped-position': 'the compositor moves the window, and it stays on a visible area',
      'compact-window': 'a small window that takes the clicks itself',
      'stay-only': 'the pet stays where it is',
      'unread-list': 'the unread list is what remains',
      'not-offered': 'the feature is absent rather than imitated',
    },
  },
  zh: {
    capabilityFallback: {
      none: '无需替代',
      'docked-window': '桌宠停在应用窗口内',
      'closable-window': '改用可关闭的普通窗口，并写明限制',
      'clamped-position': '由合成器移动窗口，并停在可见区域内',
      'compact-window': '改用一个小窗口自己接收点击',
      'stay-only': '桌宠停在原地',
      'unread-list': '保留未读列表',
      'not-offered': '不提供该功能，也不做假的替代',
    },
  },
} as const
