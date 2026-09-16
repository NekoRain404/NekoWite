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
 * It also *places* the two components the neighbouring tasks own, because putting them in the
 * session's life is the part that is this file's business: the permission prompt (T7) is
 * rendered for the request the run is waiting on, and the `/` menu (T8) sits over the composer
 * whose keys and text it needs. Both are answered from the binding above — the prompt's answer
 * is the store's own action, and the menu's selection is written back into the draft because
 * §4.1 sends a command as an ordinary prompt. What is deliberately *not* here is the composer's
 * attachment, mode and model controls: the store has no action that could set a model or a
 * mode, so a control for one would be a button that cannot act.
 *
 * The session arrives as a prop and is read once: a panel is mounted *per session*, so the
 * composition site keys it (or remounts it) rather than re-pointing it at another session —
 * a store binding cannot be moved to a session the panel was not mounted for.
 */
import { computed } from 'vue'
import type {
  AgentCommand,
  AgentGateway,
  AgentSession,
  AgentToolStatus,
} from '../../../platform/gateways/agent-contracts'
import { useAgentCommands } from '../composables/use-agent-commands'
import { useAgentSession } from '../composables/use-agent-session'
import { isRunLive } from '../services/agent-session-view'
import { useAgentSessionStore } from '../stores/agent-session'
import AgentCommandMenu from './AgentCommandMenu.vue'
import AgentComposer from './AgentComposer.vue'
import AgentPermissionPrompt from './AgentPermissionPrompt.vue'
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
  answer,
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
 * The status of the tool call the request is about, when the transcript already shows it.
 *
 * `null` is "the host knows nothing here", which T7's prompt must not read as "this call is
 * over": a request whose row has not arrived yet is still waiting for its answer.
 */
const pendingToolStatus = computed<AgentToolStatus | null>(() => {
  const request = pending.value
  if (request === null) return null
  const row = timeline.value.find(
    (entry) => entry.kind === 'tool' && entry.toolCallId === request.payload.toolCallId,
  )
  return row === undefined ? null : row.status
})

/** Whether the request can no longer be answered — the store's own rule, not a second opinion:
 *  an answer for a request whose run is not live is refused there. */
const expired = computed(() => view.value === null || !isRunLive(view.value))

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
 * **The list it filters cannot arrive yet, and this is the one wiring point inside the panel.**
 * `useAgentCommands` is fed the engine's frames through its `accept(event)`; those frames belong
 * to the store, the binding exposes only the *reduced* list (`view.commands`), and there is no
 * event feed to hand over. Until the store offers one — or T8's composable gains an entry point
 * that takes the reduced list — the menu renders its own `waiting` arm, which is honest about
 * what it has been given and is one line from working.
 */
const commands = useAgentCommands({
  identity: () => view.value?.identity ?? null,
  text: () => draft.value,
  select: chooseCommand,
})

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
        :labels="labels.composer"
        @send="onSend"
        @stop="stop"
        @composition="onComposition"
      />
    </div>
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
</style>
