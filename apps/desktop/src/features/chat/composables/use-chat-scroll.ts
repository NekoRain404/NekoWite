/**
 * The transcript's scroll policy: follow the newest turn while the reader is at
 * the end of the log, and stop following the moment they leave it (§5.2).
 *
 * The rules it implements, and the sentence each comes from:
 *
 *  - 「用户离开底部后不强制跟随」— nothing moves the container unless the reader is
 *    already at its end. The transcript used to write `scrollTop = scrollHeight`
 *    on every chunk, which is a container that drags the reader back down each
 *    time they scroll up to re-read an earlier answer: at streaming speed that
 *    is not a nudge, it is being held at the bottom for the length of the answer.
 *  - 「回到底部是明确动作，不抢阅读位置」— the end is reached by the reader's own
 *    scroll (following resumes there, without them asking twice) or by
 *    {@link ChatScroll.jumpToEnd}. Content arriving never decides it.
 *  - 「提供新内容提示」— the half that pauses for the reader is also the half that
 *    owes them a way back: {@link ChatScroll.arrived} is what the transcript
 *    turns into a hint, and {@link ChatScroll.pending} is the only number that
 *    hint may carry.
 *
 * Deliberately *not* here: any animation. A pinned transcript follows the text
 * rather than a curve, and §5.2 forbids per-token animation
 * (「每帧合并文本增量，不为每个 token 做动画」).
 *
 * ## Why this is not the agent timeline's composable
 *
 * `features/agent/composables/use-agent-scroll.ts` implements the same three
 * rules, and this is deliberately a second, smaller implementation rather than
 * that one shared. Two reasons, and the second is the load-bearing one:
 *
 *  - §13.11: a feature reaches another feature through its `index.ts`, and that
 *    entry point exports the agent's scroll composable only when a second real
 *    caller exists. Chat is a second caller of the *rule*, not of that module:
 *    half of what it does has no meaning here (per-session positions, the
 *    anchor held when a row above the viewport changes height, the
 *    `ResizeObserver`). None of it is needed, because a chat turn can only grow
 *    at the END of the log, so a reader who is not at the end has nothing above
 *    them moving.
 *  - the one part that genuinely is shared — reading our own programmatic write
 *    back as a scroll event and not mistaking it for the reader's hand — is
 *    reproduced below, with the reason it exists.
 *
 * If a third surface ever needs this, the honest move is to lift the rule into
 * `src/composables/` and have all three call it, not to grow this one.
 */

import { nextTick, ref, watch, type Ref } from 'vue'

/**
 * How close to the end still counts as the end.
 *
 * Not zero: WebKitGTK on a fractional device pixel ratio leaves a fraction of a
 * pixel at the end even after a write to the maximum — the product engine is
 * WebKitGTK 4.1, and a reader parked there by a stream of text is at the end in
 * every sense that matters.
 */
const END_EPSILON = 2

export interface UseChatScrollOptions {
  /**
   * The element the turns scroll inside. A ref, because the container does not
   * exist until the transcript has rendered and every entry point here has to
   * survive being called before it is filled.
   */
  container: Ref<HTMLElement | null>
  /**
   * How many turns the transcript holds.
   *
   * Read here rather than told by the send path, because the hint may only count
   * what the list itself can vouch for: a delta in this number *is* a number of
   * messages, while a delta in chunks is not (see {@link ChatScroll.pending}).
   */
  messageCount: () => number
}

export interface ChatScroll {
  /** The container is at its end, as of the last scroll event or correction. */
  atEnd: Ref<boolean>
  /** The reader left the end; content arriving must not move them. Cleared by
   *  their own scroll back to the end, or by {@link jumpToEnd}. */
  suspended: Ref<boolean>
  /**
   * Whole messages that arrived after the reader left the end — the hint's
   * count, and the only number it is allowed to show.
   *
   * Zero while the only thing growing is the answer they had already started
   * reading: that is not a message they have not seen, and "1 new" over the tail
   * of a paragraph they have half read is the inflated count §5.2 forbids. The
   * hint appears either way; the number is what waits for a message.
   */
  pending: Ref<number>
  /**
   * Content reached the log while the reader was away from its end — a turn
   * appended, or more text in the answer being read.
   *
   * This, and not {@link pending}, is what makes the hint appear: the reader is
   * owed *that* something arrived even when it cannot be counted in messages.
   * Cleared when they are at the end again, which is also what makes a stale
   * hint impossible — there is nothing below them to announce.
   */
  arrived: Ref<boolean>
  /** The scroll handler: `@scroll` on the container. */
  onScroll(): void
  /** Content was appended — a turn, or another chunk of the answer being read.
   *  Follows only when the reader has not left the end. */
  follow(): void
  /** Put the container at its end and follow again. For a conversation being
   *  opened (a different transcript is not a position to keep) and for the
   *  reader's own move back to the newest turn. */
  jumpToEnd(): void
}

