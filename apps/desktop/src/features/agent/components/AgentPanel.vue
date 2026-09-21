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
 * Everything it draws takes props and emits; what it *reads* from the session it is mounted on is
 * `use-agent-panel-session`'s, because the three acceptance rules of §5.1 are about the *panel's*
 * life rather than its parts:
 *
 *  - **the session outlives the panel** (§5.1 「任务可以在面板收起后继续」). Nothing here stops a
 *    run — there is no `stop` on unmount, and the only thing teardown does is release the
 *    subscription, which `useAgentSession` owns. The subscription is re-established from a
 *    snapshot when the panel comes back (§6.2's handshake, which exists for exactly this), so a
 *    rail that closes and opens is not a run that was interrupted or a transcript that was lost.
 *  - **the draft and the position are the session's**, not the panel's: they live in the store,
 *    keyed by the session's identity, so collapsing the rail cannot take them with it (§5.1).
 *  - **a hole in the stream is said out loud.** A gap means the transcript on screen is not
 *    the session's record, and the one honest thing to offer is a resync rather than a
 *    silent partial answer.
 *
 * It is also where the engine's *other* sessions are reached, through the bar's history control:
 * the capability check that decides whether the control exists, the `listSessions` read and the rows
 * the engine's own answer draws are the popups' files (`use-agent-panel-popups`,
 * `use-agent-session-history`). Picking one leaves as an event (`resume`): a load has to be made for
 * the rail's vault and it replaces the session this panel is mounted on, so the call belongs to
 * whoever owns that lifecycle, not here.
 *
 * It also *places* the three components the neighbouring tasks own, because putting them in the
 * session's life is the part that is this file's business: the permission prompt (T7) is
 * rendered for the request the run is waiting on, the `/` menu (T8) sits over the composer whose
 * keys and text it needs, and the transcript's first line is drawn here while the transcript is
 * empty. Both answers are the store's own actions — the prompt's answer, and the menu's
 * selection written back into the draft, because §4.1 sends a command as an ordinary prompt.
 *
 * The composer's control row is the session's own config options, on the right of the bar below the
 * field (§5.3's 「模型菜单」, and Zed's arrangement of the same row); its state is
 * `use-agent-config-row`'s and `use-agent-panel-session` binds it. **The three facts this file used
 * to record as a backend gap have changed, and the note is rewritten rather than dropped because one
 * of them still holds in a narrower form.** The host vocabulary
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
 * **Everything that is not this file's own wiring lives in a file named for its subject**, and each
 * is one reason to change rather than a slice of this one: the panel's binding to its session, with
 * the two store reads only that key can address (`use-agent-panel-session`), the conversation's
 * read-only facts (`use-agent-conversation`), the `/` menu's wiring (`use-agent-command-menu`), the
 * composer's control row (`use-agent-config-row`), the engine's other sessions
 * (`use-agent-session-history`), the options menu (`use-agent-panel-menu`), the engine's own account
 * of what it answers (`use-agent-capability-report`) and the two popups' hosting and events
 * (`use-agent-panel-popups`). They were moved out when this file went past the size this project
 * allows one component, and they moved as *moves* — the template below still places every block,
 * which is what this file's job is, and the comments travelled with the code they explain.
 */
import { ref } from 'vue'
import type {
  AgentGateway,
  AgentPromptAttachment,
  AgentSession,
} from '../../../platform/gateways/agent-contracts'
import { useAgentCapabilityReport } from '../composables/use-agent-capability-report'
import { useAgentPanelPopups } from '../composables/use-agent-panel-popups'
import { useAgentPanelSession } from '../composables/use-agent-panel-session'
import type { AgentPanelLabels } from './agent-panel-labels'
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
  /** The directory this runtime works in — the vault root on disk — handed to the history list
   *  unchanged. What the one comparison it feeds means is stated once, where it is made:
   *  `agent-session-history.ts`'s `AgentSessionHistoryInput`. */
  cwd: string
  /**
   * Whether the rail behind this panel can open a new session — a capability of the *rail*,
   * which is what owns the runtime a session is opened on, and therefore not something this
   * component can answer for itself. Absent means no: the history list offers its new-session
   * entry only when its caller says it can act, so a panel mounted anywhere else
   * (`AgentPanel.test.ts` mounts one over a gateway with no rail at all) has no control that
   * could be pressed and do nothing. That offer travels by the template below, and there is no
   * option of `use-agent-session-history` carrying it: the one that was there was never read —
   * the entry's own `v-if` (`AgentSessionHistoryHead.vue`) is where the gate is drawn.
   */
  openable?: boolean
  /**
   * Whether the caller can open the settings dialog on the agents tree — the options menu's door.
   *
   * Read where the door is built: the row exists only while this says so, which makes
   * `use-agent-panel-menu.ts`'s `settingsOpenable` the gate's one statement, and this prop the
   * value the app hands it.
   */
  settingsOpenable?: boolean
  /** Whether the caller can put the rail back on the chat panel — the options menu's other door.
   *  Same shape as {@link settingsOpenable}: built, and explained, in `use-agent-panel-menu.ts`. */
  chatOpenable?: boolean
  /**
   * Whether the caller can take the engine down and bring it back up.
   *
   * Same shape again, and the reader it exists for is the one no other control serves: the rail's
   * retry action has always been there and lives in the *refused* block, so a reader whose engine
   * started and then wedged had no door at all — only quitting the app. Absent means no, so a
   * panel mounted over a gateway with no rail behind it draws no row that would act on nothing.
   *
   * What it costs is stated where it is paid: a restart ends the session this panel is showing
   * and opens a new one, so the transcript on screen is replaced. `use-agent-panel-menu.ts`'s
   * `restartOpenable` says why the restart is the rail's to make.
   */
  restartOpenable?: boolean
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
  /**
   * The reader asked for the engine to be taken down and brought back up.
   *
   * An event for the reason `resume` is one, and the strongest case of it: a restart is the rail's
   * `retry()` — it tears the runtime down and composes a new one with a new `runtimeEpoch`, so
   * every handle minted by the old one is stale and every surface mounted on its session has to
   * be re-pointed. A panel that did this itself would be a second place the rail's generation
   * latch is not.
   */
  restart: []
}>()

