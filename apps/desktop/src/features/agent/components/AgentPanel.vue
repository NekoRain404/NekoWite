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
import { computed, onBeforeUnmount, ref } from 'vue'
import type {
  AgentCommand,
  AgentGateway,
  AgentSession,
  AgentToolStatus,
} from '../../../platform/gateways/agent-contracts'
import { useAgentCommands } from '../composables/use-agent-commands'
import { useAgentSession } from '../composables/use-agent-session'
import {
  configControls,
  setConfigOption,
  type AgentConfigControl,
} from '../services/agent-config-options'
import { isRunLive } from '../services/agent-session-view'
import type { AgentToolEntry } from '../services/agent-timeline'
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
  // The predicate is the guard, not only the test: without it `find` answers with the whole
  // `AgentTimelineEntry` union and `status` is a property of one member. `AgentToolEntry` carries
  // it as a required field, so nothing here is being widened — the row that was selected is
  // narrowed to the kind it was selected by.
  const row = timeline.value.find(
    (entry): entry is AgentToolEntry =>
      entry.kind === 'tool' && entry.toolCallId === request.payload.toolCallId,
  )
  return row === undefined ? null : row.status
})

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
async function onConfigSet(key: string, value: string | boolean): Promise<void> {
  const control = config.value.find((entry) => entry.key === key)
  if (control === undefined) return
  configBusy.value = key
  configFailure.value = null
  const outcome = await setConfigOption(props.gateway, props.session, control, value)
  configBusy.value = null
  if (!outcome.accepted && outcome.reason === 'refused') {
    configFailure.value = { key, message: outcome.message }
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
</style>
