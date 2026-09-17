<script lang="ts">
/**
 * The panel's copy tree, handed in rather than reached for.
 *
 * One prop for the whole panel, holding one entry per component that needs words. They arrive
 * from above rather than being read here, so a missing sentence is a visible integration point
 * instead of an English string shipped in its place.
 *
 * The catalogue did not have the panel's keys when this prop was written, and it does now
 * (`src/i18n/namespaces/agent.ts`'s `agent.panel`, added with the composer's control row); the
 * tree is kept because the *shape* is what makes an unmounted or test-mounted panel say exactly
 * what its caller gave it. The newer components beside this one read their own defaults from the
 * catalogue and take these as overrides (`AgentCommandMenu.vue`, `AgentConfigRow.vue`), which is
 * the direction the rest of the tree moves in as its keys land.
 */
import type { AgentComposerLabels } from './AgentComposer.vue'
import type { AgentSessionBarLabels } from './AgentSessionBar.vue'
import type { AgentTimelineLabels } from './AgentTimeline.vue'

export interface AgentPanelLabels {
  bar: AgentSessionBarLabels
  timeline: AgentTimelineLabels
  composer: AgentComposerLabels
  /** The one notice the panel itself raises. */
  notice: {
    /** The record has a hole: a frame the subscription never saw. */
    gap: string
    /** Take a fresh snapshot and carry on from it. */
    resync: string
  }
  /** The transcript's first line, drawn only while the transcript is empty. It is one sentence
   *  with the engine's name in it, so it arrives assembled rather than in parts. */
  empty: {
    line: string
  }
}
</script>

