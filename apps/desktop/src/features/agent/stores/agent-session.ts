/**
 * The agent session store: the per-session state the panel renders, and the calls that
 * change it.
 *
 * It holds the state and the actions over it (§10.2: stores, queries and commands stay
 * separate). Everything that has to be *decided* about an event is in the reducer; this
 * file is the part that talks to a gateway and the part that remembers what belongs to one
 * session rather than to a window: the draft and the scroll position
 * (§5.1 「每会话独立草稿、滚动位置」).
 *
 * **There is no session in front here, and that is a decision with a history.** The store used to
 * carry one — `activeKey`, written by `focus`, with `activeRecord`/`activeView`/`activeState`/
 * `canSend` derived from it — for the surfaces that "have no session of their own". Every one of
 * them turned out to have one: the panel is mounted with a session, the editor pane is handed the
 * rail's own on a prop, and the note surface is handed the same one. What was left was a second,
 * mutable answer to "which session is this window on" — and the pet's task link
 * (`app/pet-task-link.ts`) could move it while the rail kept the session on screen, so the store
 * and the screen could name two different sessions. Three surfaces were written against that
 * pointer and every one of them was wrong in a different way (a send to a conversation nobody was
 * looking at, a workspace from another vault, an edit applied under a session the proposal was
 * never produced for); this file no longer offers it. What is in front is the rail's `live` state
 * (`app/agent-rail.ts`), which is also what mounts the panel — one owner, one remount under a new
 * `railKey`, and no pointer for a click to move.
 *
 * The per-session `unread` flag lived here too and was deleted first, for the same reason: it had
 * no renderer a reader could reach (the only surface that could draw "a session you are not
 * looking at received something" is a list of the window's own sessions, and there is none), and
 * its one reachable setter put the mark on the session that *was* on screen.
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
 *
 * The handshake is held to the same rule, from the other side: it publishes the snapshot it
 * was given *before* the subscription that continues from it exists, so the frames the
 * subscription delivers land on top of it. See `agent-session-subscription.ts`, which owns
 * that order — and the other half of it, that a retired attempt registers nothing and releases
 * whatever the host hands it. What this file owes it is the view as it is *now*:
 * {@link handshakeOn} reads the record at the moment of the write, never one captured before
 * an await.
 */

import { ref } from 'vue'
import { defineStore } from 'pinia'
import { AgentFailure } from '../../../platform/gateways/agent-contracts'
import type {
  AgentChangeRecovery,
  AgentConfigOption,
  AgentEvent,
  AgentGateway,
  AgentIdentity,
  AgentPromptAttachment,
  AgentSession,
} from '../../../platform/gateways/agent-contracts'
import { reduceAgentEvent, type AgentDropReason, type AgentReduction } from '../services/agent-event-reducer'
import {
  closeSubscription,
  createSubscription,
  describeFailure,
  openSubscription,
  type AgentHandshakeTarget,
  type AgentSubscription,
} from '../services/agent-session-subscription'
import {
  failAgentRun,
  initialAgentSessionView,
  resolvePermission,
  sessionKey,
  startAgentRun,
  type AgentSessionView,
} from '../services/agent-session-view'
import type { AgentLiveNote } from '../services/agent-context-snapshot'
import {
  captureEditBaselines,
  type AgentEditBaseline,
  type AgentEditRefusal,
} from '../services/agent-edit-apply'

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
  dropped: number
  lastDrop: AgentDropReason | null
  /**
   * The version each note the request names held when the request was submitted.
   *
   * Read at the send — not when the answer arrives, and not when the note was attached to the
   * prompt — because that is the document the run is answering about, and an answer that lands
   * over anything newer is the silent overwrite `agent-edit-apply.ts` exists to prevent. The
   * list belongs to the run that was dispatched and outlives it: a run that has finished is
   * still one whose result may be applied minutes later.
   */
  edits: readonly AgentEditBaseline[]
}

/** What became of a send. A refusal is a value rather than a throw: the caller has
 *  something to do with it — keep the text. */
export type AgentSendOutcome =
  /** `refusedEdits` is per target, not per send: a note from another vault is not context this
   *  session can see (§6.2), and the prompt itself is the user's and goes out either way. */
  | { accepted: true; refusedEdits: readonly AgentEditRefusal[] }
  | { accepted: false; reason: 'run-in-flight' | 'no-session' }

/** What became of an answer to a permission request. */
export type AgentAnswerOutcome =
  | { accepted: true }
  | { accepted: false; reason: 'not-pending' | 'no-session' }

