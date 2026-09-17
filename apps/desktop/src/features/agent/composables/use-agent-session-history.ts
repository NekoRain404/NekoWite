/**
 * The engine's *other* sessions: the control's gate, the list it opens, and the free action.
 *
 * This was the panel's largest single concern and it is the one with the least to do with the
 * conversation on screen: it reads `session/list`, not the session's frames, and every call it
 * makes is addressed by the engine's own id rather than by the session the panel is mounted on.
 * It moved here when `AgentPanel.vue` went past the size this project allows one component, and
 * it moved as a *move*: the popup recipe, the four states, the cursor rule and the free flow are
 * the panel's own code, carried across rather than rewritten.
 *
 * **Both controls are capabilities first.** `session/list` and `session/close` are what the engine
 * reports about itself in its handshake, `AgentGateway.capabilities` is where that report is read
 * back, and only an `available` finding draws the control that needs it — see
 * `capabilityAvailable`. The report is handed in rather than read here: it belongs to the runtime
 * the session belongs to, the panel reads it once for the composer as well, and a second read
 * would be a second answer to one question.
 *
 * A list the reader picked out of leaves as a *callback*, not as an action: a load has to be made
 * for the rail's vault and it replaces the session the panel is mounted on, so the call belongs to
 * whoever owns that lifecycle. The same is true of the list's one non-row entry, which opens a new
 * session on the runtime that is up.
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type {
  AgentCapabilityReport,
  AgentGateway,
} from '../../../platform/gateways/agent-contracts'
import { useDetachedPopup, type PopupPlacement } from './use-detached-popup'
import {
  agentSessionHistoryRows,
  capabilityAvailable,
  freeAgentSession,
  type AgentSessionHistoryRow,
} from '../services/agent-session-history'
import { describeFailure } from '../services/agent-session-subscription'
import AgentSessionHistoryMenu, {
  type AgentSessionHistoryFooter,
  type AgentSessionHistoryView,
} from '../components/AgentSessionHistoryMenu.vue'

export interface UseAgentSessionHistoryOptions {
  gateway: AgentGateway
  /** The session on screen, so the list can mark it as the one already open. */
  sessionId: string
  /**
   * The directory this runtime works in — `AgentRailState`'s own `cwd`, the vault root on disk.
   *
   * It is here for one comparison: a session the engine recorded in a *different* folder is a
   * different thing to reopen, and the history rows say so. Never assumed equal to the vault's id:
   * that the two are the same string today is a fact about the composition site.
   */
  cwd: string
  /**
   * The engine's whole report for this session's runtime, as it arrived — `null` means nothing
   * answered, which is not the same as an engine that answered "no".
   */
  capabilities: Ref<readonly AgentCapabilityReport[] | null>
  /**
   * Whether the caller can open a new session on that runtime — a capability of the *rail*, which
   * is what owns the runtime a session is opened on. Absent means no: the list offers the entry
   * only when its caller says it can act, so a panel mounted anywhere else (`AgentPanel.test.ts`
   * mounts one over a gateway with no rail at all) has no control that could be pressed and do
   * nothing.
   */
  openable: boolean
  /** The control the list hangs from: the history button in the session bar. */
  trigger: Ref<HTMLElement | null>
  /**
   * The list's own component, which the caller renders and binds with `ref`.
   *
   * Handed in rather than created here for the same reason `trigger` is: both are elements the
   * caller's *template* owns — this component places the popup — and a composable cannot bind a
   * template ref for markup it does not render.
   */
  popup: Ref<InstanceType<typeof AgentSessionHistoryMenu> | null>
  /** The reader picked a session. The reopen is the caller's — see the note above. */
  onResume: (sessionId: string) => void
  /** The reader asked for a new session on the runtime that is up. Also the caller's. */
  onNewSession: () => void
}

