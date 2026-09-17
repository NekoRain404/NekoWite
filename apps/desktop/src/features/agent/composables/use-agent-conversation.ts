/**
 * The conversation on screen, as the panel's blocks read it: who is called what, how long the turn
 * has taken, the request it is waiting on, and the two sentences about the record's health.
 *
 * Every value here is *read*, not owned: they are derivations of the store's own view and the
 * session handle, and the file exists so that the panel's template is the place the derivations
 * are *placed* rather than the place they are worked out. Nothing here calls the gateway or writes
 * to the store — the two actions that do (the permission answer and the stop) stay in the panel
 * because they are the store's own.
 *
 * The facts are grouped by the moment they are read, which is why the docblocks below outnumber
 * the expressions: three of them record a decision that is not visible in the code (a title's two
 * sources, a clock that must not start at mount, a status that must not be read as "over").
 */
import { computed, ref, watch, type ComputedRef } from 'vue'
import type { AgentSession, AgentToolStatus } from '../../../platform/gateways/agent-contracts'
import { t } from '../../../i18n'
import type { AgentDropReason } from '../services/agent-event-reducer'
import type { AgentToolEntry } from '../services/agent-timeline'
import type { AgentTurnClock } from '../services/agent-turn-stats'
import { INITIAL_AGENT_TURN_CLOCK, noteRunState } from '../services/agent-turn-stats'
import { isRunLive, type AgentSessionView } from '../services/agent-session-view'

export interface UseAgentConversationOptions {
  /** The session handle this panel is mounted on. Read once — a panel is mounted per session. */
  session: AgentSession
  /** The store's reduced view for that session, or null while nothing has been reduced yet. */
  view: ComputedRef<AgentSessionView | null>
  /** How many frames were refused for this session, and why the last one was. */
  dropped: ComputedRef<number>
  lastDrop: ComputedRef<AgentDropReason | null>
  /**
   * Where this session's transcript was left, if it has been read before — a one-shot read at
   * setup, which is the only moment the record is of any use (see the note in the panel's setup,
   * where the store lookup behind this value stays).
   */
  initialScrollTop: number | undefined
}

export interface AgentConversation {
  /** What this session is called, from whichever of the engine's two statements arrived. */
  title: ComputedRef<string | null>
  /** Where the timeline opens: `undefined` opens it at the end, which is what a first look wants. */
  initialPosition: number | undefined
  /** The refused-frame sentence, or `null` while there is nothing to say. */
  droppedSentence: ComputedRef<string | null>
  /** Whether a run is in flight, so the composer's button is a stop. */
  running: ComputedRef<boolean>
  /** How long the last turn took, or `null` when this window did not see it whole. */
  elapsedMs: ComputedRef<number | null>
  /** The request the reader can answer: the first one bound to the run in flight. */
  pending: ComputedRef<AgentSessionView['permissions'][number] | null>
  /** The transcript's row for the tool call that request is about, when it already has one. */
  pendingToolRow: ComputedRef<AgentToolEntry | null>
  /** That call's status, as the prompt reads it. `null` is "the host knows nothing here". */
  pendingToolStatus: ComputedRef<AgentToolStatus | null>
  /** Whether the request can no longer be answered — the store's own rule, not a second opinion. */
  expired: ComputedRef<boolean>
}

