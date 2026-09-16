/**
 * The agent session store: the per-session state the panel renders, and the calls that
 * change it.
 *
 * It holds the state and the actions over it (§10.2: stores, queries and commands stay
 * separate). Everything that has to be *decided* about an event is in the reducer; this
 * file is the part that talks to a gateway and the part that remembers what belongs to one
 * session rather than to a window: the draft, the scroll position and the unread flag
 * (§5.1 「每会话独立草稿、滚动位置和未读状态」).
 *
 * The gateway arrives as an argument rather than an import. This module is where the
 * feature meets whichever adapter is behind `AgentGateway`, and the adapter is chosen at
 * the composition site; nothing here knows whether it is the memory double or the real
 * runtime, and nothing here imports a Tauri API (§6.1).
 *
 * One subscription per session, not one for the window: the gateway delivers events per
 * session, a session outlives being looked at (§5.1: a task keeps running while the panel
 * is collapsed), and the store must be able to say which session a frame was refused for.
 *
 * ## Ordering, where it is load-bearing
 *
 * Every action that both changes the view and calls the gateway applies the view change
 * *first*. That is not an optimisation: the engine's reaction can be delivered before the
 * call returns — a suspended turn resumes on the tick its answer wakes it, and the memory
 * double pushes `run-finished` before the promise the caller awaits has settled — so
 * committing afterwards would overwrite the run's own ending with a state that is already
 * out of date. Applying first also means an event that races the call lands in a view that
 * already knows a run is in flight, which is what stops the run's opening frames from being
 * refused as an illegal transition.
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AgentEvent,
  AgentGateway,
  AgentIdentity,
  AgentSession,
  AgentSessionState,
} from '../../../platform/gateways/agent-contracts'
import { reduceAgentEvent, type AgentDropReason, type AgentReduction } from '../services/agent-event-reducer'
import {
  closeSubscription,
  createSubscription,
  describeFailure,
  openSubscription,
  type AgentSubscription,
} from '../services/agent-session-subscription'
import {
  failAgentRun,
  initialAgentSessionView,
  isRunLive,
  resolvePermission,
  sessionKey,
  startAgentRun,
  type AgentSessionView,
} from '../services/agent-session-view'

/**
 * Everything the panel knows about one session.
 *
 * The view is what the events reduced to; the other fields are session-scoped UI state
 * that no event carries. The drop counters are here because the lifecycle spec's reading of
 * Zed found its stale-connection guard discarding a superseded result with no log, no
 * metric and no trace — a frame refused *here* is counted and its reason remembered, so a
 * window that is quietly dropping frames is one a test or a bug report can see.
 */
export interface AgentSessionRecord {
  readonly identity: AgentIdentity
  view: AgentSessionView
  /** The half-written message, kept per session so looking away and back does not lose it.
   *  Only a send that was accepted clears it — an error does not (§5.1). */
  draft: string
  scrollTop: number
  /** Set when something was applied for this session while another one was on screen. */
  unread: boolean
  dropped: number
  lastDrop: AgentDropReason | null
}

/** What became of a send. A refusal is a value rather than a throw: the caller has
 *  something to do with it — keep the text. */
export type AgentSendOutcome =
  | { accepted: true }
  | { accepted: false; reason: 'run-in-flight' | 'no-session' }

/** What became of an answer to a permission request. */
export type AgentAnswerOutcome =
  | { accepted: true }
  | { accepted: false; reason: 'not-pending' | 'no-session' }

