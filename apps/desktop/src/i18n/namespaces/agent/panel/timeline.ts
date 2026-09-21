/** The transcript timeline: turns, thoughts, tool and diff frames, and in-timeline search. */
export const timeline = {
  en: {
    timeline: {
      aria: 'Agent transcript',
      you: 'You',
      /* Names the list of files under the reader's own turn. The names in it are the files'
         own — a vault path or an image's name — so this is what says what the list IS: the
         engine's replay of a restored session carries no attachments, and a host row written
         before this feature existed records none, so the list appears only on a turn of this
         run whose send really carried something. */
      attached: 'Files attached to this message',
      thoughtOpen: 'Hide the reasoning',
      thoughtClosed: 'Show the reasoning',
      jump: 'Back to the end',
      /* The follow switch. Both sentences name the action the press will take rather than the
         state the control is in — `aria-pressed` says which state that is, and a tooltip that
         repeated it would leave a reader who has never used the control with no answer to the
         only question they have. `follow` names the switch for a screen reader while it is
         off, and stops being reachable the moment it is on (`followStop` takes over), so the
         accessible name is always the action. */
      follow: 'Follow the newest output',
      followStop: 'Stop following the newest output',
      /* The transcript's other three controls. Zed draws these under each message
         (`render_thread_controls`) and this panel draws one row for the whole log, so each
         sentence says *which* one it acts on: 「the newest answer」 and 「your last message」
         are the difference between a label and a guess. `copied` is the press landing, and
         `copyFailed` is the clipboard refusing — a reader who is not told would paste a
         stale buffer believing it was the answer. */
      copy: 'Copy the newest answer',
      copied: 'Copied',
      copyFailed: 'The answer could not be copied — the clipboard refused it',
      toUser: 'Go to your last message',
      toTop: 'Go to the beginning',
      /* The transcript's find box (Zed: `conversation_view/thread_search_bar.rs`, whose
         placeholder is "Search this thread…"). It searches the conversation on screen, so
         every sentence here is about *this* one — the history list's box beside it says
         "these sessions" for the same reason. `count` is the field's own answer to "where am
         I": the visible form is "3/5", which read aloud is two numbers, so the label says
         what they are. `noMatch` is the sentence that stands where the count would be, and it
         is deliberately not "0/0": the reader typed something and the honest answer is a
         sentence, not a zero. What the search does and does not cover is stated in
         `services/agent-conversation-search.ts`, and not here — a sentence about the scope of
         a find box in a 220px rail would be longer than the box. */
      search: {
        open: 'Find in this conversation',
        close: 'Close the search',
        label: 'Search this conversation',
        placeholder: 'Search this conversation…',
        previous: 'Previous match',
        next: 'Next match',
        clear: 'Clear the search',
        count: 'Match {index} of {total}',
        noMatch: 'No line of this conversation matches',
      },
      tool: {
        status: {
          pending: 'Queued',
          inProgress: 'Running',
          completed: 'Done',
          failed: 'Failed',
          cancelled: 'Cancelled',
        },
        expand: 'Show what this call carried',
        collapse: 'Hide it',
        args: 'Arguments',
        output: 'Output',
        argsAbsent: 'This call was made with no arguments',
        argsUnreadable: 'The engine sent arguments this app could not read',
        outputAbsent: 'This call produced no output',
        outputUnreadable: 'This call produced output this app could not read',
        /* The proposed change, and the four things about it this app must not round off.
           `added`/`removed` are counts this app derived by comparing the block's own two
           texts — ACP carries no hunks — so they are this app's arithmetic over the engine's
           data, and the sentences say what they are instead of implying the engine sent them.
           `identical` is drawn as a sentence rather than left as an empty row set: a call
           that asks to touch a file while proposing the same text on both sides is a fact the
           reader has to be told. `noOriginal` claims only what was received — the schema's
           own gloss for an absent original is "a new file", but that same field deserializes
           default-on-error, so an original this host could not read arrives identically, and
           this sentence is what a surface can say without choosing between the two. */
        diff: {
          label: 'Proposed change',
          added: '+{n}',
          removed: '−{n}',
          identical: 'The engine sent the same text on both sides, so this proposal changes nothing in this file.',
          noOriginal: 'The engine sent no original text for this file, so every line below is shown as added.',
          partial: 'This app compared the first {n} lines a side; the file continues past them and the change may too.',
          beyond: 'This app compared the first {n} lines a side and they contain no change — the two sides differ past them.',
          folded: '{n} unchanged lines',
          reveal: 'Show these {n} unchanged lines',
          undrawn: 'The engine attached content of a kind this version does not draw.',
        },
      },
    },
  },
  zh: {
    timeline: {
      aria: '智能体记录',
      you: '你',
      attached: '这条消息附带的文件',
      thoughtOpen: '收起思考过程',
      thoughtClosed: '展开思考过程',
      jump: '回到末尾',
      /* 跟随开关。两句写的都是按下之后会发生什么，而不是当前处于什么状态——状态由
         `aria-pressed` 说明，提示语再重复一遍只会让第一次用这个控件的读者得不到答案。 */
      follow: '跟随最新输出',
      followStop: '停止跟随最新输出',
      /* 记录区另外三个控件。Zed 把它们画在每条消息下面（`render_thread_controls`），本面板
         是为整个记录画一行，所以每句都要说明它作用在**哪一个**上：『最新的回答』和『你上一条
         消息』正是标签与猜测之间的差别。`copied` 是按下生效，`copyFailed` 是剪贴板拒绝——不
         告诉读者，他们就会把旧内容当成回答粘贴出去。 */
      copy: '复制最新的回答',
      copied: '已复制',
      copyFailed: '未能复制该回答——剪贴板拒绝了这次操作',
      toUser: '跳到你上一条消息',
      toTop: '跳到开头',
      /* 记录区的查找框（Zed：`conversation_view/thread_search_bar.rs`，占位文案是
         "Search this thread…"）。它查的是屏幕上这一段对话，所以每句都写「这段对话」；旁边的
         历史列表查找框写「这些会话」，理由相同。`count` 是这个框对「我在哪一条」的回答：可见
         形式是 "3/5"，读出来是两个数字，所以标签要把它们是什么说出来。`noMatch` 是占住计数
         位置的那句话，它刻意不是 "0/0"——读者确实输入了内容，诚实的回答是一句话而不是一个零。
         搜索覆盖什么、不覆盖什么写在 `services/agent-conversation-search.ts` 里，不写在这里：
         220px 宽的侧栏里，一句解释查找框范围的话会比这个框本身还长。 */
      search: {
        open: '在这段对话中查找',
        close: '关闭查找',
        label: '搜索这段对话',
        placeholder: '搜索这段对话……',
        previous: '上一个匹配',
        next: '下一个匹配',
        clear: '清除搜索',
        count: '第 {index} 个匹配，共 {total} 个',
        noMatch: '这段对话中没有匹配的内容',
      },
      tool: {
        status: {
          pending: '排队中',
          inProgress: '执行中',
          completed: '完成',
          failed: '失败',
          cancelled: '已取消',
        },
        expand: '展开这次调用的内容',
        collapse: '收起',
        args: '参数',
        output: '输出',
        argsAbsent: '这次调用没有参数',
        argsUnreadable: '引擎发送了本应用无法读取的参数',
        outputAbsent: '这次调用没有输出',
        outputUnreadable: '这次调用产生了本应用无法读取的输出',
        /* 引擎提议的改动，以及本应用不能含糊掉的四件事。`added`/`removed` 是本应用对
           区块自带两段文本做比较得出的计数——ACP 不传 hunk——所以那是本应用在引擎的数据上
           算出来的，句子要说明它是什么，而不是暗示是引擎发来的。`identical` 写成一句话而
           不是留成空列表：一次调用要求动这个文件、两侧文本却相同，这件事必须告诉读者。
           `noOriginal` 只声明收到的东西——schema 对「没有原文」的注解是「新文件」，但同一
           个字段是 default-on-error 反序列化的，本应用读不出来的原文会以同样的样子到达，
           这句话是两者都不得罪的说法。 */
        diff: {
          label: '提议的改动',
          added: '+{n}',
          removed: '−{n}',
          identical: '引擎两侧发送的文本相同，所以这次提议不会改动这个文件里的任何内容。',
          noOriginal: '引擎没有发送这个文件的原文，所以下面每一行都按新增显示。',
          partial: '本应用只比较了每一侧的前 {n} 行；文件在这之后还有内容，改动也可能还在后面。',
          beyond: '本应用只比较了每一侧的前 {n} 行，这些行里没有任何改动——两侧的差异在这些行之后。',
          folded: '{n} 行未改动',
          reveal: '展开这 {n} 行未改动的内容',
          undrawn: '引擎附带了本版本不绘制的内容块。',
        },
      },
    },
  },
} as const
