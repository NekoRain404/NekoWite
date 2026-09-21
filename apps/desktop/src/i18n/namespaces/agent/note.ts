/** The agent note: its edit row, conflicts and the SVG artifact it can insert. */
export const note = {
  en: {
    /* What the editor pane owes the reader about what the agent produced for the note it has
       open. The surface these words belong to is mounted inside the editor pane, so every
       sentence here answers a question the reader is asking with their own paragraph in front
       of them: what did the agent produce, what does applying it do to MY text, and what
       happened after I chose. `conflict` is the copy `AgentEditConflictView` draws; the words
       live here rather than inside that component because a surface that carried its own
       sentences could not be mounted in a Chinese window without shipping English ones. */
    note: {
      title: 'What the agent proposes for this note',
      /* An unwritten proposal is the whole subject of this block: §7.2 gives it the verbs
         apply/discard, and the sentence says so before the reader presses anything, because
         "did it already do this?" is the question a change that has not landed raises. */
      unwritten: 'Nothing has been written yet. Applying it puts the agent’s version in this note; keeping yours leaves the note untouched.',
      edit: {
        row: 'The agent produced a version of {path}',
        apply: 'Use the agent’s version',
        discard: 'Keep mine',
      },
      /* What became of the answer. Three facts, told apart on purpose: the text is in the note
         and on the file, the text is in the note and the file does not have it, and nothing was
         written. Folding the second into the first is how a user finds out on their next
         restart that a paragraph only ever existed in this window. */
      outcome: {
        saved: 'The agent’s version is in the note, and the file has it.',
        saveFailed: 'The agent’s version is in the note, but the file does not have it. Saving the note again will write it.',
        discarded: 'Nothing was written. The note is as you left it.',
      },
      /* Why nothing was written. Codes in, sentences out — the same arrangement the change
         review uses, and for the same reason: the service returns a reason and this is the one
         layer that owns the language. */
      refused: {
        noteNotOpen: 'No tab holds this note any more, so there is nothing to write into.',
        targetChanged: 'The editor answered about a different note than the one asked about, so nothing was written.',
        vaultMismatch: 'This note belongs to another vault than the session the answer was produced under.',
        identityChanged: 'The session that produced this answer is not the session this window is on any more.',
        writeUnavailable: 'Nothing can take the text: the pane that owns this note is not available.',
      },
      conflict: {
        title: 'This note changed while the agent was working',
        moved: 'was edited after the request went out',
        agentText: 'What the agent produced',
        noteText: 'What the note holds now',
        apply: 'Use the agent’s version',
        discard: 'Keep my version',
        kept: 'Your text is handed back to the window either way: applying replaces it in the note, and nothing else holds a copy.',
      },
      /* §7.3's insertion: the SVG the run staged for this note, verified before anything is
         drawn. `where` says the spot out loud — an image placed at the end of a document rather
         than at the caret is a decision, and a reader who was not told would think the app had
         put it where they were looking. */
      svg: {
        row: 'The agent produced {name} for this note',
        verified: 'Verified preview. The file is copied into this vault as it is; what is below is what the checks allowed.',
        where: 'It will be placed at the end of this note.',
        name: 'File name',
        insert: 'Put it in this note',
        /* The second answer §7.3 clause 5 asks for, drawn only after a press made from another
           note. It says "the note I have open" rather than "this note" because the whole reason
           it is on screen is that the reader and the offer disagree about which note that is. */
        reconfirm: 'Put it in the note I have open now',
        discard: 'Leave it out',
        previewAlt: 'Preview of {name}',
        /* Why the artifact may not be previewed. Codes in, sentences out: each names the thing
           that is wrong rather than echoing the value that was refused, which would only put the
           hostile string in front of the reader. */
        unreadable: 'The file the agent wrote could not be read, so nothing is offered for it.',
        refused: {
          notSvg: 'That file is not an SVG.',
          tooLarge: 'That file is larger than this app will parse ({size} of {limit} bytes).',
          incompleteRead: 'That file is still being written: it declares {size} bytes and {read} were read.',
          declaration: 'That file carries a {kind} declaration, which this app does not hand to a parser.',
          malformed: 'That file is not well-formed XML.',
          tooComplex: 'That file has more elements ({elements}) than this app will walk ({limit}).',
          tooDeep: 'That file nests deeper ({depth}) than this app will descend ({limit}).',
          foreignNamespace: '{element} belongs to another XML vocabulary ({namespace}).',
          unsafeElement: '{element} is not on the list of elements this app renders.',
          unsafeAttribute: '{element} carries {attribute}, which this app does not render.',
          externalReference: '{element} points at {attribute}, which would make the preview fetch something.',
        },
        /* Why nothing was placed. The first is the ordinary case and says the whole of it: the
           note is untouched. The rest name what has to change before it can be. */
        outcome: {
          inserted: 'The image is in this note and the file is in the vault.',
          moveFailed: 'The image was not copied into the vault, so the note was left alone.',
          moveElsewhere: 'The vault named the file {saved} rather than {planned}, so the note was left alone.',
          noteWriteFailed: 'The image is in the vault, but the note could not be saved with the link in it.',
          noteNotOpen: 'No tab holds this note any more, so there was nowhere to put it.',
          targetChanged: 'The editor answered about a different note than the one asked about.',
          /* §7.3 clause 5's own case, and the sentence names the note the offer was about: the
             reader is looking at the other one, so which one they have left is the fact they
             cannot read off the screen. Nothing was written — the control beside this sentence
             is what writes, and only if they press it. */
          noteSwitched: 'This insertion was prepared for {planned}, and you are in another note now. Nothing has been written: put it in the note you have open and it goes there instead.',
          vaultMismatch: 'This note belongs to another vault than the session the plan was made under.',
          anchorOutOfRange: 'The spot this was being placed at is not in the note.',
          identityChanged: 'The session that produced this artifact is not the session this window is on any more.',
          revisionChanged: 'The note was edited while the image was being placed. Nothing was inserted.',
          anchorMoved: 'The text at the spot this was being placed at changed. Nothing was inserted.',
          invalidFileName: 'That is not a usable file name.',
          nameUnavailable: 'That name is taken in this folder, and no free variant of it was found.',
          attachmentNotSaved: 'The file is not in the vault, so the note was left alone.',
        },
      },
    },
  },
  zh: {
    note: {
      title: '智能体为这篇笔记提出的内容',
      unwritten: '还没有写入任何东西。应用会把智能体的版本放进这篇笔记；保留你的版本则完全不动它。',
      edit: {
        row: '智能体为 {path} 生成了一个版本',
        apply: '采用智能体的版本',
        discard: '保留我的版本',
      },
      outcome: {
        saved: '智能体的版本已经在笔记里，文件里也有了。',
        saveFailed: '智能体的版本已经在笔记里，但文件里还没有。再保存一次这篇笔记就会写进去。',
        discarded: '没有写入任何东西，笔记和你离开时一样。',
      },
      refused: {
        noteNotOpen: '已经没有标签页打开这篇笔记了，没有可以写入的地方。',
        targetChanged: '编辑器回答的是另一篇笔记，因此什么都没有写入。',
        vaultMismatch: '这篇笔记属于另一个库，与该答案产生时的会话不是同一个。',
        identityChanged: '产生这个答案的会话已经不是这个窗口当前所在的会话。',
        writeUnavailable: '没有东西可以接收这段文字：持有这篇笔记的窗格现在不可用。',
      },
      conflict: {
        title: '你思考期间这篇笔记被改动了',
        moved: '在请求发出之后被编辑过',
        agentText: '智能体产出的内容',
        noteText: '笔记现在的内容',
        apply: '采用智能体的版本',
        discard: '保留我的版本',
        kept: '无论选哪个，你的文字都会交回给窗口：应用会把它从笔记里替换掉，除此之外没有别处保存它。',
      },
      svg: {
        row: '智能体为这篇笔记产出了 {name}',
        verified: '已通过校验的预览。文件会原样复制进这个库；下面显示的是各项检查放行的内容。',
        where: '它会被放在这篇笔记的末尾。',
        name: '文件名',
        insert: '放进这篇笔记',
        reconfirm: '放进我现在打开的这篇笔记',
        discard: '不放进',
        previewAlt: '{name} 的预览',
        unreadable: '读不到智能体写出的那个文件，因此不为它提供任何操作。',
        refused: {
          notSvg: '那个文件不是 SVG。',
          tooLarge: '那个文件比本应用愿意解析的上限还大（{size}／{limit} 字节）。',
          incompleteRead: '那个文件还在写入：它声明有 {size} 字节，实际读到 {read} 字节。',
          declaration: '那个文件带有 {kind} 声明，本应用不会把它交给解析器。',
          malformed: '那个文件不是良构的 XML。',
          tooComplex: '那个文件的元素数（{elements}）超过本应用愿意遍历的上限（{limit}）。',
          tooDeep: '那个文件的嵌套深度（{depth}）超过本应用愿意下探的上限（{limit}）。',
          foreignNamespace: '{element} 属于另一个 XML 词汇表（{namespace}）。',
          unsafeElement: '{element} 不在本应用绘制元素的名单上。',
          unsafeAttribute: '{element} 带有 {attribute}，本应用不绘制它。',
          externalReference: '{element} 指向 {attribute}，那会让预览去取外部内容。',
        },
        outcome: {
          inserted: '图片已经在笔记里，文件也已经在库里。',
          moveFailed: '图片没有复制进库里，因此笔记保持原样。',
          moveElsewhere: '库把文件命名为 {saved}，而不是 {planned}，因此笔记保持原样。',
          noteWriteFailed: '图片已经在库里，但这篇笔记没能带着链接保存成功。',
          noteNotOpen: '已经没有标签页打开这篇笔记了，无处可放。',
          targetChanged: '编辑器回答的是另一篇笔记，不是被问的那一篇。',
          noteSwitched: '这次插入是为 {planned} 准备的，而你现在在另一篇笔记里。什么都没有写入：确认之后它会放进你现在打开的这篇。',
          vaultMismatch: '这篇笔记属于另一个库，与该计划产生时的会话不是同一个。',
          anchorOutOfRange: '要放置的位置不在这篇笔记里。',
          identityChanged: '产出这个文件的会话已经不是这个窗口当前所在的会话。',
          revisionChanged: '放置图片期间这篇笔记被编辑过，因此什么都没有插入。',
          anchorMoved: '要放置的位置上的文字变了，因此什么都没有插入。',
          invalidFileName: '那不是可用的文件名。',
          nameUnavailable: '那个名字在这个文件夹里已被占用，也没有找到可用的变体。',
          attachmentNotSaved: '文件不在库里，因此笔记保持原样。',
        },
      },
    },
  },
} as const