<script setup lang="ts">
/**
 * The agent panel: one session, assembled.
 *
 * It is the feature's assembly point and the only component here that holds a session at all.
 * Everything it draws takes props and emits; this one owns the binding to the store, because
 * the three acceptance rules of §5.1 are about the *panel's* life rather than its parts:
 *
 *  - **the session outlives the panel** (§5.1 「任务可以在面板收起后继续」). Nothing here stops a
 *    run — there is no `stop` on unmount, and the only thing teardown does is release the
 *    subscription, which `useAgentSession` owns. The subscription is re-established from a
 *    snapshot when the panel comes back (§6.2's handshake, which exists for exactly this), so a
 *    rail that closes and opens is not a run that was interrupted or a transcript that was lost.
 *  - **the draft, the position and the unread flag are the session's**, not the panel's: they
 *    live in the store, keyed by the session's identity, so collapsing the rail cannot take
 *    them with it (§5.1).
 *  - **a hole in the stream is said out loud.** A gap means the transcript on screen is not
 *    the session's record, and the one honest thing to offer is a resync rather than a
 *    silent partial answer.
 *
 * It is also where the engine's *other* sessions are reached: the bar carries the history control
 * and this file owns what it opens — the capability check that decides whether the control exists
 * at all, the `listSessions` read, and the rows the engine's own answer draws. Picking one leaves
 * as an event (`resume`): a load has to be made for the rail's vault and it replaces the session
 * this panel is mounted on, so the call belongs to whoever owns that lifecycle, not here.
 *
 * It also *places* the three components the neighbouring tasks own, because putting them in the
 * session's life is the part that is this file's business: the permission prompt (T7) is
 * rendered for the request the run is waiting on, the `/` menu (T8) sits over the composer whose
 * keys and text it needs, and the transcript's first line is drawn here while the transcript is
 * empty. Both answers are the store's own actions — the prompt's answer, and the menu's
 * selection written back into the draft, because §4.1 sends a command as an ordinary prompt.
 *
 * The composer's control row is here too — the session's own config options, on the right of the
 * bar below the field (§5.3's 「模型菜单」, and Zed's arrangement of the same row). **The three
 * facts this file used to record as a backend gap have changed, and the note is rewritten rather
 * than dropped because one of them still holds in a narrower form.** The host vocabulary
 * (`src-tauri/src/agent_runtime/events.rs`) now carries `ConfigChanged` and `normalize_update`
 * maps `SessionUpdate::ConfigOptionUpdate` into the contract's payload; the live suite holds the
 * engine's own `config_option_update` to that shape
 * (`agent_session_ipc_test.rs`, `the_engines_own_options_reach_both_the_caller_and_the_window`).
 * `agent_set_config_option` now answers the engine's refreshed option list rather than throwing it
 * away, and `AgentGateway` carries the general `setConfigOption` the row needs — `selectModel` is
 * the model's special case of it rather than a second mechanism beside it.
 *
 * What still holds, and what the row is built around: **`view.config` is filled by frames, and
 * the engine's first option list arrives as the `session/new` response.** A session that has just
 * opened therefore has an empty `view.config` while the engine has already reported its options,
 * and a row drawn from the view alone would be a control that never appears.
 * `services/agent-config-options.ts` is the one place that decides which report a control came
 * from, and it is the place to read before changing what the row holds.
 *
 * The session arrives as a prop and is read once: a panel is mounted *per session*, so the
 * composition site keys it (or remounts it) rather than re-pointing it at another session —
 * a store binding cannot be moved to a session the panel was not mounted for.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type {
  AgentCommand,
  AgentGateway,
  AgentSession,
  AgentToolContent,
  AgentToolStatus,
} from '../../../platform/gateways/agent-contracts'
import { t } from '../../../i18n'
import { useAgentCommands } from '../composables/use-agent-commands'
import { useDetachedPopup } from '../composables/use-detached-popup'
import { useAgentSession } from '../composables/use-agent-session'
import {
  configControls,
  setConfigOption,
  type AgentConfigControl,
} from '../services/agent-config-options'
import {
  agentSessionHistoryRows,
  capabilityAvailable,
  freeAgentSession,
  type AgentSessionHistoryRow,
} from '../services/agent-session-history'
import { describeFailure } from '../services/agent-session-subscription'
import { isRunLive } from '../services/agent-session-view'
import type { AgentToolEntry } from '../services/agent-timeline'
import { useAgentSessionStore } from '../stores/agent-session'
import AgentCommandMenu from './AgentCommandMenu.vue'
import AgentComposer from './AgentComposer.vue'
import AgentPermissionPrompt from './AgentPermissionPrompt.vue'
import AgentSessionBar from './AgentSessionBar.vue'
import AgentSessionHistoryMenu, {
  type AgentSessionHistoryFooter,
  type AgentSessionHistoryView,
} from './AgentSessionHistoryMenu.vue'
import AgentTimeline from './AgentTimeline.vue'

const props = defineProps<{
  /** The adapter behind the session, chosen at the composition site (§6.1). */
  gateway: AgentGateway
  /** The session to show. Read once — see the note above about mounting per session. */
  session: AgentSession
  /**
   * The directory this runtime works in — `AgentRailState`'s own `cwd`, the vault root on disk.
   *
   * It is here for one comparison: a session the engine recorded in a *different* folder is a
   * different thing to reopen, and the history rows say so. Never assumed equal to `vaultId`:
   * that the two are the same string today is a fact about the composition site.
   */
  cwd: string
  labels: AgentPanelLabels
}>()

const emit = defineEmits<{
  /**
   * The user picked a session out of the engine's history.
   *
   * An event rather than a call, because the reopen is the *rail's*: a load has to be made for the
   * vault the runtime was started for, and it replaces the session this panel is mounted on — a
   * panel cannot re-point itself, and one that called the gateway here would be a second place
   * the rail's generation latch did not reach.
   */
  resume: [sessionId: string]
}>()

const store = useAgentSessionStore()

const {
  key,
  view,
  state,
  timeline,
  gap,
  draft,
  canSend,
  send,
  stop,
  answer,
  resync,
  setScroll,
  dropped,
  lastDrop,
} = useAgentSession({ gateway: props.gateway, session: props.session })

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
const title = computed<string | null>(() => view.value?.title ?? props.session.title)

