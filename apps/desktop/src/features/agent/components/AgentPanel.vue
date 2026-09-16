<script lang="ts">
/**
 * The panel's copy tree, handed in rather than reached for.
 *
 * One prop for the whole panel, holding one entry per component that needs words. The
 * catalogue has keys for the command menu and the permission prompt and none for anything
 * this task draws, and this task does not own `src/i18n/namespaces/agent.ts` — so the words
 * arrive from above, which keeps every missing sentence a visible integration point instead
 * of an English string shipped in its place. When the keys land, each component's defaults
 * move into it and these props become overrides.
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
 * Three things §5.3 draws that are deliberately *not* here, each because the layer below
 * cannot carry it yet: the permission prompt (the engine's answer options are in the store,
 * and T7's component is the one that renders them), the `/` command menu (T8's), and the
 * attachment, mode and model controls of the composer's bar — the store has no action that
 * could set a model or a mode, so a control for one would be a button that cannot act.
 *
 * The session arrives as a prop and is read once: a panel is mounted *per session*, so the
 * composition site keys it (or remounts it) rather than re-pointing it at another session —
 * a store binding cannot be moved to a session the panel was not mounted for.
 */
import { computed } from 'vue'
import type { AgentGateway, AgentSession } from '../../../platform/gateways/agent-contracts'
import { useAgentSession } from '../composables/use-agent-session'
import { isRunLive } from '../services/agent-session-view'
import { useAgentSessionStore } from '../stores/agent-session'
import AgentComposer from './AgentComposer.vue'
import AgentSessionBar from './AgentSessionBar.vue'
import AgentTimeline from './AgentTimeline.vue'

const props = defineProps<{
  /** The adapter behind the session, chosen at the composition site (§6.1). */
  gateway: AgentGateway
  /** The session to show. Read once — see the note above about mounting per session. */
  session: AgentSession
  labels: AgentPanelLabels
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
  resync,
  setScroll,
} = useAgentSession({ gateway: props.gateway, session: props.session })

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

/** The composer's own question: is a run in flight, so that its button is a stop. Read from
 *  the view through the store's own definition of "live" rather than a second list of states
 *  that could drift from it. */
const running = computed(() => view.value !== null && isRunLive(view.value))

function onSend(text: string): void {
  // A refusal is the store's to report and it keeps the text itself (§5.1: an error does not
  // clear the draft); there is nothing for the panel to do with the outcome here.
  void send(text)
}
</script>

<template>
  <section
    class="agent-panel"
    data-agent-panel
  >
    <AgentSessionBar
      :title="view?.title ?? null"
      :state="state"
      :failure="view?.failure ?? null"
      :result="view?.lastResult ?? null"
      :labels="labels.bar"
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
    <!-- Keyed by the session: the timeline remembers where the reader was for one session's
         rows, and a switch is a different transcript rather than the same one re-pointed. -->
    <AgentTimeline
      :key="key"
      :rows="timeline"
      :initial-position="initialPosition"
      :labels="labels.timeline"
      @position="setScroll($event)"
    />
    <AgentComposer
      v-model="draft"
      :running="running"
      :can-send="canSend"
      :labels="labels.composer"
      @send="onSend"
      @stop="stop"
    />
  </section>
</template>

<style scoped>
.agent-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
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
</style>
