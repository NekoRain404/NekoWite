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
      cancel: 'Cancel',
      confirm: 'Confirm',
      delete: 'Delete',
      loading: 'Loading NekoWite…',
    },

    error: {
      exportOutsideVault: 'Please choose a path inside the vault to export',
      exportFailed: 'Export failed: {msg}',
      exportNoPrintDialog:
        'The system opened no print dialog — this webview did not start a print. Use “Export HTML” and print that to PDF from a browser instead.',
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
      cancel: '取消',
      confirm: '确认',
      delete: '删除',
      loading: 'NekoWite 正在加载…',
    },

    error: {
      exportOutsideVault: '请选择 vault 内的路径导出',
      exportFailed: '导出失败：{msg}',
      exportNoPrintDialog: '系统没有打开打印对话框——这个 WebView 没有开始打印。可以改用「导出 HTML」，再在浏览器里打印成 PDF。',
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