/**
 * `unread` is deliberately not taken from the binding above, and the reason is worth writing down
 * because the state and this component's shape make it look like an oversight.
 *
 * The store sets the flag when an event is applied for a session that is *not* the one on screen
 * (`stores/agent-session.ts`, `key !== activeKey`), and this binding clears it — `focus(key)` on
 * mount calls `markRead`. So the flag can never be true in the panel that would draw it: mounting
 * is what clears it. Its surface is therefore the list of sessions a reader switches between — a
 * marker on the row that is not the open one, which is Zed's activity-bar dot
 * (`agent_panel.rs`, `has_notification` on an inactive entry, cleared by
 * `active_terminal_visible`) — and this panel has no such list. `AgentSessionHistoryMenu` is not
 * one: its rows are the *engine's* sessions, keyed by the engine's own ids, and a session this
 * window never subscribed to has no record and no flag.
 *
 * Nothing draws it today, and that is a fact about the flag rather than about the render: a
 * subscription is only ever made by `useAgentSession`, which focuses in the same breath, so no
 * session can be subscribed while another one is active. Making the marker reachable means
 * keeping a session attached across a switch — a lifecycle change (the rail replaces the panel
 * rather than re-pointing it, and `useAgentSession`'s `subscribe: false` exists for the reader
 * that would need) — not a line in this template.
 */

/**
 * Where this session's transcript was left, for the timeline to take at mount (§5.1
 * 「每会话独立…滚动位置」).
 *
 * Read from the store here rather than taken as a prop, because the binding below writes the
 * position (`setScroll`) and has no reader for it: a session the panel has shown before keeps
 * its record across a collapse, and this is the only moment that record is of any use. A
 * record that does not exist yet means nobody has read this session — `undefined` opens it at
 * the end rather than at offset 0, which is what a first look wants. The one case the store
 * cannot tell apart is a record that exists but was never scrolled; that is a session whose
 * transcript the reader has not seen, and opening it at the end is the cheaper mistake.
 */
const initialPosition = store.recordFor(key)?.scrollTop

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
  if (dropped.value === 0) return null
  return t('agent.panel.notice.dropped', { n: dropped.value, reason: lastDrop.value ?? '' })
})

/**
 * The composer's own question: is a run in flight, so that its button is a stop. Read
 * from the view through the store's own definition of "live" rather than a second list of states
 * that could drift from it. */
