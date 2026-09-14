/** Version history and the difference viewer it opens. */
export const history = {
  en: {
    history: {
      title: 'History',
      refreshTitle: 'Refresh history',
      refresh: 'Refresh',
      restore: 'Restore',
      empty: 'No history yet',
      openDoc: 'Open a document to see history',
      readFailed: 'Failed to read history: {msg}',
      unreadable: 'History could not be read; some versions may be missing',
      compare: 'Compare',
      compareFailed: 'Failed to read history content',
      readHistoryFailed: 'Failed to read history content',
    },

    diff: {
      title: 'Version diff',
      close: 'Close diff',
      currentLabel: 'Current',
      historyLabel: 'History',
      unchangedCount: '{n} unchanged',
      restore: 'Restore this version',
      restoreTitle: 'Replace current content with this historical version',
      identical: 'This version matches the current content, no differences',
      addLabel: 'Added',
      delLabel: 'Removed',
    },
  },
  zh: {
    history: {
      title: '历史版本',
      refreshTitle: '刷新历史版本',
      refresh: '刷新',
      restore: '恢复',
      empty: '暂无历史版本',
      openDoc: '打开文档以查看历史版本',
      readFailed: '无法读取历史版本：{msg}',
      unreadable: '无法读取历史版本，部分版本可能未被列出',
      compare: '对比当前',
      compareFailed: '无法读取历史版本内容',
      readHistoryFailed: '无法读取历史版本内容',
    },

    diff: {
      title: '版本对比',
      close: '关闭对比',
      currentLabel: '当前',
      historyLabel: '历史版本',
      unchangedCount: '相同 {n} 行',
      restore: '恢复此版本',
      restoreTitle: '用当前版本替换为该历史版本',
      identical: '该版本与当前内容一致，无差异',
      addLabel: '新增',
      delLabel: '删除',
    },
  },
}
