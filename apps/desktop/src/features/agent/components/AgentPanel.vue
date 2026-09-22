<script lang="ts">

export type { AgentPanelLabels } from './agent-panel-labels'
</script>

<script setup lang="ts">

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

  gateway: AgentGateway

  session: AgentSession

  cwd: string

  openable?: boolean

  settingsOpenable?: boolean

  chatOpenable?: boolean

  restartOpenable?: boolean
  labels: AgentPanelLabels
}>()

const emit = defineEmits<{

  resume: [sessionId: string]

  'new-session': []

  'open-settings': []

  'use-chat': []

  restart: []
}>()

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

const capabilityReports = useAgentCapabilityReport({
  gateway: props.gateway,
  session: props.session,
})

const barEl = ref<InstanceType<typeof AgentSessionBar> | null>(null)

const historyEl = ref<InstanceType<typeof AgentSessionHistoryMenu> | null>(null)
const menuEl = ref<InstanceType<typeof AgentPanelMenu> | null>(null)

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
    >
      <template #actions>
        <slot
          name="actions"
          :busy="running || pending !== null"
        />
      </template>
    </AgentSessionBar>

    <AgentPanelNotices
      :labels="labels.notice"
      :gap="gap !== null"
      :dropped="droppedSentence"
      :empty="labels.empty.line"
      :transcript-empty="timeline.length === 0"
      @resync="resync"
    />

    <AgentTimeline
      :key="key"
      :rows="timeline"
      :initial-position="initialPosition"
      :labels="labels.timeline"
      @position="setScroll($event)"
    />

    <AgentPermissionPrompt
      v-if="pending !== null"
      class="agent-panel-permission"
      :request="pending.payload"
      :tool-status="pendingToolStatus"
      :expired="expired"
      @answer="answer"
      @cancel="stop"
    />

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