/**
 * The session this panel is mounted on, and everything the panel reads from it: the binding to the
 * store, the conversation's facts, the `/` menu over the draft and the composer's config row. See
 * `use-agent-panel-session`, which binds the four together and is where the two store reads that
 * only this panel's key can address — the opening position and the engine's refreshed option list —
 * are made.
 */
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
  title,
  initialPosition,
  droppedSentence,
  running,
  elapsedMs,
  pending,
  pendingToolStatus,
  expired,
  commands,
  choose: chooseCommand,
  composition: onComposition,
  controls: config,
  busy: configBusy,
  failure: configFailure,
  set: onConfigSet,
} = useAgentPanelSession({ gateway: props.gateway, session: props.session })

/** The engine's own account of what it answers, for this panel's runtime — read once, on mount, by
 *  `use-agent-capability-report`, which is also where the `null` that is a state of its own, and the
 *  sentence a `null` decides, are explained. Two surfaces read the ref: the composer takes the
 *  *report* rather than two booleans, and the history list reads its own two gates off the same
 *  value. */
const capabilityReports = useAgentCapabilityReport({
  gateway: props.gateway,
  session: props.session,
})

const barEl = ref<InstanceType<typeof AgentSessionBar> | null>(null)
/** The two teleported popups, rendered by the template below and measured by the composables. */
const historyEl = ref<InstanceType<typeof AgentSessionHistoryMenu> | null>(null)
const menuEl = ref<InstanceType<typeof AgentPanelMenu> | null>(null)

/**
 * The panel's two popups — the options menu and the engine's session list — together with the
 * element their controls are, and the element each is teleported into. `use-agent-panel-popups` owns
 * that placement and binds the two menus behind it to this panel's own events.
 *
 * The two hosts and the two menus' state below are unpacked into top-level bindings rather than read
 * as `popups.history.open`, and that is not a style choice. Vue unwraps a ref only when it is a
 * binding of the setup scope; a ref reached *through* a plain object stays a `Ref` where the template
 * reads it, and a `Ref` is truthy — so `v-if="popups.history.open"` would draw the list after it was
 * closed, and `:left="popups.history.placement.left"` would read a property off the ref instead of
 * the box. The names below are the ones the template has always used.
 */
const popups = useAgentPanelPopups({
  bar: barEl,
  optionsMenu: menuEl,
  historyMenu: historyEl,
  gateway: props.gateway,
  session: props.session,
  cwd: props.cwd,
  capabilities: capabilityReports,
  menuLabels: props.labels.menu,
  settingsOpenable: props.settingsOpenable === true,
  chatOpenable: props.chatOpenable === true,
  restartOpenable: props.restartOpenable === true,
  onResume: (sessionId) => emit('resume', sessionId),
  onNewSession: () => emit('new-session'),
  onOpenSettings: () => emit('open-settings'),
  onUseChat: () => emit('use-chat'),
  onRestart: () => emit('restart'),
})

const { menuHost, historyHost } = popups

/**
 * The two menus' own state, unpacked for the template — see the note above the popups call for why
 * these cannot be read as `popups.history.*`. What each value is, and which gate draws which
 * control, is `use-agent-session-history`'s and `use-agent-panel-menu`'s.
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
} = popups.history

const {
  rows: menuRows,
  open: menuOpenState,
  placement: menuPlacement,
  toggle: toggleMenu,
  close: closeMenu,
  choose: chooseMenuRow,
} = popups.menu

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
      <!-- The workspace the composer addresses its files, its mentions and the `+`'s listing in:
           the vault of the session *this panel* is mounted on, taken from the prop above rather
           than from the store's focused record — a pointer the pet's task link moves to another
           session (`app/pet-task-link.ts`) while this panel stays on screen. -->
      <AgentComposer
        v-model="draft"
        :running="running"
        :can-send="canSend"
        :resolve-key="commands.onKeydown"
        :vault="session.vaultId"
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
    <Teleport :to="menuHost">
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
    <!-- The engine's sessions, teleported into the shell and placed against the control in the
         bar by `useDetachedPopup`: the rail body scrolls, and a list drawn inside it would be
         clipped by a container it has nothing to do with. It is the panel's list rather than the
         bar's because the gateway and the session are here — the bar draws the control and nothing
         else. -->
    <Teleport :to="historyHost">
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
