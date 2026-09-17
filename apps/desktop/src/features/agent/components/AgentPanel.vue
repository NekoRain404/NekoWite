<script lang="ts">
/**
 * The panel's copy tree, which lives beside this file and is re-exported from here.
 *
 * The move is the one `agent_runtime/permissions.rs` made for `PermissionPrompt`: the type is the
 * panel's *interface with its caller*, so it declares its own module next to the component that
 * takes it, and this file keeps the name importable so that `app/AgentRailBody.vue`,
 * `features/agent/index.ts` and the panel's own tests go on importing it from where it has always
 * been.
 */
export type { AgentPanelLabels } from './agent-panel-labels'
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
 *
 * **Four of this panel's concerns are not in this file**, and each is one subject with its own
 * rules rather than a slice of this one: the conversation's read-only facts
 * (`use-agent-conversation`), the engine's other sessions (`use-agent-session-history`), the
 * options menu (`use-agent-panel-menu`) and the `/` menu's wiring (`use-agent-command-menu`).
 * They were moved out when this file went past the size this project allows one component, and
 * they moved as *moves* — the template below still places every block, which is what this file's
 * job is, and the comments travelled with the code they explain.
 */
import { computed, onMounted, ref } from 'vue'
import type {
  AgentCapabilityReport,
  AgentGateway,
  AgentPromptAttachment,
  AgentSession,
} from '../../../platform/gateways/agent-contracts'
import { useAgentSession } from '../composables/use-agent-session'
import { useAgentCommandMenu } from '../composables/use-agent-command-menu'
import { useAgentConfigRow } from '../composables/use-agent-config-row'
import { useAgentConversation } from '../composables/use-agent-conversation'
import { useAgentPanelMenu } from '../composables/use-agent-panel-menu'
import { useAgentSessionHistory } from '../composables/use-agent-session-history'
import type { AgentPanelLabels } from './agent-panel-labels'
import { useAgentSessionStore } from '../stores/agent-session'
import AgentComposer from './AgentComposer.vue'
import AgentCommandMenu from './AgentCommandMenu.vue'
import AgentPanelMenu from './AgentPanelMenu.vue'
import AgentPanelNotices from './AgentPanelNotices.vue'
import AgentPermissionPrompt from './AgentPermissionPrompt.vue'
import AgentSessionBar from './AgentSessionBar.vue'
import AgentSessionHistoryMenu from './AgentSessionHistoryMenu.vue'
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
  /**
   * Whether the rail behind this panel can open a new session — a capability of the *rail*,
   * which is what owns the runtime a session is opened on, and therefore not something this
   * component can answer for itself. Absent means no: the panel draws the entry only when its
   * caller says it can act, so a panel mounted anywhere else (`AgentPanel.test.ts` mounts one
   * over a gateway with no rail at all) has no control that could be pressed and do nothing.
   */
  openable?: boolean
  /**
   * Whether the caller can open the settings dialog on the agents tree — the options menu's door,
   * and the same rule as {@link openable}.
   *
   * The dialog is not this component's and never becomes it: `showSettings` is the window root's
   * and the landing section travels with the request (`features/settings/types.ts`,
   * `SettingsOpenTarget`). A panel whose caller says no here draws no such row, rather than one
   * that emits into nothing.
   */
  settingsOpenable?: boolean
  /**
   * Whether the caller can put the rail back on the chat panel — the same rule again.
   *
   * The rail already offers this way out from its refused state (`AgentRailBody.vue`'s 用对话面板
   * action), and the live panel had no equivalent: a reader who wanted the chat back had to find
   * the switch in the settings dialog, or close and reopen the rail on the other tab.
   */
  chatOpenable?: boolean
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
  /**
   * The reader asked for a new session on the runtime that is up.
   *
   * An event for the same reason `resume` is one: opening a session is the rail's — it composes
   * the runtime, and it replaces the session this panel is mounted on, which a panel cannot do
   * to itself (`AgentRailBody.vue` → `agent-rail.ts`'s `newSession`).
   */
  'new-session': []
  /**
   * The reader asked for the agent settings.
   *
   * An event, and an unparameterised one: the *landing place* — the `agents` section — is a fact
   * about where this app keeps the agent pages rather than something a panel decides, so it is
   * the shell that names it (`AppShell.vue`'s `openAgentSettings`). A panel that carried the
   * section id would be a second place the navigation's vocabulary is written down.
   */
  'open-settings': []
  /**
   * The reader asked for the chat panel instead of this one.
   *
   * An event for the reason `resume` is one, one rung out: the switch belongs to
   * `stores/settings-agent.ts`, and the thing it does is unmount *this* panel — a component
   * cannot take itself off the rail, and the session behind it outlives the surface either way.
   * The name is the rail's own (`AgentRailBody.vue` emits it from the refused state), so the two
   * gestures that ask for the chat panel are one word rather than two.
   */
  'use-chat': []
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
 * The conversation on screen: what this session is called, how long the turn has taken, and the
 * request it is waiting on. Read-only derivations of the view the binding above returns — the
 * rules behind them, and why each is written the way it is, are in `use-agent-conversation`.
 *
 * The one thing supplied from here is the timeline's opening position, for §5.1
 * 「每会话独立…滚动位置」: read from the store rather than taken as a prop, because the binding
 * above writes the position (`setScroll`) and has no reader for it. A session the panel has shown
 * before keeps its record across a collapse, and this is the only moment that record is of any
 * use. A record that does not exist yet means nobody has read this session — `undefined` opens it
 * at the end rather than at offset 0, which is what a first look wants. The one case the store
 * cannot tell apart is a record that exists but was never scrolled; that is a session whose
 * transcript the reader has not seen, and opening it at the end is the cheaper mistake.
 */
