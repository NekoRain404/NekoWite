/** The capability vocabulary of PET_CAPABILITIES. */
export const capability = {
  en: {
    capability: {
      'window-transparency': 'Transparent window',
      'window-borderless': 'Borderless window',
      'always-on-top': 'Always on top',
      'no-focus-steal': 'Does not take focus',
      drag: 'Dragging the pet',
      'position-restore': 'Remembering its position',
      'pointer-passthrough': 'Clicking through the pet',
      'pointer-follow': 'Following the pointer',
      'window-climb': 'Climbing along window edges',
      'system-notification': 'System notifications',
      'notification-actions': 'Actions on a notification',
    },
  },
  zh: {
    capability: {
      'window-transparency': '透明窗口',
      'window-borderless': '无边框窗口',
      'always-on-top': '始终置顶',
      'no-focus-steal': '不抢焦点',
      drag: '拖动桌宠',
      'position-restore': '记住窗口位置',
      'pointer-passthrough': '鼠标穿透',
      'pointer-follow': '跟随指针',
      'window-climb': '沿窗口边缘攀爬',
      'system-notification': '系统通知',
      'notification-actions': '通知上的操作',
    },
  },
} as const
