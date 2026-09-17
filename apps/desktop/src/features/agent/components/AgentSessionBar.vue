<script lang="ts">
/**
 * The bar's copy, handed in rather than reached for — see {@link AgentToolLabels} for why, and
 * for what happens when the catalogue grows keys.
 */
import type {
  AgentRunEnding,
  AgentSessionState,
} from '../../../platform/gateways/agent-contracts'

export interface AgentSessionBarLabels {
  /** Shown until the engine names the session. It carries the engine's own name — the caller
   *  fills the slot from the registry's registration (see `AgentRailBody`), so the title says
   *  which engine is running instead of a word this app chose for all of them. */
  untitled: string
  /** One word per session state, keyed by the contract's own states: a state added later
   *  fails to typecheck here rather than rendering as a blank. */
  state: Record<AgentSessionState, string>
  /** How a run ended, per ending the contract can report. `end-turn` is the ordinary ending and
   *  is never shown; the other four say something a reader wants to know — a ceiling was hit, the
   *  engine refused, the run was stopped — and so does an ending whose reason this version does
   *  not know, which is a fact about the engine rather than a failure of the turn. */
  result: Record<AgentRunEnding, string>
  /** The history control's accessible name and tooltip. Optional with a catalogue default, the
   *  direction the newer components beside this one take (`AgentCommandMenu.vue`,
   *  `AgentConfigPicker.vue`): the words for a control are the control's own, and a caller only
   *  overrides them when it has something more specific to say. */
  history?: string
}
</script>

<script setup lang="ts">
/**
 * The session's title bar: what this session is, and what it is doing.
 *
 * Props in, events out. The one control §5.3 puts in this strip beyond the title — history, the
 * action over the session *list* — is here as a trigger and nothing more: pressing it is an
 * event, and the list itself is the panel's, which is where the gateway and the session are.
 * **Whether it is drawn at all is not this component's decision** (`history`): the panel draws it
 * only when the engine's own report says it answers `session/list`, so a bar with no such report
 * has no button rather than a disabled one. The title is shown, not edited: the contract lets the
 * engine name a session (`session-changed`) and offers the host no way to name one back, so a
 * rename control here would be a button that cannot act.
 *
 * The state line is the panel's screen-reader status cue (§5.2 「支持…屏幕阅读器状态提示；
 * 不能每 token 都触发朗读」). It is a `role="status"` region on purpose and it changes when the
 * *run* changes, which is a handful of times per turn — the transcript beside it is
 * `aria-live="off"` for exactly the reason this is not.
 *
 * The status is a word, an icon and a colour in that order of importance: §5.3 asks for text
 * and icon together so that the restrained status colours are never the only signal.
 */
import { computed, ref } from 'vue'
import {
  Circle,
  CircleCheck,
  CircleSlash,
  CircleX,
  History,
  Loader,
  ShieldQuestion,
} from 'lucide-vue-next'
import { t } from '../../../i18n'
import type { AgentRunResult } from '../../../platform/gateways/agent-contracts'

const props = defineProps<{
  /** The engine's title, or null until it sends one. */
  title: string | null
  /** Where the session's state machine is. Null before a session view exists. */
  state: AgentSessionState | null
  /** Why a run did not run to its own end, in the engine's or the runtime's own words. */
  failure: { code: string; message: string } | null
  /** How the last run ended. Its stop reason is shown only when it is not the ordinary one. */
  result: AgentRunResult | null
  /**
   * Whether to draw the history control — the panel's answer, from the engine's own report.
   *
   * A prop rather than a condition here, because what decides it is a capability this component
   * has no way to ask about: the panel calls `AgentGateway.capabilities` and passes the answer
   * down. False draws no button at all, which is the whole point of asking.
   */
  history: boolean
  /** Whether the list it opens is up, for `aria-expanded` — the state lives in the panel. */
  historyOpen: boolean
  labels: AgentSessionBarLabels
}>()

const emit = defineEmits<{
  /** The user asked for the sessions this engine holds. The panel draws the list. */
  history: []
}>()

const triggerEl = ref<HTMLButtonElement | null>(null)

/** The element the panel measures its popup against. Exposed rather than kept here because the
 *  list is the panel's (it is the layer that holds the gateway), and the app's popup recipe
 *  measures from the control it hangs off. */
function triggerElement(): HTMLElement | null {
  return triggerEl.value
}

defineExpose({ triggerElement })

/** The catalogue's own name for this control, unless the caller said otherwise. */
const historyLabel = computed(() => props.labels.history ?? t('agent.panel.bar.history'))

