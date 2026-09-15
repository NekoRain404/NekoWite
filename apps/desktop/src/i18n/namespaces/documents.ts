/**
 * Open documents: the tab strip, session restore, crash recovery and the external-change
 * conflict dialog.
 */
export const documents = {
  en: {
    conflict: {
      title: 'File changed externally',
      bodyPrefix: 'The file',
      bodySuffix: 'changed on disk, but your local edits here are not saved yet.',
      reloadDisk: 'Use disk (discard local)',
      keepLocal: 'Keep local',
      later: 'Later',
      note: 'Using the disk loads disk content and discards local edits; keeping local keeps the current content unsaved.',
    },

    tabs: {
      missingOnDisk: '{path} was moved or deleted outside the app. It has been detached from the note, your text is still here, and the next save will ask where to put it.',
      close: 'Close',
      closeOthers: 'Close others',
      closeAll: 'Close all',
      closeTab: 'Close tab',
      newDoc: 'New document',
      untitled: 'Untitled',
      saving: 'Saving…',
      dirty: 'Unsaved',
      saved: 'Saved',
      openVaultFirst: 'No vault is open; cannot read the file',
      readFileFailed: 'Could not read file: {path}',
      // Not an error the user can act on, and not one they caused: the note was
      // still loading when they typed into it, and what they typed is theirs.
      // It says where that text went, because a tab they did not open is the
      // part they cannot work out on their own.
      loadRacedTyping:
        'This note was still loading when you started typing. What you typed is in a new untitled tab; the note now shows the file as it is on disk.',
      crashRecoveryMsg: 'It looks like the app was interrupted last time. Unsaved changes detected ({time}) — restore the latest version?',
      saveAttachmentFailed: 'Failed to save attachment; the image remains in the temp folder',
      saveFailed: 'Save failed; content is kept in the editor, please retry',
      // Not `saveFailed`: that one says "please retry", and a retry here is
      // refused again for the same document until it renders. The cause is the
      // point — otherwise the user retries, sees the same toast, and concludes
      // the app is broken rather than the note unreadable to it.
      saveBlockedUnrenderable:
        'Not saved: this note could not be rendered, so the editor cannot vouch for what it would write. Your text is unchanged.',
      // Also not `saveFailed`, for the same reason and one more: a retry is
      // refused again for as long as the file stays read-only, and the same
      // refusal is what keeps the window from closing. The reason is the point.
      saveBlockedReadOnly:
        'Not saved: {path} is read-only on disk, so the note was left untouched. Your text is kept in the editor.',
      // The same refusal when the Save-As dialog is answering it: the user has
      // to know why a dialog appeared, and that the note itself is unchanged.
      saveBlockedReadOnlyCopy:
        'Not saved: {path} is read-only on disk, so the note was left untouched. Choose where to keep a copy of your text.',
      // Also not `saveFailed`: nothing failed, and the retry it advises means
      // something here the user has to be told — their own save is the answer to
      // this question, and it is the only thing that can replace the file. The
      // CAUSE is the sentence, because a bare "not saved" sends them back to a
      // save that refuses again for a reason they cannot see.
      saveBlockedExternalChange:
        'Not saved: {path} changed on disk since this tab read it, and writing now would replace that change. Your text is kept and still unsaved — save it again (Ctrl+S) to replace the file with your version.',
      savedAsCopy: 'Saved as {path}',
      deleteFailed: 'Delete failed',
      deleteAssetsFailed: 'The note was deleted, but its image folder could not be moved to the trash.',
      watchFailed: 'External file changes cannot be tracked right now, so this list may not follow what happens outside the app. Rebuilding the index retries it.',
      watchRestored: 'External file changes are tracked again.',
      restoreHistoryFailed: 'Failed to restore the historical version',
      // A restore is refused for the same reason a save is, and says so: the
      // version is not lost, the note it would have gone into is protected, and
      // no retry changes that.
      restoreBlockedReadOnly:
        'Not restored: {path} is read-only on disk, so it was left untouched. Your current text is unchanged.',
      reloadFailed: 'Could not reload file: {path}; current content kept',
      unsavedWorkPrompt: 'You have unsaved changes. Leave anyway?',
      unsavedWorkBlocker: 'Some files could not be saved; the vault was not switched.',
      // The close path's own wording. The vault-switch sentence above describes
      // an action the user closing the window never took.
      unsavedWorkBlockerClose:
        'Some files could not be saved; the window stays open and your text is still in the editor.',
      // The way out of a refused save at the moment the user is trying to
      // leave, where a retry they cannot carry out would strand them: the X is
      // the last thing they have left to press.
      unsavedWorkRescue:
        'Some files could not be saved. Choose Restore to save your text as copies under other names; choose Dismiss to keep the window open.',
      untitledVaultSwitchMsg: 'You have {count} unsaved document(s) without a path. Restore to save them before switching; Dismiss to discard them.',
      untitledCloseAllMsg:
        'You have {count} untitled document(s) with unsaved changes. Choose Restore to save them before closing; choose Dismiss to discard them.',
      aria: 'Open documents',
    },

    session: {
      restoreFailed: 'Could not restore the previous tabs',
    },

    recovery: {
      saved: 'Document saved',
      restored: 'Restored the previous version',
      searchCount: '{count} match(es) found',
      wordGoalReached: 'Word goal reached: {goal} words',
      wordGoalProgress: '{current} of {goal} words',
      tmpNotice: 'Found {count} recoverable temporary file(s) left by an interrupted session.',
      restoreFailed:
        'Could not restore {count} temporary file(s): {names}',
    },
  },
  zh: {
    conflict: {
      title: '文件已在外部被修改',
      bodyPrefix: '文件',
      bodySuffix: '的磁盘内容已变化，而当前有未保存的本地修改。',
      reloadDisk: '以磁盘为准（放弃本地）',
      keepLocal: '保留本地',
      later: '稍后再说',
      note: '以磁盘为准将加载磁盘内容并放弃本地修改；保留本地则维持当前内容并保持未保存状态。',
    },

    tabs: {
      missingOnDisk: '{ path } 已被移动或删除（在应用之外）。它已从标签页分离，内容仍在这里——下次保存会询问新位置。',
      close: '关闭',
      closeOthers: '关闭其他',
      closeAll: '关闭全部',
      closeTab: '关闭标签',
      newDoc: '新建文档',
      untitled: '未命名',
      saving: '保存中…',
      dirty: '未保存',
      saved: '已保存',
      openVaultFirst: '尚未打开 vault，无法读取文件',
      readFileFailed: '无法读取文件：{path}',
      loadRacedTyping:
        '这篇笔记尚未加载完成。你输入的正文已保存在新的未命名标签中；笔记现在显示的是磁盘上的内容。',
      crashRecoveryMsg: '检测到上次程序中断，检测到未保存的更改（{time}），恢复最近版本？',
      saveAttachmentFailed: '保存附件失败，图片仍保留在临时目录',
      saveFailed: '保存失败，内容已保留在编辑器中，请重试',
      saveBlockedUnrenderable:
        '未保存：这篇笔记无法被渲染，编辑器无法为将要写入的内容担保。你的文字未改动。',
      saveBlockedReadOnly:
        '未保存：{path} 在磁盘上是只读的，笔记未被改动。你的文字仍保留在编辑器中。',
      saveBlockedReadOnlyCopy:
        '未保存：{path} 在磁盘上是只读的，笔记未被改动。请选择位置保存一份副本。',
      saveBlockedExternalChange:
        '未保存：{path} 自本标签读取后已在磁盘上被修改，现在写入会覆盖那处改动。你的文字已保留且仍未保存——再次保存（Ctrl+S）即可用你的版本替换该文件。',
      savedAsCopy: '已另存为 {path}',
      deleteFailed: '删除失败',
      deleteAssetsFailed: '笔记已删除，但其图片文件夹未能移入回收站。',
      watchFailed: '当前无法跟踪外部文件变化，列表可能不会随应用外的改动更新。重建索引会重试。',
      watchRestored: '已恢复跟踪外部文件变化。',
      restoreHistoryFailed: '恢复历史版本失败',
      restoreBlockedReadOnly:
        '未恢复：{path} 在磁盘上是只读的，未被改动。当前文字未受影响。',
      reloadFailed: '无法重新加载文件：{path}，已保留当前内容',
      unsavedWorkPrompt: '你有未保存的更改，仍要离开吗？',
      unsavedWorkBlocker: '部分文件无法保存，未切换 vault',
      unsavedWorkBlockerClose: '部分文件无法保存；窗口保持打开，文字仍在编辑器中。',
      unsavedWorkRescue:
        '有文件无法保存。选择“恢复”把文字另存为副本；选择“忽略”则保持窗口打开。',
      untitledVaultSwitchMsg: '你有 {count} 个未命名的未保存文档。选择“恢复”在切换前保存；选择“忽略”则丢弃。',
      untitledCloseAllMsg:
        '你有 {count} 个未命名的未保存文档。选择“恢复”在关闭前保存；选择“忽略”则丢弃。',
      aria: '打开的文档',
    },

    session: {
      restoreFailed: '无法恢复上次打开的标签页',
    },

    recovery: {
      saved: '文档已保存',
      restored: '已恢复历史版本',
      searchCount: '找到 {count} 处匹配',
      wordGoalReached: '已达成字数目标：{goal} 字',
      wordGoalProgress: '已完成 {current} / {goal} 字',
      tmpNotice: '发现 {count} 个因会话中断遗留的可恢复临时文件。',
      restoreFailed:
        '有 {count} 个临时文件无法恢复：{names}',
    },
  },
}
