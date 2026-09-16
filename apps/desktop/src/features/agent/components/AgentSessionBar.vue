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
}
</script>

<script setup lang="ts">
/**
 * The session's title bar: what this session is, and what it is doing.
 *
 * Props in, events out — and in fact nothing out, because everything §5.3 puts in this strip
 * beyond the title (history, new session, more) is an action over the *session list*, which
 * is a different part of the feature than this one renders. The title is shown, not edited:
 * the contract lets the engine name a session (`session-changed`) and offers the host no way
 * to name one back, so a rename control here would be a button that cannot act.
 *
 * The state line is the panel's screen-reader status cue (§5.2 「支持…屏幕阅读器状态提示；
 * 不能每 token 都触发朗读」). It is a `role="status"` region on purpose and it changes when the
 * *run* changes, which is a handful of times per turn — the transcript beside it is
 * `aria-live="off"` for exactly the reason this is not.
 *
 * The status is a word, an icon and a colour in that order of importance: §5.3 asks for text
 * and icon together so that the restrained status colours are never the only signal.
 */
import { computed } from 'vue'
import {
  Circle,
  CircleCheck,
  CircleSlash,
  CircleX,
  Loader,
  ShieldQuestion,
} from 'lucide-vue-next'
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
  labels: AgentSessionBarLabels
}>()

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