export const useAgentSessionStore = defineStore('agentSession', () => {
  const records = ref<Record<string, AgentSessionRecord>>({})
  /** The subscriptions, one per session. Not reactive: these are handles, not state. */
  const subscriptions = new Map<string, AgentSubscription>()

  /**
   * The frames this store applied, frame by frame, to whoever needs the events themselves.
   *
   * A listener hears an event only after the reducer has applied it to the record it belongs to,
   * so nothing downstream can run ahead of the panel. Nothing else is reported: a frame for a
   * session this store is not holding, and one the reducer refused, are not delivered at all —
   * two consumers disagreeing about what happened is the failure this avoids.
   *
   * It exists because one fact is not derivable from the view. T8's `/` menu tells "this session
   * has published nothing yet" apart from "the engine published an empty list", and the view
   * reports both as an empty `commands` array; feeding the menu the frames keeps that distinction
   * where the composable already models it, instead of adding a second flag to the view and a
   * second reading of the same event.
   */
  const eventListeners = new Set<(event: AgentEvent) => void>()

  /** Hear every event this store applies. The answer is the unsubscribe. */
  function observeEvents(listener: (event: AgentEvent) => void): () => void {
    eventListeners.add(listener)
    return () => {
      eventListeners.delete(listener)
    }
  }

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
      dropped: 0,
      lastDrop: null,
      edits: Object.freeze([]),
    }
    records.value[key] = record
    // **The record as the rest of the store reaches it, not the object that was just built.**
    // `records` is a `ref`, so what a reader can see is the proxy `records.value[key]` hands out,
    // and a write to the raw object behind it changes the data without telling anything that is
    // watching. That is not a subtlety — it is the difference between a panel that redraws and one
    // that does not, and the panel it broke is the one that mounts on a **reopened** session: its
    // whole transcript arrives in the snapshot the handshake commits, and a commit through the raw
    // record left the render holding the empty view it was born with, so a restored conversation
    // was on screen nowhere until some later frame happened to touch the same record. A new
    // session hid it, because its snapshot is empty and the frames that fill it arrive after the
    // mount through `onEvent`, which reads the proxy.
    return records.value[key]
  }

  /**
   * One event from the gateway.
   *
   * The event names the session it belongs to, and the composite key is how this store
   * finds it. A session that has been detached keeps its record — the panel can show what
   * it last knew — but a frame for a session this window never held is not this store's to
   * apply, and it is dropped here rather than in the reducer, because there is no view for
   * it to have been judged against.
   *
   * **The drop is reported in the console and counted nowhere.** It used to be a store member
   * (`unattributed`), written and read by nobody but tests: no surface of this window can render
   * "a frame arrived for a session you are not holding", because the only one that could is a list
   * of the window's own sessions and there is none. The frames that reach here are a mismatch
   * between the host's identity stamp and the one this window subscribed with — the state the
   * lifecycle spec's reading of Zed found its guard discarding in silence — so the fact stays
   * reported, in the one place a bug report can read it, and stops pretending to be a control.
   */
  function onEvent(event: AgentEvent): void {
    const key = sessionKey(event)
    const record = records.value[key]
    if (record === undefined) {
      // The composite key names a session this store is not holding. That check is the same
      // boundary the reducer enforces per event, one level up — and it is deliberately the
      // *composite* key rather than the session id, because the session id alone cannot tell
      // a runtime instance from the next one.
      console.warn(
        `[NekoWite] a ${event.kind} frame named a session this window is not holding (${event.vaultId} / ${event.sessionId}), so it was dropped`,
        event,
      )
      return
    }
    const reduced: AgentReduction = reduceAgentEvent(record.view, event)
    record.view = reduced.view
    if (reduced.outcome.status === 'dropped') {
      record.dropped += 1
      record.lastDrop = reduced.outcome.reason
      return
    }
    // Copied before the walk: a listener that unsubscribed while another was being called would
    // otherwise change the set under the iteration.
    for (const listener of [...eventListeners]) listener(event)
    if (reduced.outcome.status === 'aborted') {
      // §6.2: over a bound the run is aborted *and reported*. The view is reported already
      // — the reducer closed it — and this is the engine being stopped, so the abort is not
      // a label on a run that is still producing frames.
      void cancel(key)
    }
  }

  /**
   * Where a handshake reads the view it is re-establishing, and where its result goes.
   *
   * The record is captured, its view is not: a handshake must decide against the view as it
   * is when the snapshot lands, because frames that arrived while it was waiting were applied
   * to that view and an older snapshot must not overwrite them. The record itself is stable —
   * a detached session keeps its record so the panel can still show what it last knew.
   */
  function handshakeOn(record: AgentSessionRecord): AgentHandshakeTarget {
    return {
      view: () => record.view,
      commit: (view) => {
        record.view = view
      },
    }
  }

  /**
   * Subscribe to a session: snapshot, publish, subscribe.
   *
   * The handshake itself is in `services/agent-session-subscription.ts`; what is left here is
   * which record it belongs to. `detach` first, because subscribing is one attempt per
   * session: whatever was being listened to — or was still being established — is retired
   * before this attempt begins, so the two can never both be applied.
   *
   * It does not reject. What the host refuses is recorded on the view, and an attempt the
   * store retires while it waits publishes nothing; one retired while the host is answering
   * releases the listener it was handed rather than installing it. A caller is a component's
   * mount (`useAgentSession` fires it with no reader for a rejection), and the panel closing is
   * an ordinary way for an attempt to end.
   */
  async function attach(gateway: AgentGateway, session: AgentSession): Promise<void> {
    const key = sessionKey(session)
    detach(key)
    const record = ensureRecord(session)
    const subscription = createSubscription(gateway, session)
    subscriptions.set(key, subscription)
    await openSubscription(subscription, handshakeOn(record), onEvent)
  }

  function subscriptionFor(key: string | null): AgentSubscription | null {
    return key === null ? null : (subscriptions.get(key) ?? null)
  }

  /** Stop receiving one session's events — including one still being established: closing
   *  the subscription retires the attempt, so a handshake waiting on a host that is no longer
   *  wanted publishes nothing and releases whatever it was handed. */
  function detach(key: string): void {
    const subscription = subscriptions.get(key)
    if (subscription === undefined) return
    closeSubscription(subscription)
    subscriptions.delete(key)
  }

  /** Re-establish a session's state from a fresh snapshot, keeping what the reader is reading.
   *  The subscription continues: this is the repair for a hole in the stream, not a remount. */
  async function resync(key: string): Promise<void> {
    const record = recordFor(key)
    const subscription = subscriptionFor(key)
    if (record === null || subscription === null) return
    await openSubscription(subscription, handshakeOn(record), onEvent)
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
   * Send one turn, to the session `key` names.
   *
   * **The key is a parameter, and the store holds no second answer to "which session".** A
   * composer draws one session's record and acts on it, and the window it acts for is the one the
   * rail has on screen; the send is addressed by the caller's own key so the two cannot be told
   * apart by anything. Before the pointer was removed this was a live defect rather than a rule:
   * the pet's task link (`app/pet-task-link.ts`) moved the store's active key to the session its
   * task named while the rail kept the session it was on, and a send addressed by that pointer
   * went to a conversation the reader was not looking at — or, when that session's panel had
   * already unmounted and taken its subscription with it, nowhere at all: `no-session` is a typed
   * refusal, and a caller that discards it has drawn a control that can be pressed with nothing to
   * show for it. `cancel` and `resync` have always been addressed this way; these two were the
   * pair that were not, and the key is now the only address this file has.
   *
   * Refused while a run is live, and the text is kept as the draft rather than queued into
   * the engine — §6.2 allows one active generation per session, and quietly calling the
   * same session twice is exactly what it forbids.
   *
   * `attachments` is what the message carries beside its words — the composer's own reading, taken
   * at the moment the reader pressed send. It goes out unchanged and is *not* inspected here:
   * whether each block may travel is the engine's own report, the host reads that report at send
   * time, and a turn holding a block it does not licence comes back as a rejected `prompt` with
   * `attachment-unsupported` — the ordinary failure path below, which keeps the text. A refusal is
   * therefore reported by the host rather than pre-empted here, and there is one authority about it
   * rather than two.
   *
   * `targets` are the notes this request is about, as the editor holds them *now* — the
   * caller's lookup, by path, and never "whatever is open" (§7.1 forbids resolving the active
   * note at any later moment). They are plain data rather than a lookup function for the same
   * reason the context snapshot is a value: the version that matters is the one at this
   * instant, and a function would let a later reader answer with a version read later. A
   * *refused* send captures nothing — the run it would have belonged to never started, and the
   * one in flight keeps the baselines its own request was made against.
   */
  async function send(
    key: string,
    text: string,
    attachments: readonly AgentPromptAttachment[] = [],
    targets: readonly AgentLiveNote[] = [],
  ): Promise<AgentSendOutcome> {
    const live = subscriptionFor(key)
    const record = recordFor(key)
    if (live === null || record === null) return { accepted: false, reason: 'no-session' }
    // The attachments go to the row as well as to the wire, and this is the only moment both exist:
    // the composer clears its strip with the draft, so a row that did not record them would leave a
    // conversation with no trace that the model was shown a file.
    const started = startAgentRun(record.view, text, attachments)
    if (!started.accepted) {
      record.draft = text
      return { accepted: false, reason: 'run-in-flight' }
    }
    record.view = started.view
    const captured = captureEditBaselines(targets, record.identity)
    record.edits = captured.baselines
    // The text has moved into the timeline as the user's own row, so the composer's copy
    // goes. A *refused* send above leaves the draft exactly where it was.
    record.draft = ''
    try {
      await live.gateway.prompt(live.session, text, attachments)
    } catch (error) {
      const failure = describeFailure(error)
      record.view = failAgentRun(record.view, failure.code, failure.message)
      // The turn was never delivered, so the text goes back to the composer: it did not
      // reach the engine, and §5.1's rule is that an error does not take the user's words
      // from them. Only when the draft is still empty — anything typed since the send is
      // newer than this message and must not be overwritten.
      if (record.draft === '') record.draft = text
    }
    return { accepted: true, refusedEdits: captured.refused }
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
   * Answer the permission request the user is looking at, in the session `key` names.
   *
   * The key is a parameter for the reason {@link send} gives: the prompt is drawn from one
   * session's record, and the session in front can be another one. Answered against the wrong
   * one, the request is simply not there to resolve, and `not-pending` — a typed refusal — is
   * what the reader's press gets for an answer nothing happened to.
   *
   * The transition is applied before the call, for the ordering reason in this file's
   * header. It is also what makes a second click cheap: the request is no longer in the
   * view, so the repeat never reaches the gateway. Everything the gateway can refuse an
   * answer for — a request that is no longer pending, one whose turn is over — means the
   * request was dead anyway, so leaving it cleared is right.
   */
  async function answer(
    key: string,
    requestId: string,
    optionId: string,
  ): Promise<AgentAnswerOutcome> {
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

  /**
   * Put one of the run's changes back through the host, for a note no tab holds.
   *
   * The store's own door to `AgentGateway.recoverChange`, and it is here rather than in the
   * component for the reason the gateway arrives as an argument to *this* module: the subscription
   * a session is followed through is the only thing holding it, and a component that reached for a
   * gateway would be answering about a runtime it cannot see.
   *
   * A rejection is thrown rather than swallowed — "no session is attached" and "the host could not
   * be asked" are both facts the caller has to say, and the caller is the surface that knows what
   * the reader pressed. A *refusal* is not a rejection: it comes back as the host's own answer,
   * with one of the six codes, exactly as the contract declares it.
   */
  async function recoverChange(key: string, path: string): Promise<AgentChangeRecovery> {
    const live = subscriptionFor(key)
    if (live === null) {
      // The same word the adapter uses when it refuses before reaching the backend
      // (`tauri-agent.ts`), so a caller sees one code for "nothing is running" whichever layer
      // said it.
      throw new AgentFailure('runtime-unavailable', 'no agent session is attached')
    }
    return live.gateway.recoverChange(live.session, path)
  }

  /**
   * The version `path` held when this session's current run was submitted, or null when the
   * request did not name that note.
   *
   * Null is a refusal and not a default: a proposal for a note no request named has nothing to
   * be checked against, and `applyAgentEdit` refuses rather than writing on a guess. It is the
   * reason this returns a baseline rather than a revision — what the apply path needs is the
   * whole of what the request was made against, and half of it would be a second thing to keep
   * in step.
   */
  function editBaseline(key: string, path: string): AgentEditBaseline | null {
    const record = recordFor(key)
    if (record === null) return null
    return record.edits.find((baseline) => baseline.path === path) ?? null
  }

  /**
   * Adopt the option list an engine answered a `set_config_option` with.
   *
   * The same field a `config-changed` frame replaces, written by the other path to the same fact:
   * the pinned engine both returns the refreshed list and announces it, and until now this window
   * only ever read the announcement — so an engine that answered without notifying left the row
   * showing the value the reader had just left. `Gateway.setConfigOption` carries the reason; this
   * is the write.
   *
   * Not a synthetic event, and deliberately: an event carries a sequence, and a frame this window
   * made up would move the session's position in a stream it is only reading. It is also not
   * optimistic — the value comes from the engine's own answer, which is why nothing here is called
   * when that answer could not be read (`null` at the call site).
   */
  function adoptOptions(key: string, options: readonly AgentConfigOption[]): void {
    const record = recordFor(key)
    if (record === null) return
    record.view = { ...record.view, config: [...options] }
  }

  function setDraft(key: string, text: string): void {
    const record = recordFor(key)
    if (record !== null) record.draft = text
  }

  function setScroll(key: string, scrollTop: number): void {
    const record = recordFor(key)
    if (record !== null) record.scrollTop = scrollTop
  }

  return {
    records,
    recordFor,
    editBaseline,
    observeEvents,
    attach,
    detach,
    send,
    cancel,
    answer,
    recoverChange,
    resync,
    setDraft,
    setScroll,
    adoptOptions,
  }
})
