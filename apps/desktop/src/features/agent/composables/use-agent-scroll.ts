/**
 * The timeline's scroll policy: follow while the reader is at the end of the log, suspend
 * when they leave it, and hold their reading position when the content above it changes
 * height (§5.2).
 *
 * The rules it implements, and the sentence each comes from:
 *
 *  - 「用户离开底部后不强制跟随；提供新内容提示」— nothing pins the container unless the
 *    reader is at the end, and arrivals the reader is not following are counted
 *    ({@link AgentScroll.pending}) so the panel has something to say about them.
 *  - 「回到底部是明确动作，不抢阅读位置」— the end is reached by the reader's own scroll or
 *    by {@link AgentScroll.resume}. Content arriving never moves a suspended container, and
 *    the correction for a height change is the reading position being *kept*, not the
 *    container being shown something new.
 *  - 「高度变化保持可见内容锚点，长工具输出展开不会把用户推到另一条消息」— the row the
 *    reader is on is recorded at their last scroll and put back after a change, so a tool row
 *    growing three rows above the fold leaves the visible message exactly where it was. The
 *    recording is kept as state rather than taken at the moment of the change because the
 *    changes that need it most are the ones that arrive after the layout has already moved
 *    (a resize re-wraps every row in one pass, and an observer's callback runs after it).
 *  - **following is one fact with one control over it** ({@link AgentScroll.following},
 *    {@link AgentScroll.setFollowing}). The reader's own scroll sets it and a press sets it, and
 *    nothing can leave the panel saying "following" while the container sits somewhere else — a
 *    second boolean a control could set independently of the reader's scroll is how a toggle ends
 *    up at war with the hand on the wheel. Turning it off never moves the container; turning it
 *    on is the same act as {@link AgentScroll.resume}, a move the reader asked for.
 *
 * Deliberately *not* here: any animation. §5.2 forbids per-token animation and this module
 * writes `scrollTop` and nothing else — no easing, no smooth scroll, no reveal. The store's
 * text arrives already coalesced per frame; the scroll follows the text rather than a curve.
 *
 * The composable is the panel's, not the store's: session *state* (the draft, the
 * remembered offset) belongs to the store (§10.2), and this file only decides what
 * the container does about it. It reports where the container ended up through
 * `onPosition` so the caller can keep that per session, and it never decides what a session
 * is — a session switch arrives as a fresh mount with a remembered offset.
 *
 * Two things about reading `scrollTop` are load-bearing, and both are the kind of mistake
 * that only shows up in a real browser:
 *
 *  - a programmatic write causes a scroll event too. Reading our own correction as the
 *    user's hand would suspend a session that was following, or resume one they had left;
 *    {@link written} is how a delivered echo is recognised and ignored as a decision.
 *  - "am I at the end" is only ever asked when a scroll event arrives. Asking it after the
 *    content grew would answer "no" every time a message streamed, and a panel that
 *    suspends itself on every token is the failure this whole file is arranged to avoid.
 */

import { computed, nextTick, onMounted, ref, watch, type Ref } from 'vue'

/**
 * How close to the end still counts as the end.
 *
 * Not zero: WebKitGTK on a fractional device pixel ratio leaves a fraction of a pixel at the
 * end even after a write to the maximum, and a reader parked there by a stream of content is
 * at the end in every sense that matters.
 */
const END_EPSILON = 2

export interface UseAgentScrollOptions {
  /**
   * The element the rows scroll inside. A ref, because the container does not exist before
   * the first render — and every entry point here has to survive being called before it is
   * filled.
   *
   * Its **direct children are the rows**, in order. That is what the anchor is chosen from,
   * and it is the one structural requirement this composable makes of the template.
   */
  container: Ref<HTMLElement | null>
  /**
   * How many rows the timeline is showing. Reading it is how the composable learns that
   * content arrived; the DOM is never inspected for that, because counting rows on every
   * scroll would be a layout read the scroll handler has to pay for.
   */
  rowCount: () => number
  /**
   * Where this session was left, applied once when the composable takes the container. Left
   * out, the session opens at the end — the newest turn is what a session is usually opened
   * for, and a session nobody has read before has no position to restore.
   */
  initialPosition?: number
  /**
   * Where the container ends up, whenever that changes. The caller keeps it per session
   * (§5.1); this module deliberately does not, and does not know what a session is.
   */
  onPosition?: (scrollTop: number) => void
}

