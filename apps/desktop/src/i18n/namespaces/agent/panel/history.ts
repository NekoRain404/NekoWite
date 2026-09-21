/** The session-history drawer: list, search, paging and the free-session reset. */
export const history = {
  en: {
    /* The session history menu (T17): the rows an engine's `session/list` answer draws.
       Every row is the engine's own facts — its title, its folder, its last-activity stamp —
       and the sentences here are only what this app can say *of* them: which one is open,
       that one was recorded elsewhere, when one was last touched, and why there is nothing
       to show. `untitled` is deliberately a statement about the engine rather than a name
       for the session: a title this app invented for a session that had none would be a fact
       the engine never stated. */
    history: {
      list: 'Sessions',
      loading: 'Reading the sessions this engine holds...',
      empty: 'This engine holds no sessions.',
      unreadable: 'The engine’s sessions could not be read: {reason}',
      /* An engine that names a further page has not shown the whole table, and a list that
         read as complete would be the one answer worse than a short one. */
      more: 'This is the first page. The engine named more sessions after these.',
      /* The control the sentence above became. The sentence is the button's `title` —
         it explains why the list is short — and these are what the button says and does:
         an action while it can act, a state while the read is in flight, and the engine's
         own reason when the page could not be read. */
      moreLoad: {
        load: 'Read the next page',
        loading: 'Reading the next page...',
        failed: 'The next page could not be read: {reason}',
      },
      /* The find box over the rows. It narrows what the engine already sent and asks the
         engine nothing (`filterSessionRows`), which is why `noMatch` is a sentence about this
         search rather than about the engine's table: this app has not looked for such a
         session and must not say the engine holds none. */
      search: {
        label: 'Search these sessions',
        placeholder: 'Search these sessions...',
        clear: 'Clear the search',
        noMatch: 'No session matches',
      },
      /* The one entry in this list that is not a row: a new session on the same engine. The
         note is the consequence, and it is what a reader needs before pressing — the session
         they are in is neither replaced nor taken away by this. */
      newSession: {
        label: 'New session',
        note: 'Starts a new session on this engine. The one open now keeps running and stays in this list.',
      },
      untitled: 'The engine sent no title for this session',
      current: 'Open now',
      elsewhere: 'Recorded in another folder: {cwd}',
      age: {
        now: 'just now',
        minutes: '{n} min ago',
        hours: '{n} h ago',
        days: '{n} d ago',
      },
      /* The action on a row's engine record, and the whole of what this app says about it.
         **Nothing here may read as "delete".** The engine was measured keeping a closed
         session in its list (`agent_session_lifecycle_test.rs` §4.4) — removing one is
         `session/delete`, which the pinned engine answers `-32601` for — so the question says
         what is about to happen, the note says what will *not*, and the sentence after a
         success says why the row the reader is looking at is still there. A user who presses
         this and sees the row still present must not conclude it failed. */
      free: {
        label: 'Free this session on the engine',
        confirm: 'Free this session on the engine?',
        note: 'The engine stops serving it and cancels anything it was running. It keeps the session in its list: removing one is a different method this engine does not implement, so this row will still be here afterwards.',
        confirmAction: 'Free it',
        cancel: 'Keep it',
        done: 'The engine let it go. The row is still in this list — that is the engine’s answer, not a failure.',
        /* {reason} names its own refuser, and this lead-in must not name one for it. Two
           things can refuse here and they are different facts: the engine (its own sentence
           arrives, classified by the transport) and this app, which refuses a session it
           never opened before the engine is asked at all — that sentence names this app.
           It said 「The engine would not free it:」 and so blamed the engine for §6.1's
           boundary; the action is also no longer offered on rows this app cannot act on
           (see `AgentSessionHistoryMenu`), which leaves this arm for the engine and for the
           race where the host's table moved under the list. */
        failed: 'It was not freed: {reason}',
      },
    },
  },
  zh: {
    /* 会话历史菜单（T17）：引擎对 `session/list` 的回答所画出的行。每一行都是引擎自己的
       事实——它的标题、它所在的文件夹、它的最后活动时间——这里的话只是本应用对这些事实能
       说的部分：哪一个是当前打开的、哪一个记录在别处、某个会话上次被碰是什么时候，以及为什
       么什么都没有。`untitled` 刻意是对引擎的陈述而不是替它起的名字：本应用为没有标题的会话
       编一个标题，就是在陈述引擎从未说过的事。 */
    history: {
      list: '会话',
      loading: '正在读取该引擎保存的会话……',
      empty: '该引擎没有保存任何会话。',
      unreadable: '未能读取该引擎的会话列表：{reason}',
      more: '这只是第一页，引擎在后面还列出了更多会话。',
      /* 上面那句话变成的控件。那句话现在是按钮的 `title`（它解释了列表为什么这么短），
         这里则是按钮说什么、做什么：能动手时是一个动作，读取中是一个状态，读不到时是引擎
         自己的原因。 */
      moreLoad: {
        load: '读取下一页',
        loading: '正在读取下一页……',
        failed: '未能读取下一页：{reason}',
      },
      search: {
        label: '搜索这些会话',
        placeholder: '搜索这些会话……',
        clear: '清除搜索',
        noMatch: '没有匹配的会话',
      },
      newSession: {
        label: '新会话',
        note: '在该引擎上开始一个新会话。当前打开的会话会继续运行，并保留在这个列表中。',
      },
      untitled: '引擎没有为该会话提供标题',
      current: '当前打开',
      elsewhere: '记录在另一个文件夹中：{cwd}',
      age: {
        now: '刚刚',
        minutes: '{n} 分钟前',
        hours: '{n} 小时前',
        days: '{n} 天前',
      },
      /* 针对某一行「引擎侧记录」的操作，本应用对此说的全部内容。**这里任何一句话都不能读起
         来像「删除」。**实测中引擎会保留已关闭的会话（`agent_session_lifecycle_test.rs` §4.4）
         ——从列表中移除走的是 `session/delete`，而该引擎对它回答 `-32601`——因此提问说的是即将
         发生什么，说明说的是不会发生什么，成功之后那句话解释为什么这一行还在。按下去之后看到
         该行仍在，用户不能以为自己失败了。 */
      free: {
        label: '让引擎释放该会话',
        confirm: '要让引擎释放这个会话吗？',
        note: '引擎将不再为它服务，并会取消它当时正在运行的内容。引擎仍会把它留在自己的列表中：从列表中移除会话是另一个方法，而该引擎并未实现，因此这一行之后依然在。',
        confirmAction: '释放',
        cancel: '保留',
        done: '引擎已经释放了它。这一行仍然在这个列表里——这是引擎自己的回答，不是失败。',
        failed: '未能释放该会话：{reason}',
      },
    },
  },
} as const