export function useAgentConversation(
  options: UseAgentConversationOptions,
): AgentConversation {
  const { view } = options

  /**
   * What this session is called, taken from whichever of the engine's two statements arrived.
   *
   * The stream's is the newer one and wins: `view.title` is written by `session-changed`, which is
   * the engine saying "this session is called X" *now*. The session's own is the statement that
   * comes with a reopen — `session/list` is the only answer this app has ever been given a session's
   * name in, the load response carries none, and `AgentSession.title` is where the adapter puts the
   * row's own string so the bar a remount draws can show it. Before that fix the bar fell straight
   * through to `labels.untitled` after a resume, so a reader who picked a named row out of the list
   * arrived at a bar saying "New {engine} session" — about the very session whose name they had just
   * read. `null` here is the honest third answer, and the bar has a sentence for it.
   *
   * Read as a prop rather than written into the record's view: the view is rebuilt from the host's
   * snapshot on every mount (`agent-session-snapshot.ts`), and the snapshot has no title field — a
   * seed written there would be wiped by the handshake that follows it.
   *
   * The one thing this cannot express is a frame that *clears* a title: the view's `null` means both
   * "nothing has been said" and "the name was taken away" (`AgentSessionView.title` records that
   * ambiguity itself), so a cleared title would fall back to the name the reopen carried. Nothing
   * can send one today — the frame that would is `SessionInfoUpdate`, which the host does not map —
   * and the alternative, reading only the view, is the defect this replaces: a resumed session
   * drawn as "New {engine} session" while the reader had just read its name in the list.
   */
  const title = computed<string | null>(() => view.value?.title ?? options.session.title)

  /**
   * The refused-frame sentence, or `null` while there is nothing to say.
   *
   * Read from the catalogue here rather than through `labels.notice`, because it has two slots
   * (`{n}` and the reducer's own word) and a slot is filled where the sentence is read — the
   * history menu's ages are read the same way. `dropped` and `lastDrop` are written together by the
   * store, so a count above zero always has a reason to name.
   *
   * The reason travels as the machine's own word, not as a sentence of ours: seven refusals are
   * spelled in `AgentDropReason`, a page that translated them would be inventing seven explanations
   * for states only the reducer can tell apart, and the word is what a bug report needs.
   */
  const droppedSentence = computed<string | null>(() => {
    if (options.dropped.value === 0) return null
    return t('agent.panel.notice.dropped', {
      n: options.dropped.value,
      reason: options.lastDrop.value ?? '',
    })
  })

  /**
   * The composer's own question: is a run in flight, so that its button is a stop. Read from the
   * view through the store's own definition of "live" rather than a second list of states that
   * could drift from it.
   */
  const running = computed(() => view.value !== null && isRunLive(view.value))

  /**
   * How long the last turn took (row 37's elapsed half), measured here because nothing else can:
   * the wire carries no duration — no timestamp on the envelope, no elapsed on `run-finished` — so
   * the only two moments that exist are the view becoming live and the view stopping being live,
   * and this is the component that watches both.
   *
   * **Not `immediate`.** A panel that mounts while a run is already in flight did not see it
   * begin, and a stopwatch started at mount would report the part of the turn this window happened
   * to watch as if it were the whole of it. Starting from {@link INITIAL_AGENT_TURN_CLOCK} and
   * only ever feeding it *transitions* means a turn is timed whole or not at all, and a resumed
   * session shows the tokens the host replayed beside no clock rather than beside a lie.
   *
   * `Date.now()` and not `performance.now()`: the value is compared with nothing and shown as
   * seconds, so a monotonic origin buys nothing, and this is the clock the rest of the panel's
   * faces already read. `services/agent-turn-stats.ts` holds the policy and takes the time as a
   * parameter, which is what keeps it testable without waiting.
   */
  const turnClock = ref<AgentTurnClock>(INITIAL_AGENT_TURN_CLOCK)
  watch(running, (live) => {
    turnClock.value = noteRunState(turnClock.value, live, Date.now())
  })
  const elapsedMs = computed<number | null>(() => turnClock.value.lastMs)

  /**
   * The request the reader can answer: the first one bound to the run in flight.
   *
   * §6.3 binds a request to the turn that asked for it, and the store refuses an answer for a
   * request whose run is not the live one — so showing another turn's request would be offering a
   * button the store will not accept. One at a time is the engine's own arrangement as well: a
   * turn may raise several, and the store stays in `waiting-permission` until the last is answered.
   */
  const pending = computed(() => {
    const held = view.value
    if (held === null) return null
    return held.permissions.find((request) => request.runId === held.runId) ?? null
  })

  /**
   * The transcript's row for the tool call the pending request is about, when it already has one.
   *
   * The join is by `toolCallId`, which is what the contract carries on both sides for exactly this
   * (`AgentPermissionRequest.toolCallId`'s own comment). It is made once, here, and read for the one
   * thing the request does not carry itself: the call's *status*, which arrives on the transcript's
   * frames rather than on the request.
   *
   * **Not for the blocks.** They used to be read off this row and handed to the prompt as a
   * fallback; the request carries its own now (`AgentPermissionRequest.content`), and the row is
   * deliberately not consulted for them — the two can disagree, and a prompt that drew the row's
   * would be showing the reader something other than what the engine asked with.
   */
  const pendingToolRow = computed<AgentToolEntry | null>(() => {
    const request = pending.value
    if (request === null) return null
    // The predicate is the guard, not only the test: without it `find` answers with the whole
    // `AgentTimelineEntry` union and `status` is a property of one member. `AgentToolEntry` carries
    // it as a required field, so nothing here is being widened — the row that was selected is
    // narrowed to the kind it was selected by.
    const row = view.value?.timeline.find(
      (entry): entry is AgentToolEntry =>
        entry.kind === 'tool' && entry.toolCallId === request.payload.toolCallId,
    )
    return row ?? null
  })

  /**
   * The status of that call, as the prompt reads it.
   *
   * `null` is "the host knows nothing here", which the prompt must not read as "this call is
   * over": a request whose row has not arrived yet is still waiting for its answer.
   */
  const pendingToolStatus = computed<AgentToolStatus | null>(
    () => pendingToolRow.value?.status ?? null,
  )

  /** Whether the request can no longer be answered — the store's own rule, not a second opinion:
   *  an answer for a request whose run is not live is refused there. */
  const expired = computed(() => view.value === null || !isRunLive(view.value))

  return {
    title,
    initialPosition: options.initialScrollTop,
    droppedSentence,
    running,
    elapsedMs,
    pending,
    pendingToolRow,
    pendingToolStatus,
    expired,
  }
}
