/** The line the panel draws when no session is open. */
export const empty = {
  en: {
    /* The transcript's first line, drawn only while the transcript is empty. It names the
       engine and offers the one mechanism this panel really has: `/` opens the engine's own
       command list (T8). There is deliberately no `@` clause - `prompt()` takes no context
       slot and nothing in the composer triggers `@`, and a sentence about a feature that
       cannot be reached is the one thing this tree must not carry. */
    empty: {
      line: 'Message {engine} — / for commands',
    },
  },
  zh: {
    empty: {
      line: '给 {engine} 发消息——输入 / 查看命令',
    },
  },
} as const