export interface AgentSessionHistory {
  /** Whether the bar draws the history control at all. */
  offered: ComputedRef<boolean>
  /** Whether the engine reported that it answers `session/close` — the free action's gate. */
  closeable: ComputedRef<boolean>
  /** Whether the list is up. The caller renders it under this. */
  open: Ref<boolean>
  /** Where the caller put the list, in viewport coordinates. */
  placement: Ref<PopupPlacement>
  /** What the list is showing; four states rather than a `loaded` flag, because "the engine holds
   *  nothing" and "the engine did not answer" are different sentences (see the menu). */
  view: Ref<AgentSessionHistoryView>
  rows: Ref<readonly AgentSessionHistoryRow[]>
  /** Why an `unreadable` list could not be read: the gateway's own sentence. */
  reason: Ref<string | null>
  /** The engine named a further page, so the list below is not the whole history. */
  more: Ref<boolean>
  /** A page being read right now, so the control can say so and refuse a second press. */
  moreBusy: Ref<boolean>
  /** Why the last page could not be read, in the gateway's own sentence. */
  moreReason: Ref<string | null>
  /** The instant every row's age is read against — one clock for the whole list. */
  now: Ref<number>
  /** What the strip under the rows says, if anything. */
  footer: Ref<AgentSessionHistoryFooter | null>
  /** The row that strip is about, so the question is attached to what it names. */
  confirming: Ref<string | null>
  /** The list element's id, so the rows and the listbox agree on one name. */
  listId: string
  /** Show the engine's sessions, or take the list away again. */
  toggle(): Promise<void>
  /** Close it and hand the keyboard back to the control it belongs to. */
  close(): void
  /** Ask for the page the engine named, with the cursor it issued. */
  loadMore(): Promise<void>
  /** A row's free action was pressed: ask, and name the row the question is about. */
  ask(sessionId: string): void
  /** No: the row stays, and so does the engine's session. */
  cancel(): void
  /** Yes: one call, then the engine's own list again. */
  confirm(): Promise<void>
  /** A row was settled on: close the list and ask the caller for the session. */
  pick(sessionId: string): void
  /** The list's one non-row entry: the reader asked for a *new* session on this runtime. */
  openNew(): void
}