export interface AgentScroll {
  /** The container is at its end, as of the last scroll event or correction. */
  atEnd: Ref<boolean>
  /**
   * The reader left the end and content arriving must not move them. Set by their own scroll
   * in either direction — arriving back at the end is itself an explicit action (§5.2) — and
   * cleared by {@link resume}, by {@link setFollowing} or by a {@link restore} to the end.
   */
  suspended: Ref<boolean>
  /**
   * The same fact as {@link suspended}, from the reader's side: are arrivals followed?
   *
   * It is derived rather than stored, and that is the point of it being here at all. Zed's panel
   * carries a *switch* (`render_follow_toggle`, `thread_view.rs:5698`) and ours carried the
   * behaviour without the control; a second boolean that a control could set independently of
   * the reader's own scroll is exactly how a panel ends up fighting the reader — the toggle
   * saying "following" while the container is 3000px away from the end, or arriving content
   * yanking a reader the switch claims to have parked. One fact, two readings of its polarity.
   */
  following: Ref<boolean>
  /**
   * The reader's own switch over that one fact — the control Zed draws and this panel did not.
   *
   * On is {@link resume}: go to the end and follow, which is what turning a follow switch on
   * means. Off parks the log exactly where it is — the container is *not* moved — and records
   * the row the reader is on, because a following container has never needed an anchor and
   * without one the next height change above the fold would move a reader the switch just said
   * it was holding.
   */
  setFollowing: (on: boolean) => void
  /**
   * How many content changes have arrived since the reader left the end. It counts
   * *changes*, not messages: text streaming into the last row is new content too, and saying
   * "3 new" about it would be a number this layer cannot honour.
   */
  pending: Ref<number>
  /** The scroll handler: `@scroll` on the container. */
  onScroll: () => void
  /** Return to the end and follow again — the reader's explicit action, not a hint. */
  resume: () => void
  /**
   * Take the reader to one of the container's own rows, as the transcript's navigation does
   * ("go to my last message").
   *
   * It goes through the same path as a restore, so everything downstream is the same: the write
   * is recognised as ours rather than the reader's hand when the engine delivers its event
   * ({@link written}), the reading position is re-anchored where the reader lands, and a target
   * that *is* the end leaves the container following, because arriving at the end is itself the
   * explicit action §5.2 describes. A row that is not in the container, or one that has been
   * replaced by a re-render, is refused rather than approximated.
   */
  toRow: (row: Element | null) => void
  /** The same act, to the top of the log. The reader asked for it, so it is instant. */
  toTop: () => void
  /**
   * The rows changed height without one arriving: a tool row's output expanded, a link
   * resolved, the panel re-wrapped. Announced **before** the DOM updates — a pre-flush
   * watcher, or an event handler that has just changed the state — because the anchor is
   * measured from the DOM as it was.
   */
  contentChanged: () => void
  /** Apply a remembered offset (a session being shown again). */
  restore: (scrollTop: number) => void
}

