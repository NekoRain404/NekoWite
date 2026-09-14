/**
 * Cross-cutting atoms shared by every surface — generic actions, the error vocabulary, and
 * relative timestamps.
 */
export const common = {
  en: {
    common: {
      settings: 'Settings',
      close: 'Close',
      browse: 'Browse…',
      save: 'Save',
      saveAndSwitch: 'Save & Switch',
      cancel: 'Cancel',
      confirm: 'Confirm',
      delete: 'Delete',
      rename: 'Rename',
      search: 'Search',
      openFolder: 'Open Folder',
    },

    error: {
      exportOutsideVault: 'Please choose a path inside the vault to export',
      exportFailed: 'Export failed: {msg}',
      aiGenFailed: 'AI generation failed: {msg}',
    },

    time: {
      justNow: 'Just now',
      minutesAgo: '{n} min ago',
      hoursAgo: '{n} h ago',
      daysAgo: '{n} d ago',
      unknown: 'Unknown time',
    },
  },
  zh: {
    common: {
      settings: '设置',
      close: '关闭',
      browse: '浏览…',
      save: '保存',
      saveAndSwitch: '保存并切换',
      cancel: '取消',
      confirm: '确认',
      delete: '删除',
      rename: '重命名',
      search: '搜索',
      openFolder: '打开文件夹',
    },

    error: {
      exportOutsideVault: '请选择 vault 内的路径导出',
      exportFailed: '导出失败：{msg}',
      aiGenFailed: 'AI 生成失败：{msg}',
    },

    time: {
      justNow: '刚刚',
      minutesAgo: '{n} 分钟前',
      hoursAgo: '{n} 小时前',
      daysAgo: '{n} 天前',
      unknown: '未知时间',
    },
  },
}