export function useAgentSessionHistory(
  options: UseAgentSessionHistoryOptions,
): AgentSessionHistory {
  /**
   * The two gates, read off the report the caller hands in.
   *
   * Derived rather than kept as two refs written once on mount, which is what they were: the
   * report is set exactly once, so `computed` and the old imperative pair answer the same thing at
   * every instant — including the first, where `capabilityAvailable` over an empty list is false
   * and the controls are not drawn. The two are separate questions about one report: an engine may
   * answer `session/close` without answering `session/list`, and each control is drawn on its own
   * answer rather than on the pair.
   */
  const offered = computed(() => capabilityAvailable(options.capabilities.value ?? [], 'session-list'))
  const closeable = computed(() =>
    capabilityAvailable(options.capabilities.value ?? [], 'session-close'),
  )

  /** The list's element id, so the rows and the listbox agree on one name. */
  const listId = `agent-history-${options.sessionId}`

  const view = ref<AgentSessionHistoryView>('loading')
  const rows = ref<readonly AgentSessionHistoryRow[]>([])
  const reason = ref<string | null>(null)
  const more = ref(false)
  /**
   * The cursor the engine handed back with the page on screen — the only thing that can fetch the
   * next one.
   *
   * Held here rather than derived from the rows because it is opaque: this side cannot read it,
   * cannot reconstruct it from what it has, and may only give it back to the engine that issued it.
   * A list that showed the engine's "there is more" and kept no cursor was the whole of this
   * defect; a cursor kept and never passed back is the same defect one layer down.
   */
  const cursor = ref<string | null>(null)
  const moreBusy = ref(false)
  const moreReason = ref<string | null>(null)
  const at = ref(0)

  /**
   * Where the list goes, when it closes, and who owns Escape while it is up: the app's popup recipe,
   * measured against the control in the bar (which exposes its element for exactly this).
   */
  const menu = useDetachedPopup({
    floor: 220,
    claim: 'agent-session-history',
    trigger: options.trigger,
    popup: () => options.popup.value?.element() ?? null,
  })

  /**
   * Show the engine's sessions, or take the list away again.
   *
   * The read is started before the popup is measured so the list is on screen — with its own
   * "reading" line — while the engine answers, and the outcome is *settled into a value* rather
   * than left as a rejecting promise for the two awaits in between to trip over.
   */
  async function toggle(): Promise<void> {
    if (menu.open.value) {
      close()
      return
    }
    view.value = 'loading'
    reason.value = null
    // Opening the list asks for the first page: whatever cursor the reader walked to last time is
    // a position in a list that is being rebuilt from the top, and reusing it would splice a page
    // of the engine's table onto a list that no longer has the rows it continued from.
    cursor.value = null
    moreReason.value = null
    const answer = read()
    await menu.show()
    await answer
    options.popup.value?.focus()
  }

  /**
   * Ask the engine for its list, and draw whatever it answers.
   *
   * One function for both readers — the control opening the list, and the refresh after a free —
   * because both are the same question and a second copy is a second place the four states could be
   * got wrong. The outcome is *settled into a value* rather than left as a rejecting promise for
   * the awaits around it to trip over, and everything it writes is the engine's own answer: the
   * rows, whether the list is a whole page, and the sentence a refusal came with.
   */
  async function read(after: string | null = null): Promise<void> {
    const settled = await options.gateway.listSessions(after ?? undefined).then(
      (history) => ({ ok: true as const, history }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    if (!settled.ok) {
      // The gateway's own sentence, shown in the list rather than swallowed: a control that asked
      // the engine something and got nothing back owes the reader the reason. Which of the two
      // sentences depends on what was asked: a first page that could not be read leaves no list to
      // draw, and a *later* one leaves the rows on screen and says the page failed beside them —
      // replacing a list the reader is using with an error would lose what they were reading.
      const message = describeFailure(settled.error).message
      if (after === null) {
        reason.value = message
        view.value = 'unreadable'
      } else {
        moreReason.value = message
      }
      return
    }
    at.value = Date.now()
    const page = agentSessionHistoryRows(settled.history, {
      currentSessionId: options.sessionId,
      cwd: options.cwd,
    })
    // A page is *appended* to the one before it, and only a first read replaces: the rows arrive in
    // the engine's own order, and a page spliced in somewhere else would reorder a list the reader
    // is reading.
    rows.value = after === null ? page : [...rows.value, ...page]
    cursor.value = settled.history.nextCursor
    more.value = settled.history.nextCursor !== null
    view.value = rows.value.length === 0 ? 'empty' : 'rows'
  }

  /**
   * The page the engine named, asked for with the cursor it issued.
   *
   * Guarded by the cursor and by the busy flag rather than by the button alone: the button is
   * disabled while a read is in flight, and a second press that arrived anyway would ask for the
   * same page twice and draw every row of it twice. A refusal appends nothing, leaves the list
   * where it was, and puts the engine's sentence under the control.
   */
  async function loadMore(): Promise<void> {
    const held = cursor.value
    if (held === null || moreBusy.value) return
    moreBusy.value = true
    moreReason.value = null
    try {
      await read(held)
    } finally {
      moreBusy.value = false
    }
  }

  /** Close the list and hand the keyboard back to the control it belongs to. */
  function close(): void {
    menu.hide()
    // The question goes with the list: a confirmation is about a row the reader can see, and one
    // that outlived its list would be answered against a subject that is no longer on screen.
    confirming.value = null
    footer.value = null
    options.trigger.value?.focus()
  }

  /**
   * The free action: the strip under the rows, and the two calls behind it.
   *
   * `session/close` is a real change on the engine — it stops serving the session and cancels
   * whatever it was running — so the button that starts it asks first, and the answer's sentence
   * says the thing that would otherwise read as a failure: **the engine keeps the session in its
   * list**. That is measured behaviour, not leniency (`agent_session_lifecycle_test.rs` §4.4: the
   * row is still there afterwards, and removing one is `session/delete`, which this engine answers
   * `-32601` for). A reader who presses this and sees the row still on screen must not conclude it
   * did not work.
   */
  const confirming = ref<string | null>(null)
  const busy = ref(false)
  const footer = ref<AgentSessionHistoryFooter | null>(null)

  /** A row's action was pressed: ask, and name the row the question is about. */
  function ask(sessionId: string): void {
    confirming.value = sessionId
    footer.value = { kind: 'confirm' }
  }

  /** No: the row stays, and so does the engine's session. */
  function cancel(): void {
    confirming.value = null
    footer.value = null
  }

  /** Yes: one call, then the engine's own list again. */
  async function confirm(): Promise<void> {
    const sessionId = confirming.value
    if (sessionId === null || busy.value) return
    busy.value = true
    try {
      await freeAgentSession(options.gateway, sessionId)
      // The list is *re-read* rather than edited: the engine's answer is what the reader sees, and
      // the row is expected to still be in it. Anything else — dropping the row here — would be
      // this window drawing its own idea of what a close means. From the first page, because the
      // cursor the reader had walked to belongs to a table that just changed under it.
      await read()
      confirming.value = null
      footer.value = { kind: 'freed' }
    } catch (error) {
      footer.value = { kind: 'failed', reason: describeFailure(error).message }
    } finally {
      busy.value = false
    }
  }

  /**
   * One row settled on: close the list, and ask the caller for the session — unless it is the one
   * already on screen.
   *
   * That row is not an error and not a call. The engine refuses a load of a session it is currently
   * serving (`session-stale`, documented on `AgentGateway.loadSession`), and the honest reading of
   * "show me this one" about the session already showing is that there is nothing to do. The row is
   * drawn and marked as the open one rather than hidden: it is the engine's answer, and dropping it
   * would be this window editing a list the engine gave.
   */
  function pick(sessionId: string): void {
    close()
    if (sessionId === options.sessionId) return
    options.onResume(sessionId)
  }

  return {
    offered,
    closeable,
    open: menu.open,
    placement: menu.placement,
    view,
    rows,
    reason,
    more,
    moreBusy,
    moreReason,
    now: at,
    footer,
    confirming,
    listId,
    toggle,
    close,
    loadMore,
    ask,
    cancel,
    confirm,
    pick,
    openNew: () => options.onNewSession(),
  }
}

export type UseAgentSessionHistory = ReturnType<typeof useAgentSessionHistory>
