/**
 * The transcript's find bar as state: whether it is up, what is in its box, where the hits are,
 * which of them the reader is on, and what landing on one does to the container.
 *
 * It is here rather than in `AgentTimeline.vue` because it is one subject with its own rules
 * rather than a slice of drawing rows — the same kind of move `use-agent-scroll` made out of the
 * same file. Three files, three jobs, and the dividing line between them is what each one may
 * decide: `services/agent-conversation-search.ts` decides what a query matches and where in each
 * string the hit sits; `components/AgentTimelineSearch.vue` draws the field, the count and the two
 * arrows and decides nothing; this file is the state between them — where a hit is *painted*,
 * which one the reader is on, and what landing on one does to the container.
 *
 * The bar is the one control on this transcript that searches rather than scrolls: a reader
 * looking for a line they remember across a long turn has no other way to it. The rules that shape
 * it are stated here because the code they explain is here, and all three are rulings rather than
 * choices:
 *
 *  - **landing on a hit is the reader's move and nothing else.** Typing, the arrows and opening
 *    the bar are what may move the container; a rescan is not. The engine streams into the last
 *    row of a live turn, which rebuilds the rows on every frame, and a scan that scrolled on each
 *    of those frames would be the container fighting the hand that owns it — the same failure
 *    §5.2 names for a resize. Zed scrolls when the hit the reader was on is gone
 *    (`thread_search_bar.rs:493-494`); here a lost hit moves the *index* and leaves the container
 *    where the reader put it.
 *  - **the move is one instant write, through the scroll composable's own `toRow`.** No easing,
 *    nothing to interrupt, and the same path the two jump controls already take — so a wheel that
 *    arrives mid-flight is not fought (there is no flight), and everything downstream of a scroll
 *    happens exactly as it does for the reader's own hand: the anchor is re-recorded, and
 *    following is suspended because they are no longer at the end. That suspension is the ruling
 *    working, not a side effect: content arriving while the reader is on a hit must not take them
 *    away from it.
 *  - **a hit inside folded reasoning unfolds it.** Reasoning is collapsed by default and it is
 *    searched anyway (the service's header says why); a hit the reader is taken to has to be a hit
 *    they can see, so the row opens on the way in. The open is the reader's own — they asked to go
 *    to the word — and the height change it makes is corrected by the move that follows it rather
 *    than by a `contentChanged`, which is what `contentChanged` is for a reader who is NOT moving.
 *
 * What it deliberately does not do: decide what matches (the service), decide what the bar looks
 * like (the bar's own component), or own `scrollTop` (the scroll composable, which is taken as an
 * argument rather than reached for). And nothing here reads a store — the rows arrive through
 * `rows`, the way the scroll composable takes its container.
 */
import { computed, nextTick, ref, watch, type ComputedRef, type Ref } from 'vue'
import AgentTimelineSearch from '../components/AgentTimelineSearch.vue'
import type { AgentScroll } from './use-agent-scroll'
import {
  activeHitIndex,
  findConversationHits,
  hitKey,
  stepHitIndex,
  type AgentHit,
  type AgentHitField,
  type AgentHitRange,
} from '../services/agent-conversation-search'
import type { AgentTimelineEntry } from '../services/agent-timeline'

export interface UseAgentFindBarOptions {
  /**
   * The element the rows scroll inside — the same ref the scroll composable takes. The element a
   * hit is drawn as is found by querying it, and closing the bar gives it the focus back.
   */
  container: Ref<HTMLElement | null>
  /**
   * One session's rows, oldest first, as the store holds them.
   *
   * A getter rather than an array, because a live turn replaces the list on every frame: both a
   * rescan and the move that follows one read the rows at the moment they run.
   */
  rows: () => readonly AgentTimelineEntry[]
  /**
   * The scroll policy the landing move goes through, and the height changes the bar's own opening
   * and closing make. Narrowed to the two entries this file uses, so what it may do to the
   * container is what it says here.
   */
  scroll: Pick<AgentScroll, 'toRow' | 'contentChanged'>
  /**
   * Open one of the transcript's folded reasoning rows, by row id.
   *
   * Idempotent, and it must not announce a height change: the landing move is the one caller, and
   * it is the case where that announcement would be wrong.
   */
  unfold: (rowId: number) => void
  /**
   * The bar's own component, which the caller renders and binds with `ref`.
   *
   * Handed in for the same reason `use-detached-popup`'s `trigger` is: it is an element the
   * caller's *template* owns, and a composable cannot bind a template ref for markup it does not
   * render.
   */
  bar: Ref<InstanceType<typeof AgentTimelineSearch> | null>
}

