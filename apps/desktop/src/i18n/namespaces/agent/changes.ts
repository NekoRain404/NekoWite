/** The change review: what the agent wrote, what it offers and what it refused. */
export const changes = {
  en: {
    /* The run's changed files, and the three answers about them. Every sentence here is about a
       fact the review service decided: `agent-change-review.ts` returns codes, and this is the one
       layer that owns the language. The refusals each name a different thing to do, which is why
       they are not one sentence. */
    changes: {
      title: 'What this run changed',
      empty: 'Nothing has changed yet.',
      /* One line for the whole list, and it is what a collapsed strip still shows. The counts are
         filled in by the caller, which is the layer that can count the rows it drew. */
      summary: '{files} changed · {kept} kept · {putBack} put back · {toReview} to review',
      collapse: 'Hide the list',
      expand: 'Show the list',
      attribution: {
        agent: 'A tool call of this session wrote this file',
        external: 'This file changed on disk, and nothing in this session claims it',
        reported: 'The engine named this file; no call and no disk change confirmed it',
      },
      verdict: {
        followsDisk: 'No unsaved edits in this note',
        unsavedEdits: 'This note has unsaved edits',
      },
      offer: {
        view: 'Review',
        keep: 'Keep',
        recover: 'Reject',
      },
      /* Why a rejection is not on the row. Codes in, sentences out — the same arrangement the
         note proposals use, and for the same reason: a code the user cannot read would leave them
         believing the write happened. */
      refused: {
        notAgentChange: 'Nothing here recorded a change to put back.',
        writeInFlight: 'The agent is still writing this file.',
        noBaseline: 'No request named this file, so the version to put back was never kept.',
        vaultMismatch: 'This note belongs to another vault than the session that changed it.',
        unsavedEdits: 'This note has unsaved edits. Both texts are below; the note’s own keep-or-reload prompt is where they are settled.',
        resultUnstated: 'The call did not say what it left in this file, so there is nothing to check the note against.',
        changedSince: 'This note is no longer what the agent left: it was edited after the change.',
      },
      decision: {
        kept: 'Kept',
        rejected: 'Put back',
      },
      written: {
        saved: 'The note is back and the file has it.',
        saveFailed: 'The note is back, but the file does not have it. Saving the note again will write it.',
        unavailable: 'Nothing took the text: the pane that owns this note is not available.',
      },
      /* What the HOST's own recovery answered, for a note no tab holds. A second copy tree beside
         `written` rather than a reuse of it, because the two writers answer different questions:
         the note's save says what became of the buffer, and this says what the host did with the
         file — and every sentence below is about the file alone. */
      recovered: {
        recovered: 'The file is back at the version the request was made against, and the version it replaced was kept in the note’s history.',
        warning: 'The version it replaced could not be kept in the history.',
        refused: {
          noBaseline: 'This host did not perform that write, so it holds no version to put back.',
          baselineStale: 'The file moved between the version this host recorded and the agent’s write, so the text it holds is not the one to restore.',
          unavailable: 'The file could not be read where the change should be: it was deleted, renamed, or is not text this app can read.',
          changedSinceRecorded: 'The file is no longer what the agent left: it was edited after the change. Putting the version back would take that edit away.',
          alreadyAtBaseline: 'The file already holds the version to put back, so there is nothing to do.',
          writeRefused: 'The app’s own save refused it: a read-only file, a path that left the vault, or a file that is not text.',
        },
        unreachable: 'The host could not be asked:',
      },
      unsavedBuffer: 'Your unsaved text',
      /* The file's text as the call said it left it — shown beside the user's when the buffer has
         unsaved edits, because that is the one case where the file's own text is not on screen. */
      agentVersion: 'What the call left in the file',
      /* The other arm of that block, and the honest one: the call stated no text for this file,
         so there is nothing to put beside the user's own. An empty block would read as an empty
         file the agent had in fact changed. */
      diskUnread: 'No text for this file is recorded here, so only your unsaved text is shown.',
    },
  },
  zh: {
    changes: {
      title: '这次运行改动的文件',
      empty: '还没有任何改动。',
      summary: '改动 {files} · 保留 {kept} · 已撤回 {putBack} · 待处理 {toReview}',
      collapse: '收起列表',
      expand: '展开列表',
      attribution: {
        agent: '本会话的一次工具调用写了这个文件',
        external: '这个文件在磁盘上变了，本会话没有任何记录指认它',
        reported: '引擎点名了这个文件，但没有工具调用、也没有磁盘变化佐证',
      },
      verdict: {
        followsDisk: '这篇笔记没有未保存的编辑',
        unsavedEdits: '这篇笔记有未保存的编辑',
      },
      offer: {
        view: '查看',
        keep: '保留',
        recover: '撤回',
      },
      refused: {
        notAgentChange: '这里没有记录过可以撤回的改动。',
        writeInFlight: '智能体还在写这个文件。',
        noBaseline: '没有任何请求点名过这个文件，因此没有留下可撤回的版本。',
        vaultMismatch: '这篇笔记属于另一个库，与改动它的会话不是同一个。',
        unsavedEdits: '这篇笔记有未保存的编辑。两个版本都在下面；在哪里取舍由笔记自己的「保留本地／重新载入」提示决定。',
        resultUnstated: '这次调用没有说明它在文件里留下了什么，因此没有东西可以拿来比对该笔记。',
        changedSince: '这篇笔记已经不是智能体留下的那一版：改动之后又被编辑过。',
      },
      decision: {
        kept: '已保留',
        rejected: '已撤回',
      },
      written: {
        saved: '笔记已经还原，文件里也有了。',
        saveFailed: '笔记已经还原，但文件里还没有。再保存一次这篇笔记就会写进去。',
        unavailable: '没有东西可以接收这段文字：持有这篇笔记的窗格现在不可用。',
      },
      /* 宿主自己的恢复给出的答案，用于没有标签页打开的笔记。与 `written` 并列而不是复用它：
         两个写入者回答的是不同的问题——笔记的保存说的是缓冲区怎么了，这里说的是宿主把文件
         怎么了，下面每一句都只讲文件。 */
      recovered: {
        recovered: '文件已经回到提出请求时的版本，被替换掉的那一版也留在了笔记的历史里。',
        warning: '被替换掉的那一版没能留在历史里。',
        refused: {
          noBaseline: '那次写入不是本宿主执行的，因此它没有可还原的版本。',
          baselineStale: '从本宿主记录的那一版到智能体写入之间，文件变动过，所以它手里的文本不是该还原的那一份。',
          unavailable: '在改动应该留下的位置读不到这个文件：它被删除、改名了，或者不是本应用能读的文本。',
          changedSinceRecorded: '这个文件已经不是智能体留下的那一版：改动之后又被编辑过。还原会带走那次编辑。',
          alreadyAtBaseline: '文件已经是待还原的那一版了，没有什么可做。',
          writeRefused: '应用自己的保存拒绝了：文件只读、路径离开了库，或者不是文本文件。',
        },
        unreachable: '没能问到宿主：',
      },
      unsavedBuffer: '你未保存的文字',
      agentVersion: '这次调用在文件里留下的内容',
      diskUnread: '这里没有记下这个文件的内容，因此只显示你未保存的文字。',
    },
  },
} as const
