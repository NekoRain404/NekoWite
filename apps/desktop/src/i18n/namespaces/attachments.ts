/** The attachment library panel. */
export const attachments = {
  en: {
    attachments: {
      title: 'Attachments',
      refresh: 'Refresh',
      loading: 'Loading attachments…',
      emptyTitle: 'Attachment library is empty',
      // Where a paste actually lands is the note's own `<basename>_assets`
      // folder, not the `attachments/` tree this panel lists
      // (`services/rename-asset.ts::assetsDirForNote`). Saying otherwise sent
      // the reader looking in the wrong directory for the file they just made.
      //
      // **Written without angle brackets on purpose.** The first version spelled
      // the folder `<notename>_assets`, and Vue I18n reads that as an HTML
      // message: it logs "Detected HTML in … message. Recommend not using HTML
      // messages to avoid XSS" on every render, which `e2e/console-clean.spec.ts`
      // fails on — the panel is not an XSS risk, but a console warning that every
      // other surface is held to zero of is a real defect, and the brackets were
      // decoration around a name that reads fine without them.
      emptyHint:
        'Paste or drop an image into a note and it is saved beside that note, in a folder named "notename_assets" (the note\'s file name plus _assets); a note with no path yet stages it in .tmp until the note is saved. This list shows the vault attachments folder, where the images the app inserts for you land (attachments/YYYY-MM/).',
      insertImage: 'Insert image {name}',
      insert: 'Insert into document',
      copyPath: 'Copy relative path',
      deleteConfirm: 'Confirm delete',
      openDocFirst: 'Open a document first to insert an image',
      editorNotReady: 'Editor is not ready yet, try again shortly',
      pasteNotInserted: 'Image {name} was saved, but not inserted: the note changed while it was saving. Insert it from the attachments panel.',
      insertFailed: 'Failed to insert image, please retry',
      pickFailed: 'Could not open the file picker, please retry',
      importFailed: 'Failed to import the image, please retry',
      copyFailed: 'Failed to copy, please copy manually',
      deleteFailed: 'Delete failed, please retry',
    },
  },
  zh: {
    attachments: {
      title: '附件',
      refresh: '刷新',
      loading: '正在加载附件…',
      emptyTitle: '附件库为空',
      emptyHint:
        '在笔记中粘贴或拖入的图片会保存在该笔记旁边、以该笔记文件名命名的「笔记名_assets」目录；笔记还没有路径时先暂存于 .tmp，保存后移入该目录。此列表显示 vault 的 attachments 目录，即应用为你插入的图片所在位置（attachments/年月/）。',
      insertImage: '插入图片 {name}',
      insert: '插入到文档',
      copyPath: '复制相对路径',
      deleteConfirm: '确认删除',
      openDocFirst: '请先打开一个文档，再插入图片',
      editorNotReady: '编辑器尚未就绪，请稍后再试',
      pasteNotInserted: '图片 {name} 已保存，但未插入：保存期间切换了文档。可在附件面板中插入。',
      insertFailed: '插入图片失败，请重试',
      pickFailed: '打开文件选择器失败，请重试',
      importFailed: '导入图片失败，请重试',
      copyFailed: '复制失败，请手动复制',
      deleteFailed: '删除失败，请重试',
    },
  },
}