export interface AgentFindBar {
  /** Whether the bar is on screen. */
  searching: Ref<boolean>
  /** What is in the box. */
  query: Ref<string>
  /** Which hit the reader is on, zero-based, or -1 when there is none. */
  active: Ref<number>
  /** How many hits the query has. `0` with a non-empty query is the bar's no-match state. */
  total: ComputedRef<number>
  /** The ranges one string of one row draws, or `undefined`. */
  hitsFor(rowId: number, field: AgentHitField): readonly AgentHitRange[] | undefined
  /** Which of that string's ranges the reader is on, or -1 when it is another row's hit. */
  activeFor(rowId: number, field: AgentHitField): number
  /** Step to the next (`+1`) or previous (`-1`) hit, wrapping — and go to it. */
  go(delta: number): void
  /** Close it, and take the marks with it. The bar's own ✕ is the caller. */
  close(): void
  /** The control row's own press: the bar is a toggle, so the same control gives the height back. */
  toggle(): void
}

export function useAgentFindBar(options: UseAgentFindBarOptions): AgentFindBar {
  /** Whether the bar is on screen. The transcript's own state: a session switch re-mounts the
   *  component that owns this (`AgentPanel.vue` keys it by session), so the search does not outlive
   *  its rows. */
  const searching = ref(false)
  const query = ref('')
  /** The hits the current query has, in the order the rows are drawn. */
  const hits = ref<readonly AgentHit[]>([])
  /** Which of them the reader is on, or -1. */
  const active = ref(-1)

  /** The key both the marks and the active one are addressed by: one string of one row. */
  function markKey(rowId: number, field: AgentHitField): string {
    return `${rowId}:${field}`
  }

  /**
   * The ranges every marked string draws, keyed by `rowId:field`.
   *
   * Built once per rescan rather than per render, so a row no hit is in answers with one shared
   * `undefined` frame after frame and is not re-rendered by a search that does not touch it. That
   * matters here more than anywhere else in the transcript: a live turn rebuilds the row list on
   * every frame, and a search that re-rendered forty tool rows per frame to move one highlight
   * would be paying the panel's whole budget for it.
   */
  const marks = computed(() => {
    const byField = new Map<string, AgentHitRange[]>()
    for (const hit of hits.value) {
      const key = markKey(hit.rowId, hit.field)
      const ranges = byField.get(key)
      if (ranges === undefined) byField.set(key, [{ start: hit.start, end: hit.end }])
      else ranges.push({ start: hit.start, end: hit.end })
    }
    return byField
  })

  /** Where the active hit sits *within its own string*, which is what the marked element is
   *  chosen by — the transcript draws the string, so that is the local index the mark needs. */
  const activeMark = computed(() => {
    const hit = hits.value[active.value]
    if (hit === undefined) return null
    const key = markKey(hit.rowId, hit.field)
    let index = 0
    for (let at = 0; at < active.value; at += 1) {
      if (markKey(hits.value[at].rowId, hits.value[at].field) === key) index += 1
    }
    return { key, index }
  })

  /** The ranges one string of one row draws, or `undefined` — see {@link marks}. */
  function hitsFor(rowId: number, field: AgentHitField): readonly AgentHitRange[] | undefined {
    return marks.value.get(markKey(rowId, field))
  }

  /** Which of that string's ranges the reader is on, or -1 when it is another row's hit. */
  function activeFor(rowId: number, field: AgentHitField): number {
    const mark = activeMark.value
    return mark !== null && mark.key === markKey(rowId, field) ? mark.index : -1
  }

  /**
   * Take the reader to the row the active hit is in — or to the hit itself, which is what this
   * passes to `toRow`: the marked element is the hit's own line, and the container's top edge is
   * where a reader looks after asking for a line.
   */
  async function reveal(): Promise<void> {
    const hit = hits.value[active.value]
    if (hit === undefined) return
    const row = options.rows().find((candidate) => candidate.id === hit.rowId)
    if (row !== undefined && row.kind === 'thought') {
      // Folded reasoning: the hit is inside text that is not drawn yet, and the reader asked to be
      // taken to it. Unfolding is the only way there — and it is not the transcript's own
      // `toggleThought`, because that also announces a height change for a reader who is staying
      // put, and this reader is leaving. The opening is idempotent on the other side: a hit in a
      // row that is already open has nothing to unfold.
      options.unfold(row.id)
    }
    // One tick, always: the marks are painted by the flush this rescan caused, and querying the DOM
    // before it would look for an element the browser has not built yet.
    await nextTick()
    options.scroll.toRow(
      options.container.value?.querySelector('[data-agent-hit="active"]') ?? null,
    )
  }

  /**
   * Re-run the query over the rows, and say whether the reader's hit survived.
   *
   * `move` is the reader's own act — a keystroke, an arrow, the bar opening — and it is the only
   * thing that may move the container. A rescan caused by content arriving passes `false` and never
   * moves, whatever the hits do.
   */
  function rescan(move: boolean): void {
    const previous = hits.value[active.value]
    hits.value = findConversationHits(options.rows(), query.value)
    const resolved = activeHitIndex(hits.value, previous === undefined ? null : hitKey(previous))
    active.value = resolved.index
    if (move && !resolved.preserved) void reveal()
  }

  /** Step to the next (`+1`) or previous (`-1`) hit, wrapping — and go to it. */
  function go(delta: number): void {
    active.value = stepHitIndex(active.value, hits.value.length, delta)
    void reveal()
  }

  /**
   * Open the bar — reached through {@link toggle}, which is the control row's press and the only
   * gesture there is. Not on the returned interface for that reason: nothing outside this file
   * opens the bar directly, and a member no caller uses is a surface this project keeps finding
   * and deleting.
   *
   * `contentChanged` is announced *before* the bar's row is added, because the transcript below it
   * loses that height in the same flush and the scroll composable's anchor is measured from the DOM
   * as it was (§5.2 「高度变化保持可见内容锚点」). The reader is not searching yet, so this is the
   * one moment the change must not move them.
   */
  function open(): void {
    searching.value = true
    options.scroll.contentChanged()
    void nextTick(() => options.bar.value?.focus())
  }

  /**
   * Close it, and take the marks with it.
   *
   * The query goes rather than being kept for next time: every mark on the transcript is drawn from
   * it, and a bar that is gone while its hits still glow would be highlighting the reader has no
   * control left to explain. Focus goes to the log, which is where they were reading.
   */
  function close(): void {
    searching.value = false
    query.value = ''
    options.scroll.contentChanged()
    options.container.value?.focus()
  }

  /** The control row's own press: the bar is a toggle, so the same control gives the height back. */
  function toggle(): void {
    if (searching.value) close()
    else open()
  }

  // The two things that make the hits stale. A query the reader typed is their own act and lands on
  // its first hit; content arriving is not, and must leave the container alone — the rule this
  // file's header states in full.
  watch(query, () => rescan(true))
  watch(
    () => options.rows(),
    () => {
      if (searching.value) rescan(false)
    },
  )

  return {
    searching,
    query,
    active,
    total: computed(() => hits.value.length),
    hitsFor,
    activeFor,
    go,
    close,
    toggle,
  }
}
