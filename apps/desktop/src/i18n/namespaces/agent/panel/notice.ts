/** What the panel says when part of the session record did not arrive. */
export const notice = {
  en: {
    notice: {
      gap: 'Part of this session’s record did not arrive, so what is below may be missing events.',
      resync: 'Reload the session',
      /* Frames that arrived and were refused by the reducer, which is a different thing from
         the hole above: a refusal is usually the *transport* re-sending what the view already
         has (`duplicate-sequence`, which is what a reload produces), so this sentence says
         what happened and names the reason rather than claiming content is missing. `{reason}`
         is the reducer's own word for the refusal and is not translated — a sentence per
         refusal would be this app explaining seven states only the reducer can tell apart.
         Phrased with the count after a noun so that one frame reads as well as twelve. */
      dropped: 'Frames this window refused for this session: {n} (last: {reason}).',
    },
  },
  zh: {
    notice: {
      gap: '本会话的记录缺了一段，下面的内容可能缺少事件。',
      resync: '重新载入会话',
      /* 到达但被 reducer 拒收的帧，和上面那个洞不是一回事：拒收通常是因为传输层把本视图已有的
         帧又送了一遍（`duplicate-sequence`，也就是点一次重新载入会产生的那些），所以这句话只
         说发生了什么并给出原因，而不会宣称内容有缺失。`{reason}` 是 reducer 自己的词，不翻译
         ——为七种只有 reducer 分得清的状态各写一句话，等于本应用替它解释。 */
      dropped: '本窗口拒收的帧数：{n}（最近一次：{reason}）。',
    },
  },
} as const