export const useAgentSessionStore = defineStore('agentSession', () => {
  const records = ref<Record<string, AgentSessionRecord>>({})
  const activeKey = ref<string | null>(null)
  /** Frames that named a session this store is not holding: one it never opened, one it has
   *  detached and closed, or one whose identity has drifted (another vault, another runtime
   *  instance). Counted rather than dropped in silence, for the reason the per-session drop
   *  counters exist — the lifecycle spec's reading of Zed found its equivalent guard
   *  discarding a superseded frame with no log, no metric and no trace. */
  const unattributed = ref(0)
  /** The subscriptions, one per session. Not reactive: these are handles, not state. */
  const subscriptions = new Map<string, AgentSubscription>()

  const activeRecord = computed(() =>
    activeKey.value === null ? null : (records.value[activeKey.value] ?? null),
  )
  const activeView = computed<AgentSessionView | null>(() => activeRecord.value?.view ?? null)
  const activeState = computed<AgentSessionState | null>(() => activeRecord.value?.view.state ?? null)
  /** §6.2's one active generation, as the composer sees it: a second send while a run is
   *  live is refused rather than queued into the engine. */
  const canSend = computed(() => activeRecord.value !== null && !isRunLive(activeRecord.value.view))

  function recordFor(key: string | null): AgentSessionRecord | null {
    return key === null ? null : (records.value[key] ?? null)
  }

  /** The record for a session, created on first sight. */
  function ensureRecord(identity: AgentIdentity): AgentSessionRecord {
    const key = sessionKey(identity)
    const existing = records.value[key]
    if (existing !== undefined) return existing
    const record: AgentSessionRecord = {
      identity,
      view: initialAgentSessionView(identity),
      draft: '',
      scrollTop: 0,
      unread: false,
      dropped: 0,
      lastDrop: null,
    }
    records.value[key] = record
    return record
  }

  /**
   * One event from the gateway.
   *
   * The event names the session it belongs to, and the composite key is how this store
   * finds it. A session that has been detached keeps its record — the panel can show what
   * it last knew — but a frame for a session this window never held is not this store's to
   * apply, and it is dropped here rather than in the reducer, because there is no view for
   * it to have been judged against.
   */
  function onEvent(event: AgentEvent): void {
    const key = sessionKey(event)
    const record = records.value[key]
    if (record === undefined) {
      // The composite key names a session this store is not holding. That check is the same
      // boundary the reducer enforces per event, one level up — and it is deliberately the
      // *composite* key rather than the session id, because the session id alone cannot tell
      // a runtime instance from the next one.
      unattributed.value += 1
      return
    }
    const reduced: AgentReduction = reduceAgentEvent(record.view, event)
    record.view = reduced.view
    if (reduced.outcome.status === 'dropped') {
      record.dropped += 1
      record.lastDrop = reduced.outcome.reason
      return
    }
    if (key !== activeKey.value) record.unread = true
    if (reduced.outcome.status === 'aborted') {
      // §6.2: over a bound the run is aborted *and reported*. The view is reported already
      // — the reducer closed it — and this is the engine being stopped, so the abort is not
      // a label on a run that is still producing frames.
      void cancel(key)
    }
  }

  /**
   * Subscribe to a session: snapshot, adopt, subscribe.
   *
   * The handshake itself is in `services/agent-session-subscription.ts`; what is left here is
   * which record it belongs to and where the result goes.
   */
  async function attach(gateway: AgentGateway, session: AgentSession): Promise<void> {
    const key = sessionKey(session)
    detach(key)
    const record = ensureRecord(session)
    const subscription = createSubscription(gateway, session)
    subscriptions.set(key, subscription)
    record.view = await openSubscription(subscription, record.view, 'adopt', onEvent)
  }

  function subscriptionFor(key: string | null): AgentSubscription | null {
    return key === null ? null : (subscriptions.get(key) ?? null)
  }

  /** Stop receiving one session's events. */
  function detach(key: string): void {
    const subscription = subscriptions.get(key)
    if (subscription === undefined) return
    closeSubscription(subscription)
    subscriptions.delete(key)
  }

  function detachAll(): void {
    for (const key of [...subscriptions.keys()]) detach(key)
  }

  async function resync(key: string): Promise<void> {
    const record = recordFor(key)
    const subscription = subscriptionFor(key)
    if (record === null || subscription === null) return
    record.view = await openSubscription(subscription, record.view, 'repair', onEvent)
  }

  /** Run one gateway call against a record, and record a rejection as the failure it is.
   *
   *  Every rejection here means the same thing to the view: the call the host made could
   *  not be completed, so the run it belonged to is not running any more. Folding them into
   *  one path is what keeps a rejected call from leaving a `running` view over a run nothing
   *  is executing — the failure the lifecycle spec found in Zed, where a dead agent leaves a
   *  thread marked as running. */
  async function guarded(record: AgentSessionRecord, call: () => Promise<void>): Promise<void> {
    try {
      await call()
    } catch (error) {
      const failure = describeFailure(error)
      record.view = failAgentRun(record.view, failure.code, failure.message)
    }
  }

  /**
   * Send one turn.
   *
   * Refused while a run is live, and the text is kept as the draft rather than queued into
   * the engine — §6.2 allows one active generation per session, and quietly calling the
   * same session twice is exactly what it forbids.
   */
  async function send(text: string): Promise<AgentSendOutcome> {
    const key = activeKey.value
    const live = subscriptionFor(key)
    const record = recordFor(key)
    if (live === null || record === null) return { accepted: false, reason: 'no-session' }
    const started = startAgentRun(record.view, text)
    if (!started.accepted) {
      record.draft = text
      return { accepted: false, reason: 'run-in-flight' }
    }
    record.view = started.view
    // The text has moved into the timeline as the user's own row, so the composer's copy
    // goes. A *refused* send above leaves the draft exactly where it was.
    record.draft = ''
    try {
      await live.gateway.prompt(live.session, text)
    } catch (error) {
      const failure = describeFailure(error)
      record.view = failAgentRun(record.view, failure.code, failure.message)
      // The turn was never delivered, so the text goes back to the composer: it did not
      // reach the engine, and §5.1's rule is that an error does not take the user's words
      // from them. Only when the draft is still empty — anything typed since the send is
      // newer than this message and must not be overwritten.
      if (record.draft === '') record.draft = text
    }
    return { accepted: true }
  }

  /**
   * Ask the engine to end the run in flight.
   *
   * The view is *not* moved to `cancelled` here. Cancelling is a request — the protocol
   * sends a notification and awaits no acknowledgement — and the run ends when the engine
   * says it did, through `run-finished`. Marking it locally would be the host claiming an
   * ending it has not been told about, and §6.2's blocking condition is precisely a cancel
   * that does not end the task. Allowed while a permission is pending (§6.2), which is why
   * it does not ask what the run is doing.
   */
  async function cancel(key: string): Promise<void> {
    const live = subscriptionFor(key)
    const record = recordFor(key)
    if (live === null || record === null) return
    await guarded(record, () => live.gateway.cancel(live.session))
  }

  /**
   * Answer the permission request the user is looking at.
   *
   * The transition is applied before the call, for the ordering reason in this file's
   * header. It is also what makes a second click cheap: the request is no longer in the
   * view, so the repeat never reaches the gateway. Everything the gateway can refuse an
   * answer for — a request that is no longer pending, one whose turn is over — means the
   * request was dead anyway, so leaving it cleared is right.
   */
  async function answer(requestId: string, optionId: string): Promise<AgentAnswerOutcome> {
    const key = activeKey.value
    const live = subscriptionFor(key)
    const record = recordFor(key)
    if (live === null || record === null) return { accepted: false, reason: 'no-session' }
    const resolved = resolvePermission(record.view, requestId)
    if (!resolved.accepted) return { accepted: false, reason: 'not-pending' }
    record.view = resolved.view
    // A turn suspended on a question the host will not accept cannot go on, so a rejection
    // here is the run's failure rather than a UI detail to hide.
    await guarded(record, () => live.gateway.answerPermission(live.session, requestId, optionId))
    return { accepted: true }
  }

  /** Put a session's record on screen. Reading it is what clears its unread flag. */
  function focus(key: string | null): void {
    activeKey.value = key
    if (key !== null) markRead(key)
  }

  function setDraft(key: string, text: string): void {
    const record = recordFor(key)
    if (record !== null) record.draft = text
  }

  function setScroll(key: string, scrollTop: number): void {
    const record = recordFor(key)
    if (record !== null) record.scrollTop = scrollTop
  }

  function markRead(key: string): void {
    const record = recordFor(key)
    if (record !== null) record.unread = false
  }

  return {
    records,
    activeKey,
    unattributed,
    activeRecord,
    activeView,
    activeState,
    canSend,
    recordFor,
    attach,
    detach,
    detachAll,
    send,
    cancel,
    answer,
    resync,
    focus,
    setDraft,
    setScroll,
    markRead,
  }
})