const {
  title,
  initialPosition,
  droppedSentence,
  running,
  elapsedMs,
  pending,
  pendingToolStatus,
  expired,
} = useAgentConversation({
  session: props.session,
  view,
  dropped,
  lastDrop,
  initialScrollTop: store.recordFor(key)?.scrollTop,
})

/** The `/` menu (T8): the engine's published commands for this session, filtered by the token
 *  being typed. Both halves of it are the panel's — the draft is the store's and the keys are the
 *  composer's — which is why it is wired here and owned by `use-agent-command-menu`. */
const { commands, choose: chooseCommand, composition: onComposition } = useAgentCommandMenu({
  view,
  text: draft,
})

/** The composer's control row: the session's own config options, and the one write the panel
 *  makes to the session's state. The call itself is `use-agent-config-row`'s. */
const {
  controls: config,
  busy: configBusy,
  failure: configFailure,
  set: onConfigSet,
} = useAgentConfigRow({
  gateway: props.gateway,
  session: props.session,
  view,
  adopt: (options) => store.adoptOptions(key, options),
})

/**
 * The whole report, kept as it arrived, for the surfaces that need a fact this panel does not read
 * itself.
 *
 * The composer is handed the *report* rather than two more booleans, because a boolean cannot
 * carry the third state: `unavailable` and `unverified` are different facts about an engine, and a
 * surface that showed them alike would be telling a reader their engine refuses something nobody
 * ever asked it. The history surface reads its own two gates off the same report — an engine may
 * answer `session/close` without answering `session/list`, and each control is drawn on its own
 * answer rather than on the pair.
 *
 * The report belongs to the runtime the session belongs to and is read once, on mount: a panel is
 * mounted per session, and a runtime the host has replaced has no answer left to give.
 */
const capabilityReports = ref<readonly AgentCapabilityReport[] | null>(null)

onMounted(async () => {
  try {
    capabilityReports.value = await props.gateway.capabilities(props.session)
  } catch {
    // Nothing arrived, so nothing is offered — and the composer is left with `null` rather than
    // with an empty report. The two are different states: one is an engine that answered nothing,
    // the other an engine that answered "no".
    capabilityReports.value = null
  }
})

const barEl = ref<InstanceType<typeof AgentSessionBar> | null>(null)
/** The two teleported popups, rendered by the template below and measured by the composables. */
const historyEl = ref<InstanceType<typeof AgentSessionHistoryMenu> | null>(null)
const menuEl = ref<InstanceType<typeof AgentPanelMenu> | null>(null)

/**
 * The engine's *other* sessions (§5.3's history control): whether the control may be drawn at all,
 * the list it opens, and the free action's two calls. The control itself is the bar's; everything
 * behind it is `use-agent-session-history`'s, which is also where each gate and each of the four
 * states is explained.
 *
 * The three things this file supplies are the ones only it has: the element the list hangs from
 * and the element the list *is* — both of which the template below owns — and the two events a
 * pick or a new-session leaves through. Both leave the component rather than being carried out
 * here, because a load has to be made for the rail's vault and it replaces the session this panel
 * is mounted on.
 */
