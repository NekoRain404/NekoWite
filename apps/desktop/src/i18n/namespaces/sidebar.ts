/** The left navigation rail: its sections, the trash view, and the note-creation entries. */
export const sidebar = {
  en: {
    nav: {
      folders: 'Folders',
      all: 'All notes',
      recent: 'Recent',
      favorites: 'Favorites',
      uncategorized: 'Uncategorized',
      graph: 'Graph',
      attachments: 'Attachments',
      index: 'Index',
      cloud: 'Sync',
      tags: 'Tags',
      references: 'References',
      trash: 'Trash',
      searchRefs: 'Search key / title / author / year',
      insertRef: 'Insert citation [@{key}]',
      refEmpty: 'Drop .bib / .ris / .json(CSL) files into the vault root',
      restore: 'Restore',
      trashEmpty: 'Trash is empty',
      trashUnreadable: 'Could not read the trash (it may not be empty)',
      openOther: 'Open another folder',
      switchLight: 'Switch to light',
      switchDark: 'Switch to dark',
      settings: 'Settings',
      restoreFailed: 'Restore failed, please retry',
      noteCount: '{n} notes',
    },

    trash: {
      clear: 'Empty trash',
      clearConfirm: 'Confirm empty',
      clearFailed: 'Failed to empty trash, please retry',
      clearPartial: 'Emptied {removed} item(s); {failed} could not be deleted: {names}',
      cleared: 'Emptied {n} items',
    },

    daily: {
      new: 'New daily note',
      createFailed: 'Failed to create the daily note, please retry',
    },

    template: {
      pickTitle: 'New from template',
      builtin: 'Built-in template',
      empty: 'No templates available. Built-in templates are always available.',
      createFailed: 'Failed to create a note from the template, please retry',
      nameTaken:
        'Could not create the note: all {count} candidate names (including "{base}") are taken. Rename or delete the existing notes first.',
      readFailed: 'Failed to read the template, please retry',
    },
  },
  zh: {
    nav: {
      folders: '文件夹',
      all: '全部笔记',
      recent: '最近',
      favorites: '收藏',
      uncategorized: '未分类',
      graph: '图谱',
      attachments: '附件',
      index: '索引',
      cloud: '云同步',
      tags: '标签',
      references: '引用文献',
      trash: '回收站',
      searchRefs: '搜索 key / 标题 / 作者 / 年份',
      insertRef: '插入引用 [@{key}]',
      refEmpty: '将 .bib / .ris / .json(CSL) 文件放入 vault 根目录',
      restore: '恢复',
      trashEmpty: '回收站是空的',
      trashUnreadable: '无法读取回收站（其中可能仍有内容）',
      openOther: '打开其他文件夹',
      switchLight: '切换到浅色',
      switchDark: '切换到深色',
      settings: '设置',
      restoreFailed: '恢复失败，请重试',
      noteCount: '{n} 篇笔记',
    },

    trash: {
      clear: '清空回收站',
      clearConfirm: '确认清空',
      clearFailed: '清空回收站失败，请重试',
      clearPartial: '已清空 {removed} 项；{failed} 项无法删除：{names}',
      cleared: '已清空 {n} 项',
    },

    daily: {
      new: '新建每日笔记',
      createFailed: '创建每日笔记失败，请重试',
    },

    template: {
      pickTitle: '从模板新建',
      builtin: '内置模板',
      empty: '暂无可选模板，内置模板始终可用。',
      createFailed: '从模板创建笔记失败，请重试',
      nameTaken: '无法创建笔记：{count} 个候选文件名（含 {base}）都已被占用，请先重命名或删除同名笔记',
      readFailed: '读取模板失败，请重试',
    },
  },
}