const running = computed(() => view.value !== null && isRunLive(view.value))

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
 * (`AgentPermissionRequest.toolCallId`'s own comment). It is made once, here, and everything the
 * prompt needs from that row is read off it — the status and the blocks an edit proposed — rather
 * than two searches that could disagree about which row they found.
 */
const pendingToolRow = computed<AgentToolEntry | null>(() => {
  const request = pending.value
  if (request === null) return null
  // The predicate is the guard, not only the test: without it `find` answers with the whole
  // `AgentTimelineEntry` union and `status` is a property of one member. `AgentToolEntry` carries
  // it as a required field, so nothing here is being widened — the row that was selected is
  // narrowed to the kind it was selected by.
  const row = timeline.value.find(
    (entry): entry is AgentToolEntry =>
      entry.kind === 'tool' && entry.toolCallId === request.payload.toolCallId,
  )
  return row ?? null
})

/**
 * The status of that call, as the prompt reads it.
 *
 * `null` is "the host knows nothing here", which T7's prompt must not read as "this call is
 * over": a request whose row has not arrived yet is still waiting for its answer.
 */
const pendingToolStatus = computed<AgentToolStatus | null>(
  () => pendingToolRow.value?.status ?? null,
)

/**
 * The content blocks of that same row, for the prompt to draw.
 *
 * The request itself carries none — see `AgentPermissionPrompt`'s `toolContent` — so this is the
 * join by `toolCallId`, made once here and read by both the status and the diff. An empty list is
 * both the ordinary case (a call that proposed no edit) and the "the row has not arrived yet"
 * case, and neither of them draws anything.
 */
const pendingToolContent = computed<readonly AgentToolContent[]>(
  () => pendingToolRow.value?.content ?? [],
)

/** Whether the request can no longer be answered — the store's own rule, not a second opinion:
 *  an answer for a request whose run is not live is refused there. */
const expired = computed(() => view.value === null || !isRunLive(view.value))

/**
 * The session's own configuration options, as the composer's control row draws them.
 *
 * Read from the view — the engine's own frames, replaced whole by each `config-changed` — and
 * seeded by the session handle for as long as no frame has carried them, which is the state a
 * session is in the moment it opens. `services/agent-config-options.ts` holds that rule and the
 * reason for it; nothing here decides what the row contains, because what it contains is the
 * engine's report rather than this app's list.
 */
const config = computed<readonly AgentConfigControl[]>(() =>
  configControls(props.session, view.value?.config ?? []),
)

/** The control whose value is being set right now. A second choice while one is in flight is
 *  refused by the control itself (it is disabled), so this is also what the row reads to know
 *  which trigger to hold still. */
const configBusy = ref<string | null>(null)

/** The last set that did not take. Kept rather than dropped because the row goes on showing the
 *  engine's value: without a word about it, a press that did nothing looks like a press that
 *  worked. */
const configFailure = ref<{ key: string; message: string } | null>(null)

/**
 * One choice in the control row.
 *
 * Not the store's business and not the composer's: the option belongs to the session and the
 * call belongs to the gateway, and both are here. A refusal is already reported to the reader by
 * the row that made the choice, so nothing is thrown at a click handler that could not catch it.
 */
/**
 * One choice in the control row.
 *
 * Not the store's business and not the composer's: the option belongs to the session and the
 * call belongs to the gateway, and both are here. A refusal is already reported to the reader by
 * the row that made the choice, so nothing is thrown at a click handler that could not catch it.
 *
 * **The engine's answer is written into the view, and that is the half that was missing.** The
 * command returns the refreshed option list (`commands/agent.rs`), the port used to drop it, and
 * the row therefore moved only when the engine *also* announced the change as `config-changed` —
 * true of the pinned engine, and not something a caller may rely on. Both paths end in the same
 * field, so the notification now finds the list already there rather than being the only way it
 * ever arrives. A `null` answer means the list could not be read, and the row keeps the engine's
 * last known value rather than being cleared by a response nobody understood.
 */
async function onConfigSet(configKey: string, value: string | boolean): Promise<void> {
  const control = config.value.find((entry) => entry.key === configKey)
  if (control === undefined) return
  configBusy.value = configKey
  configFailure.value = null
  const outcome = await setConfigOption(props.gateway, props.session, control, value)
  configBusy.value = null
  if (!outcome.accepted && outcome.reason === 'refused') {
    configFailure.value = { key: configKey, message: outcome.message }
  }
  if (outcome.accepted && outcome.options !== null) {
    store.adoptOptions(key, outcome.options)
  }
}

/**
 * The `/` menu (T8): the engine's published commands for this session, filtered by the token
 * being typed.
 *
 * It lives here because both halves of it are here — the draft is the store's and the keys are
 * the composer's — and the panel is where the two meet. Its keys are taken *before* the
 * composer's own, which is why the field is handed `onKeydown` and asks for a verdict before
 * deciding what Enter means; the command's name is written back into the draft, because §4.1
 * sends a command as an ordinary prompt rather than running anything on this side.
 *
 * **The list it filters arrives here frame by frame**, through the store's own feed
 * (`store.observeEvents`): `useAgentCommands` is fed the engine's events through its
 * `accept(event)`, and those frames belong to the store. The reduced view is deliberately not the
 * source — it reports "nothing published yet" and "the engine published an empty list" as the same
 * empty `commands` array, and T8's menu tells those apart because the user's next move differs.
 * Feeding it the frames keeps that distinction where it is already modelled, and it is what makes
 * the empty state's `/ for commands` a true sentence rather than an offer of a menu that would
 * never fill.
 */
const commands = useAgentCommands({
  identity: () => view.value?.identity ?? null,
  text: () => draft.value,
  select: chooseCommand,
})

// The feed is released with the panel: a listener left behind would keep filtering frames for a
// session whose menu is not on screen any more. Registered at setup rather than on mount, because
// the events of the very first frame must not be missed between the two.
const stopObserving = store.observeEvents((event) => commands.accept(event))
onBeforeUnmount(stopObserving)

/**
 * What settling on a menu row means: the command's name replaces the token, and everything the
 * reader typed after it is kept exactly as it was — this function cannot read an argument, so it
 * cannot trim, requote or reinterpret one (§4.1 「原样参数保留」).
 *
 * One function for both paths on purpose: `<AgentCommandMenu>`'s `@select` (a click) and T8's
 * own `select` (Enter on the highlighted row) are the same act on the same row.
 */
function chooseCommand(command: AgentCommand): void {
  draft.value = commands.textWithCommand(command)
}

function onComposition(phase: 'start' | 'end'): void {
  if (phase === 'start') commands.onCompositionStart()
  else commands.onCompositionEnd()
}

function onSend(text: string): void {
  // A refusal is the store's to report and it keeps the text itself (§5.1: an error does not
  // clear the draft); there is nothing for the panel to do with the outcome here.
  void send(text)
}

/**
 * The sessions this engine holds (§5.3's history control): whether the control may be drawn at
 * all, and the list it opens.
 *
 * **Both controls are capabilities first.** `session/list` and `session/close` are what the engine
 * reports about itself in its handshake, `AgentGateway.capabilities` is where that report is read
 * back, and only an `available` finding draws the control that needs it — see
 * `capabilityAvailable`. The check happens once, on mount, because a panel is mounted per session:
 * a report belongs to the runtime the session belongs to, and a runtime the host replaced has no
 * answer left to give. A report this window could not read at all is *not* an available one:
 * neither control is drawn, and nothing is said about a call nobody answered.
 */
const historyOffered = ref(false)
const closeOffered = ref(false)

onMounted(async () => {
  try {
    const reports = await props.gateway.capabilities(props.session)
    historyOffered.value = capabilityAvailable(reports, 'session-list')
    closeOffered.value = capabilityAvailable(reports, 'session-close')
  } catch {
    historyOffered.value = false
    closeOffered.value = false
  }
})

const barEl = ref<InstanceType<typeof AgentSessionBar> | null>(null)
const historyEl = ref<InstanceType<typeof AgentSessionHistoryMenu> | null>(null)

/** The list's element id, so the rows and the listbox agree on one name. */
const historyListId = `agent-history-${props.session.sessionId}`

/** What the menu is showing; four states rather than a `loaded` flag, because "the engine holds
 *  nothing" and "the engine did not answer" are different sentences (see the menu). */
const historyView = ref<AgentSessionHistoryView>('loading')
const historyRows = ref<readonly AgentSessionHistoryRow[]>([])
const historyReason = ref<string | null>(null)
/** The engine named a further page, so the list below is not the whole history. */
const historyMore = ref(false)
/** The instant every row's age is read against — one clock for the whole list. */
const historyAt = ref(0)

/**
 * Where the list goes, when it closes, and who owns Escape while it is up: the app's popup recipe,
 * measured against the control in the bar (which exposes its element for exactly this).
 */
const historyMenu = useDetachedPopup({
  floor: 220,
  claim: 'agent-session-history',
  trigger: computed(() => barEl.value?.triggerElement() ?? null),
  popup: () => historyEl.value?.element() ?? null,
})

/**
 * Show the engine's sessions, or take the list away again.
 *
 * The read is started before the popup is measured so the list is on screen — with its own
 * "reading" line — while the engine answers, and the outcome is *settled into a value* rather
 * than left as a rejecting promise for the two awaits in between to trip over.
 */
async function openHistory(): Promise<void> {
  if (historyMenu.open.value) {
    closeHistory()
    return
  }
  historyView.value = 'loading'
  historyReason.value = null
  const answer = readHistory()
  await historyMenu.show()
  await answer
  historyEl.value?.focus()
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
async function readHistory(): Promise<void> {
  const settled = await props.gateway.listSessions().then(
    (history) => ({ ok: true as const, history }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  if (!settled.ok) {
    // The gateway's own sentence, shown in the list rather than swallowed: a control that asked
    // the engine something and got nothing back owes the reader the reason.
    historyReason.value = describeFailure(settled.error).message
    historyView.value = 'unreadable'
    return
  }
  historyAt.value = Date.now()
  historyRows.value = agentSessionHistoryRows(settled.history, {
    currentSessionId: props.session.sessionId,
    cwd: props.cwd,
  })
  historyMore.value = settled.history.nextCursor !== null
  historyView.value = historyRows.value.length === 0 ? 'empty' : 'rows'
}

/** Close the list and hand the keyboard back to the control it belongs to. */
function closeHistory(): void {
  historyMenu.hide()
  // The question goes with the list: a confirmation is about a row the reader can see, and one
  // that outlived its list would be answered against a subject that is no longer on screen.
  freeTarget.value = null
  historyFooter.value = null
  barEl.value?.triggerElement()?.focus()
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
const freeTarget = ref<string | null>(null)
const freeBusy = ref(false)
const historyFooter = ref<AgentSessionHistoryFooter | null>(null)

/** A row's action was pressed: ask, and name the row the question is about. */
function askFree(sessionId: string): void {
  freeTarget.value = sessionId
  historyFooter.value = { kind: 'confirm' }
}

/** No: the row stays, and so does the engine's session. */
function cancelFree(): void {
  freeTarget.value = null
  historyFooter.value = null
}

/** Yes: one call, then the engine's own list again. */
async function confirmFree(): Promise<void> {
  const sessionId = freeTarget.value
  if (sessionId === null || freeBusy.value) return
  freeBusy.value = true
  try {
    await freeAgentSession(props.gateway, sessionId)
    // The list is *re-read* rather than edited: the engine's answer is what the reader sees, and
    // the row is expected to still be in it. Anything else — dropping the row here — would be
    // this window drawing its own idea of what a close means.
    await readHistory()
    freeTarget.value = null
    historyFooter.value = { kind: 'freed' }
  } catch (error) {
    historyFooter.value = { kind: 'failed', reason: describeFailure(error).message }
  } finally {
    freeBusy.value = false
  }
}

/**
 * One row settled on: close the list, and ask the rail for the session — unless it is the one
 * already on screen.
 *
 * That row is not an error and not a call. The engine refuses a load of a session it is currently
 * serving (`session-stale`, documented on `AgentGateway.loadSession`), and the honest reading of
 * "show me this one" about the session already showing is that there is nothing to do. The row is
 * drawn and marked as the open one rather than hidden: it is the engine's answer, and dropping it
 * would be this window editing a list the engine gave.
 */
function onHistoryPick(sessionId: string): void {
  closeHistory()
  if (sessionId === props.session.sessionId) return
  emit('resume', sessionId)
}
</script>

<template>
  <section
    class="agent-panel"
    data-agent-panel
  >
    <AgentSessionBar
      ref="barEl"
      :title="title"
      :state="state"
      :failure="view?.failure ?? null"
      :result="view?.lastResult ?? null"
      :history="historyOffered"
      :history-open="historyMenu.open.value"
      :labels="labels.bar"
      @history="openHistory"
    />
    <p
      v-if="gap"
      class="agent-panel-notice"
      role="status"
    >
      <span class="agent-panel-notice-text">{{ labels.notice.gap }}</span>
      <button
        class="agent-panel-resync"
        type="button"
        @click="resync"
      >
        {{ labels.notice.resync }}
      </button>
    </p>
    <!-- The other way the record on screen can stop being the session's record: frames that
         arrived and were refused. Drawn only above zero (`dropped` is cumulative for the
         session, so a naught is the ordinary state and a badge reading "0" would say nothing),
         and it carries no button: the counter is not cleared by a reload, so a resync here would
         be a control that leaves its own sentence standing.
         The sentence says what happened and names the reducer's last reason — it does not say
         the transcript is incomplete, because it is not always: a re-subscription replays frames
         the view already has, and their refusal is `duplicate-sequence`
         (`agent-event-reducer.ts`, `judgeSequence`). A sentence that read "content is missing"
         would be false for the commonest case, which is the second kind of dishonesty §5.2
         forbids. It sits in the flow above the transcript like the gap notice, and moving the
         reader is not a risk it adds: the timeline watches its own box and re-anchors the visible
         row on a container resize (`AgentTimeline.vue`, `ResizeObserver` → `contentChanged`). -->
    <p
      v-if="droppedSentence !== null"
      class="agent-panel-notice is-quiet"
      data-agent-dropped
      role="status"
    >
      <span class="agent-panel-notice-text">{{ droppedSentence }}</span>
    </p>
    <!-- The transcript's first line, and only while there is no transcript: directly under the
         title rule, in the panel's own monospace, so an empty session reads as the beginning of a
         conversation rather than as an illustration. It is `aria-live="off"` like the transcript
         beside it — it says nothing that changes per token. -->
    <p
      v-if="timeline.length === 0"
      class="agent-panel-empty"
      data-agent-empty
    >
      {{ labels.empty.line }}
    </p>
    <!-- Keyed by the session: the timeline remembers where the reader was for one session's
         rows, and a switch is a different transcript rather than the same one re-pointed. -->
    <AgentTimeline
      :key="key"
      :rows="timeline"
      :initial-position="initialPosition"
      :labels="labels.timeline"
      @position="setScroll($event)"
    />
    <!-- The pending authorization, next to the composer rather than in the transcript: it is
         the one thing the reader has to act on, it must not scroll away, and §5.1 keeps the
         editor usable while it waits. Answering and stopping are the store's actions; the
         prompt owns the wording and the option ids, which are the engine's (§6.3). -->
    <AgentPermissionPrompt
      v-if="pending !== null"
      class="agent-panel-permission"
      :request="pending.payload"
      :tool-status="pendingToolStatus"
      :tool-content="pendingToolContent"
      :expired="expired"
      @answer="answer"
      @cancel="stop"
    />
    <!-- The menu floats over the transcript rather than taking a row of its own: it is a popup
         for the token being typed, and a box that pushed the composer down would move the field
         under the reader's hands as they type. -->
    <div class="agent-panel-compose">
      <AgentCommandMenu
        v-if="commands.view.value !== 'closed'"
        class="agent-panel-menu"
        :view="commands.view.value"
        :commands="commands.matches.value"
        :active-index="commands.activeIndex.value"
        :reason="commands.reason.value"
        @select="chooseCommand"
        @highlight="commands.setActive"
      />
      <AgentComposer
        v-model="draft"
        :running="running"
        :can-send="canSend"
        :resolve-key="commands.onKeydown"
        :config="config"
        :config-busy="configBusy"
        :config-failure="configFailure"
        :labels="labels.composer"
        @send="onSend"
        @stop="stop"
        @composition="onComposition"
        @set-config="onConfigSet"
      />
    </div>
    <!-- The engine's sessions, teleported to the body and placed against the control in the bar
         by `useDetachedPopup`: the rail body scrolls, and a list drawn inside it would be clipped
         by a container it has nothing to do with. It is the panel's list rather than the bar's
         because the gateway and the session are here — the bar draws the control and nothing
         else. -->
    <Teleport to="body">
      <Transition name="agent-history-popup">
        <AgentSessionHistoryMenu
          v-if="historyMenu.open.value"
          ref="historyEl"
          :view="historyView"
          :rows="historyRows"
          :reason="historyReason"
          :more="historyMore"
          :closeable="closeOffered"
          :footer="historyFooter"
          :confirming="freeTarget"
          :now="historyAt"
          :list-id="historyListId"
          :left="historyMenu.placement.value.left"
          :top="historyMenu.placement.value.top"
          :min-width="historyMenu.placement.value.minWidth"
          :drop="historyMenu.placement.value.drop"
          @activate="onHistoryPick"
          @ask="askFree"
          @confirm="confirmFree"
          @cancel="cancelFree"
          @close="closeHistory"
        />
      </Transition>
    </Teleport>
  </section>
</template>

<style scoped>
.agent-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  /* The same release on the other axis. Without it the panel's automatic minimum size is its
     content's min-content width — measured at 419px inside a 400px rail, with the send button
     drawn past the panel's own right edge and, on a narrower rail or with wider fonts, past the
     window, where nothing can click it. A rail hosts this panel, so the panel takes the rail's
     width and its contents give way — which the bar already does when it is allowed to. */
  min-width: 0;
  /* The composer measures its growth against the nearest positioned ancestor, which is this
     element: §5.3 bounds the field by the panel's own height, not the window's. */
  position: relative;
  background: var(--app-panel);
  color: var(--app-text);
  font-family: var(--app-font);
}
.agent-panel-notice {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-warn) 12%, var(--app-panel));
  color: var(--app-text);
  font-size: 12px;
}
.agent-panel-notice-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* The refused-frame line. Same row, no warning tint and no button: a frame the transport
   re-sent is not a fault the reader has to act on, and a notice painted in the danger family
   would train them to fear the reload button that produces most of them. */
.agent-panel-notice.is-quiet {
  background: var(--app-elevated);
  color: var(--app-muted);
}
.agent-panel-resync {
  flex: none;
  min-height: 24px;
  padding: 0 8px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-elevated);
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.agent-panel-resync:hover {
  background: color-mix(in srgb, var(--app-elevated) 84%, var(--app-accent-soft));
}
.agent-panel-resync:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
/* The empty transcript's line. Monospace and muted, at the top of the transcript area rather
   than centred in it: it is the first line of a conversation, not an illustration of one, and
   the transcript below keeps the room it will need when the first row arrives. */
.agent-panel-empty {
  flex: none;
  margin: 0;
  padding: 10px 12px 0;
  color: var(--app-muted);
  font-family: var(--app-mono-font);
  font-size: 12px;
  line-height: 1.5;
  /* One long sentence in a narrow rail may not fit; it wraps rather than disappearing into an
     ellipsis, because every clause of it names something the reader can do. */
  overflow-wrap: anywhere;
}
/* The pending request sits above the input, in its own padding, and takes only the height it
   needs: §5.1 asks that waiting for authorization not lock the editor, and a block that grew
   would take the transcript's room rather than its own. */
.agent-panel-permission {
  flex: none;
  margin: 0 8px 6px;
}
/* The menu's anchor. It sits between the field and the panel, which is why the field's growth
   bound is measured from the panel's own marker rather than from `offsetParent`: `100%` here
   is the composer, and a bound measured against the composer would stop the field growing. */
.agent-panel-compose {
  position: relative;
  flex: none;
}
.agent-panel-menu {
  position: absolute;
  right: 8px;
  bottom: calc(100% + 4px);
  left: 8px;
  z-index: 1;
}
/* How the history list arrives, which is the panel's business because the panel measured where
   it went: the region rung in, its exit fraction out, because by then it has been read. A leaving
   list is on screen for a moment and must not take the dismissing click — hence `pointer-events`
   below. It reaches the popup's element because Vue gives a child component's root the parent's
   scope id as well as its own. */
.agent-history-popup-enter-active {
  transition: opacity var(--app-motion) var(--app-ease),
              transform var(--app-motion) var(--app-ease);
}
.agent-history-popup-leave-active {
  transition: opacity var(--app-motion-exit) var(--app-ease-exit),
              transform var(--app-motion-exit) var(--app-ease-exit);
  pointer-events: none;
}
.agent-history-popup-enter-from,
.agent-history-popup-leave-to {
  opacity: 0;
  transform: translateY(calc(var(--app-motion-travel) * -1)) scale(var(--app-motion-scale-pop));
}
.agent-history-popup.is-above.agent-history-popup-enter-from,
.agent-history-popup.is-above.agent-history-popup-leave-to {
  transform: translateY(var(--app-motion-travel)) scale(var(--app-motion-scale-pop));
}
</style>