const {
  offered: historyOffered,
  closeable: closeOffered,
  open: historyOpen,
  placement: historyPlacement,
  view: historyView,
  rows: historyRows,
  reason: historyReason,
  more: historyMore,
  moreBusy: historyMoreBusy,
  moreReason: historyMoreReason,
  now: historyAt,
  footer: historyFooter,
  confirming: freeTarget,
  listId: historyListId,
  toggle: openHistory,
  close: closeHistory,
  loadMore: loadMoreHistory,
  ask: askFree,
  cancel: cancelFree,
  confirm: confirmFree,
  pick: onHistoryPick,
  openNew: onHistoryNew,
} = useAgentSessionHistory({
  gateway: props.gateway,
  sessionId: props.session.sessionId,
  cwd: props.cwd,
  capabilities: capabilityReports,
  openable: props.openable === true,
  trigger: computed(() => barEl.value?.triggerElement() ?? null),
  popup: historyEl,
  onResume: (sessionId) => emit('resume', sessionId),
  onNewSession: () => emit('new-session'),
})

/** The options menu, whose two rows are both doors out of this component — see
 *  `use-agent-panel-menu` for why each is gated on its own capability. */
const {
  rows: menuRows,
  open: menuOpenState,
  placement: menuPlacement,
  toggle: toggleMenu,
  close: closeMenu,
  choose: chooseMenuRow,
} = useAgentPanelMenu({
  trigger: computed(() => barEl.value?.menuElement() ?? null),
  popup: menuEl,
  settingsOpenable: props.settingsOpenable === true,
  chatOpenable: props.chatOpenable === true,
  labels: { settings: props.labels.menu.settings, chat: props.labels.menu.chat },
  onSettings: () => emit('open-settings'),
  onChat: () => emit('use-chat'),
})

function onSend(text: string, attachments: readonly AgentPromptAttachment[]): void {
  // A refusal is the store's to report and it keeps the text itself (§5.1: an error does not
  // clear the draft); there is nothing for the panel to do with the outcome here.
  void send(text, attachments)
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
      :elapsed-ms="elapsedMs"
      :history="historyOffered"
      :history-open="historyOpen"
      :menu="menuRows.length > 0"
      :menu-open="menuOpenState"
      :menu-label="labels.menu.label"
      :labels="labels.bar"
      @history="openHistory"
      @menu="toggleMenu"
    />
    <!-- The three lines about the record, directly under the title rule: the gap notice and its
         resync, the refused-frame count, and the transcript's first line while there is no
         transcript. Each is drawn only when it has something true to say — the component's own
         note carries the reasons. -->
    <AgentPanelNotices
      :labels="labels.notice"
      :gap="gap !== null"
      :dropped="droppedSentence"
      :empty="labels.empty.line"
      :transcript-empty="timeline.length === 0"
      @resync="resync"
    />
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
        :capabilities="capabilityReports"
        :labels="labels.composer"
        @send="onSend"
        @stop="stop"
        @composition="onComposition"
        @set-config="onConfigSet"
      />
    </div>
    <!-- The options menu, teleported and placed against the control in the bar for the same
         reasons the list below is: the rail body scrolls and would clip it, and the placement is
         the composable's. It is drawn on the panel's own answer — {@link menuRows} non-empty —
         so a panel whose caller can carry no row has no popup and no control to open one. -->
    <Teleport to="body">
      <Transition name="agent-history-popup">
        <AgentPanelMenu
          v-if="menuOpenState"
          ref="menuEl"
          :rows="menuRows"
          :labels="{ label: labels.menu.label }"
          :left="menuPlacement.left"
          :top="menuPlacement.top"
          :min-width="menuPlacement.minWidth"
          :drop="menuPlacement.drop"
          @select="chooseMenuRow"
          @close="closeMenu"
        />
      </Transition>
    </Teleport>
    <!-- The engine's sessions, teleported to the body and placed against the control in the bar
         by `useDetachedPopup`: the rail body scrolls, and a list drawn inside it would be clipped
         by a container it has nothing to do with. It is the panel's list rather than the bar's
         because the gateway and the session are here — the bar draws the control and nothing
         else. -->
    <Teleport to="body">
      <Transition name="agent-history-popup">
        <AgentSessionHistoryMenu
          v-if="historyOpen"
          ref="historyEl"
          :view="historyView"
          :rows="historyRows"
          :reason="historyReason"
          :more="historyMore"
          :more-busy="historyMoreBusy"
          :more-reason="historyMoreReason"
          :closeable="closeOffered"
          :openable="openable === true"
          :footer="historyFooter"
          :confirming="freeTarget"
          :now="historyAt"
          :list-id="historyListId"
          :left="historyPlacement.left"
          :top="historyPlacement.top"
          :min-width="historyPlacement.minWidth"
          :drop="historyPlacement.drop"
          @activate="onHistoryPick"
          @open="onHistoryNew"
          @more="loadMoreHistory"
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
