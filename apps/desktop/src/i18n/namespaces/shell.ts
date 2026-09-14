/**
 * The application shell: the empty-state welcome, window chrome, the resizable pane handles,
 * the info rail, toasts and the generic context menu.
 */
export const shell = {
  en: {
    app: {
      welcome: 'Welcome to NekoWite',
      welcomeHint: 'Choose a folder as your knowledge base. Supports Markdown, math and citations.',
      openFolder: 'Open Folder',
      defaultTitle: 'Start writing',
    },

    titlebar: {
      collapseSidebar: 'Collapse sidebar',
      expandSidebar: 'Expand sidebar',
      minimize: 'Minimize',
      maximize: 'Maximize',
      restore: 'Restore',
      close: 'Close',
    },

    rail: {
      bodyAria: 'Panels',
      ai: 'AI',
      outline: 'Outline',
      refs: 'References',
      history: 'History',
      meta: 'Props',
      close: 'Close',
      collapse: 'Collapse document info',
      expand: 'Document info (references / history)',
    },

    layout: {
      resizeSidebar: 'Adjust sidebar width',
      resizeNotelist: 'Adjust note list width',
      resizeRail: 'Adjust info rail width',
    },

    toast: {
      restore: 'Restore',
      dismiss: 'Dismiss',
    },

    contextMenu: {
      aria: 'Context menu',
      // The editing verbs the editor's own menu takes over from the webview's.
      cut: 'Cut',
      copy: 'Copy',
      selectAll: 'Select all',
    },
  },
  zh: {
    app: {
      welcome: '欢迎使用 NekoWite',
      welcomeHint: '选择一个文件夹作为你的知识库，支持 Markdown、数学公式与文献引用。',
      openFolder: '打开文件夹',
      defaultTitle: '开始写作',
    },

    titlebar: {
      collapseSidebar: '收起侧栏',
      expandSidebar: '展开侧栏',
      minimize: '最小化',
      maximize: '最大化',
      restore: '还原',
      close: '关闭',
    },

    rail: {
      bodyAria: '侧栏面板',
      ai: 'AI',
      outline: '大纲',
      refs: '引用',
      history: '历史',
      meta: '属性',
      close: '关闭',
      collapse: '收起文档信息',
      expand: '文档信息（引用 / 历史）',
    },

    layout: {
      resizeSidebar: '调整侧栏宽度',
      resizeNotelist: '调整笔记列表宽度',
      resizeRail: '调整文档信息栏宽度',
    },

    toast: {
      restore: '恢复',
      dismiss: '忽略',
    },

    contextMenu: {
      aria: '上下文菜单',
      cut: '剪切',
      copy: '复制',
      selectAll: '全选',
    },
  },
}