export function useAgentScroll(options: UseAgentScrollOptions): AgentScroll {
  const atEnd = ref(true)
  const suspended = ref(false)
  const pending = ref(0)

  /**
   * The offset our own last write asked for, until the scroll event it causes comes back.
   *
   * A browser delivers a programmatic move as a scroll event, and that event is
   * indistinguishable from the reader's except by where it lands. Set only when the write
   * actually changes the offset — a write that changes nothing produces no event, so a value
   * left here would swallow a later real scroll that happened to land on it.
   */
  let written: number | null = null
  /**
   * The row the reader is on, where it sat, and where the container was — recorded at their
   * last scroll and after every correction.
   *
   * It is kept as state rather than measured when a change arrives because the changes that
   * need it most are the ones nobody can see coming: a resize re-wraps every row between one
   * layout pass and the next, and an observer's callback runs *after* that pass, so at the
   * moment the height is known the reading position is already gone. The last moment the
   * reader showed us where they were is the only measurement that predates the change.
   */
  let anchor: { row: Element; offset: number; scrollTop: number } | null = null
  /** The last offset reported, so `onPosition` fires on movement rather than on every scroll
   *  event a trackpad sends. */
  let reported: number | null = null
  /**
   * A remembered position waiting for a transcript to be a position in.
   *
   * A panel mounts before the snapshot it re-subscribed with has rebuilt the rows, and an
   * offset into an empty container is zero whatever it used to be — so the position waits for
   * the first content that arrives rather than being clamped by the container's emptiness.
   */
  let waiting: number | null = null

  const element = (): HTMLElement | null => options.container.value
  const maxScroll = (el: HTMLElement): number => Math.max(0, el.scrollHeight - el.clientHeight)

  function report(el: HTMLElement): void {
    if (options.onPosition === undefined || reported === el.scrollTop) return
    reported = el.scrollTop
    options.onPosition(el.scrollTop)
  }

  function write(el: HTMLElement, top: number): void {
    const target = Math.max(0, Math.min(top, maxScroll(el)))
    if (el.scrollTop === target) return
    written = target
    el.scrollTop = target
  }

  function pin(el: HTMLElement): void {
    write(el, maxScroll(el))
    atEnd.value = true
    report(el)
  }

  function onScroll(): void {
    const el = element()
    if (el === null) return
    const end = maxScroll(el)
    atEnd.value = end - el.scrollTop <= END_EPSILON
    if (written !== null && Math.abs(el.scrollTop - written) <= 1) {
      // Our own move, delivered a frame late. It is not a decision the reader made, so it
      // decides nothing — but the offset it reports is real and still worth remembering.
      written = null
      report(el)
      return
    }
    written = null
    suspended.value = !atEnd.value
    if (suspended.value) recordAnchor()
    else {
      pending.value = 0
      // Nothing to hold: from here the container follows the end, and an anchor kept across
      // that would be a reading position the reader has already left.
      anchor = null
    }
    report(el)
  }

  /** The row the reader's eye is on: the first one whose bottom edge is below the container's
   *  top edge. Null when the container holds no rows at all. */
  function anchorRow(el: HTMLElement): Element | null {
    const top = el.getBoundingClientRect().top
    for (const row of Array.from(el.children)) {
      if (row.getBoundingClientRect().bottom - top > 0) return row
    }
    return null
  }

  function offsetOf(el: HTMLElement, row: Element): number {
    return row.getBoundingClientRect().top - el.getBoundingClientRect().top
  }

  /** Remember where the reader is. Called when they scroll, and after every correction, so the
   *  recorded position is never more than one movement out of date. */
  function recordAnchor(): void {
    const el = element()
    if (el === null) {
      anchor = null
      return
    }
    const row = anchorRow(el)
    anchor = row === null ? null : { row, offset: offsetOf(el, row), scrollTop: el.scrollTop }
  }

  function hold(): void {
    const el = element()
    const held = anchor
    if (el === null || held === null) return
    // A row that has left the DOM has no position to keep, and a correction measured against
    // one would move the reader somewhere arbitrary.
    if (!held.row.isConnected) return
    // The container has moved since the anchor was recorded — a scroll whose event has not
    // been delivered yet, or our own write from the same frame. Whatever moved it, the
    // reading position recorded before that move is no longer the reader's, and correcting
    // against it would be arithmetic applied to a place they have already left.
    if (Math.abs(el.scrollTop - held.scrollTop) > 1) return
    const delta = offsetOf(el, held.row) - held.offset
    if (delta === 0) return
    write(el, el.scrollTop + delta)
    atEnd.value = maxScroll(el) - el.scrollTop <= END_EPSILON
    report(el)
    recordAnchor()
  }

  /**
   * Content changed: hold the reader, or stay at the end.
   *
   * One tick of waiting, because the new heights are not in the DOM when this is called and
   * the correction is measured from them. The anchor it corrects against was recorded before
   * the change, by the reader's own last scroll.
   */
  async function changed(arrived: number): Promise<void> {
    if (arrived > 0 && suspended.value) pending.value += arrived
    await nextTick()
    const el = element()
    if (el === null) return
    const awaited = waiting
    if (awaited !== null && el.children.length > 0) {
      waiting = null
      if (maxScroll(el) >= awaited) {
        // The content the remembered position was waiting for. Taking it is the whole response:
        // this arrival is the transcript coming back, not news arriving under a reader.
        apply(el, awaited)
        return
      }
      // The transcript that came back is shorter than the position in it — there is nowhere to
      // put the reader, so the wait is over and the end is where they land.
    }
    if (suspended.value) hold()
    else {
      pin(el)
      anchor = null
    }
  }

  function resume(): void {
    const el = element()
    if (el === null) return
    // An instant move, and the whole move: §5.2 spends its budget on surfaces arriving, and a
    // long eased ride back to the end is both a distraction from the text and a distance the
    // reader has to wait out. It is a move they asked for, so it is over when they ask.
    suspended.value = false
    pending.value = 0
    pin(el)
  }

  function setFollowing(on: boolean): void {
    if (on) {
      resume()
      return
    }
    const el = element()
    if (el === null) return
    suspended.value = true
    // The hold needs the row the reader is on. A container that has been following never
    // recorded one — there was nothing to hold — and without this the next row that grows
    // above the fold would move a reader this switch has just promised to hold still.
    recordAnchor()
  }

  /** Take a position as the reader's own: everything downstream of a scroll follows from it. */
  function apply(el: HTMLElement, top: number): void {
    write(el, top)
    const end = maxScroll(el)
    atEnd.value = end - el.scrollTop <= END_EPSILON
    suspended.value = !atEnd.value
    if (suspended.value) recordAnchor()
    else {
      pending.value = 0
      anchor = null
    }
    report(el)
  }

  function restore(scrollTop: number): void {
    const el = element()
    if (el === null) return
    if (el.children.length === 0) {
      waiting = scrollTop
      return
    }
    apply(el, scrollTop)
  }

  function toRow(row: Element | null): void {
    const el = element()
    if (el === null || row === null || !row.isConnected) return
    // The row's own position in the container, which is where the reader would see it if they
    // scrolled there themselves. Measured rather than read from `offsetTop`: the row is a plain
    // element and the container's positioning context is the caller's to decide.
    apply(el, el.scrollTop + offsetOf(el, row))
  }

  function toTop(): void {
    const el = element()
    if (el === null) return
    apply(el, 0)
  }

  onMounted(() => {
    if (options.initialPosition === undefined) {
      const el = element()
      if (el !== null) pin(el)
      return
    }
    restore(options.initialPosition)
  })

  // Pre-flush, so an arrival is noticed in the same flush as the render it caused and the
  // correction lands before the browser paints. Arrivals are the only thing watched here; a
  // height change with no row of its own is announced by the timeline through
  // `contentChanged`.
  watch(
    () => options.rowCount(),
    (now, before) => {
      void changed(Math.max(0, now - before))
    },
    { flush: 'pre' },
  )

  return {
    atEnd,
    suspended,
    following: computed(() => !suspended.value),
    pending,
    onScroll,
    resume,
    toRow,
    toTop,
    setFollowing,
    contentChanged: () => {
      void changed(0)
    },
    restore,
  }
}