export function useChatScroll(options: UseChatScrollOptions): ChatScroll {
  // True until a scroll event says otherwise: a transcript with nothing in it,
  // and one being opened, are both at the end.
  const atEnd = ref(true)
  const suspended = ref(false)
  const pending = ref(0)
  const arrived = ref(false)

  /**
   * The offset our own last write asked for, until the scroll event it causes
   * comes back.
   *
   * A browser delivers a programmatic move as a scroll event, and that event is
   * indistinguishable from the reader's except by where it lands — so without
   * this, the write that follows the end of an answer would read back as a
   * reader's scroll and decide something with it. Set only when the write
   * actually changes the offset: a write that changes nothing produces no event,
   * and a value left here would swallow a later real scroll that landed on it.
   */
  let written: number | null = null

  const element = (): HTMLElement | null => options.container.value
  const maxScroll = (el: HTMLElement): number => Math.max(0, el.scrollHeight - el.clientHeight)

  function write(el: HTMLElement, top: number): void {
    const target = Math.max(0, Math.min(top, maxScroll(el)))
    if (el.scrollTop === target) return
    written = target
    el.scrollTop = target
  }

  function pin(el: HTMLElement): void {
    write(el, maxScroll(el))
    atEnd.value = true
  }

  /**
   * Pin, once the append that caused it is in the DOM.
   *
   * One tick of waiting and no more: `scrollHeight` is read after the flush, and
   * a burst of chunks inside one frame schedules several of these that all pin to
   * the same final height — the writes after the first find the offset already
   * there and do nothing.
   */
  function pinAfterRender(): void {
    void nextTick(() => {
      const el = element()
      if (el !== null) pin(el)
    })
  }

  function onScroll(): void {
    const el = element()
    if (el === null) return
    if (written !== null && Math.abs(el.scrollTop - written) <= 1) {
      // Our own move, delivered a frame late. It is not a decision the reader
      // made, so it decides nothing.
      written = null
      return
    }
    written = null
    // "Am I at the end" is asked here, on the reader's own scroll, and nowhere
    // else: asked after the content grew it would answer "no" every time a
    // message streamed, and a transcript that suspends itself on every chunk is
    // the failure this file exists to prevent.
    atEnd.value = maxScroll(el) - el.scrollTop <= END_EPSILON
    suspended.value = !atEnd.value
    // Arriving at the end by any means — a scroll, a keyboard scroll, the hint
    // itself — is the one condition the ruling puts on following again, and it
    // is also what settles the hint: there is nothing below them left to say.
    if (atEnd.value) settle()
  }

  /** The reader is at the end again: nothing below them to announce. */
  function settle(): void {
    arrived.value = false
    pending.value = 0
  }

  /**
   * Content was written into the log. `messages` is how many of those writes were
   * whole turns the reader has not seen at all — a chunk of the answer they left
   * is content, but not a message they have not seen, so it passes zero here.
   *
   * Silent while they are at the end: content they are watching arrive is not
   * content they have to be told about.
   */
  function note(messages: number): void {
    if (!suspended.value) return
    arrived.value = true
    pending.value += messages
  }

  // A growing list is a message arriving, and it is watched rather than
  // announced by the send path because the count has to be the list's own: only
  // a delta in it is a number of messages. Shrinking is skipped by the same
  // guard — a cleared conversation, or an answer that came back empty and was
  // retracted, is not content arriving.
  watch(
    () => options.messageCount(),
    (now, before) => {
      const added = now - before
      if (added > 0) note(added)
    },
    { flush: 'pre' },
  )

  return {
    atEnd,
    suspended,
    pending,
    arrived,
    onScroll,
    follow: () => {
      // The send path's every write — the placeholder, each chunk, the finish —
      // arrives through here, so this is where the hint learns that something
      // reached the log. Content it is, whether or not a turn was added.
      note(0)
      if (!suspended.value) pinAfterRender()
    },
    jumpToEnd: () => {
      suspended.value = false
      atEnd.value = true
      settle()
      pinAfterRender()
    },
  }
}