const STATE_ICONS: Record<AgentSessionState, typeof Circle> = {
  idle: Circle,
  starting: Loader,
  ready: Circle,
  running: Loader,
  'waiting-permission': ShieldQuestion,
  completed: CircleCheck,
  cancelled: CircleSlash,
  failed: CircleX,
}

/** The states in which something is still happening, and so the ones whose icon turns. */
const SPINNING: readonly AgentSessionState[] = ['starting', 'running']

const stateLabel = computed(() =>
  props.state === null ? '' : props.labels.state[props.state],
)
const stateIcon = computed(() => (props.state === null ? Circle : STATE_ICONS[props.state]))
const spinning = computed(() => props.state !== null && SPINNING.includes(props.state))

/** The second half of the line: why, when there is a why. A failure carries the engine's own
 *  message; an ordinary ending says nothing, and the four that are not ordinary say which one
 *  they were (§5.1: a token ceiling is not a failure and must not read as one).
 *
 *  An ending this version does not know is one of the four that say something, and it carries
 *  the engine's own word in brackets when there is one. That word is the whole of what a reader
 *  — or a bug report — can act on: the sentence says the reason was not recognised, and the word
 *  says which reason it was. */
const detail = computed(() => {
  if (props.failure !== null) return props.failure.message
  const result = props.result
  if (result === null) return null
  const reason = result.stopReason
  if (reason === 'end-turn') return null
  if (reason === 'unrecognised' && result.unrecognisedReason !== undefined) {
    return `${props.labels.result[reason]} (${result.unrecognisedReason})`
  }
  return props.labels.result[reason]
})
</script>

<template>
  <header class="agent-bar">
    <h2
      class="agent-bar-title"
      :title="title ?? labels.untitled"
    >
      {{ title ?? labels.untitled }}
    </h2>
    <!-- §5.3's one control beyond the title, and only when the engine said it answers the call
         behind it. `aria-haspopup` and `aria-expanded` carry the state; the list's own element is
         the panel's (it is teleported to the body), so this control does not name it. -->
    <button
      v-if="history"
      ref="triggerEl"
      class="agent-bar-history"
      type="button"
      data-agent-history
      aria-haspopup="listbox"
      :aria-expanded="historyOpen"
      :title="historyLabel"
      :aria-label="historyLabel"
      @click="emit('history')"
    >
      <History
        :size="13"
        :stroke-width="1.8"
        aria-hidden="true"
      />
    </button>
    <p
      class="agent-bar-state"
      role="status"
      aria-live="polite"
      :data-state="state ?? 'none'"
    >
      <component
        :is="stateIcon"
        class="agent-bar-state-icon"
        :class="{ 'is-spinning': spinning }"
        :size="12"
        :stroke-width="1.8"
        aria-hidden="true"
      />
      <span class="agent-bar-state-word">{{ stateLabel }}</span>
      <span
        v-if="detail"
        class="agent-bar-detail"
        :title="detail"
      >
        {{ detail }}
      </span>
    </p>
  </header>
</template>

<style scoped>
.agent-bar {
  display: flex;
  align-items: baseline;
  gap: 8px;
  /* §5.3's title bar: 36–40px, one rung, no second navigation row. */
  min-height: 38px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--app-border);
  flex: none;
}
.agent-bar-title {
  flex: 1;
  margin: 0;
  min-width: 0;
  overflow: hidden;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The strip is baseline-aligned for the title and the state word; a control has no baseline to
   sit on, so it centres itself in the row instead. Quiet by default — this is a title bar, and
   the one thing here that must draw the eye is the state it is reporting. */
.agent-bar-history {
  display: inline-flex;
  align-self: center;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.agent-bar-history:hover {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
  color: var(--app-text);
}
/* Open, it reads as held: the list below belongs to this control. */
.agent-bar-history[aria-expanded='true'] {
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
  color: var(--app-accent);
}
.agent-bar-history:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.agent-bar-state {
  display: inline-flex;
  flex: none;
  max-width: 55%;
  align-items: center;
  gap: 4px;
  margin: 0;
  color: var(--app-muted);
  font-size: 11px;
  white-space: nowrap;
}
.agent-bar-state-icon {
  flex: none;
}
.agent-bar-state-icon.is-spinning {
  animation: agent-bar-spin var(--app-motion-spin) linear infinite;
}
@keyframes agent-bar-spin {
  to {
    transform: rotate(360deg);
  }
}
.agent-bar-state-word {
  flex: none;
}
.agent-bar-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* The two states worth a colour, and only as the second signal: the word beside each one
   already says the same thing. */
.agent-bar-state[data-state='failed'] {
  color: var(--app-danger);
}
.agent-bar-state[data-state='waiting-permission'] {
  color: var(--app-warn);
}
</style>
