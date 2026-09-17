<script lang="ts">
/**
 * What the rail draws for each state the rail's lifecycle can be in, and the words it
 * draws them with.
 *
 * The words are here rather than in the shell because this is the component that shows them,
 * which is the shape the agent settings pages already use: a labels tree built from the
 * catalogue (`agent.rail.*`, `agent.panel.*`) in the file that renders it. `AgentPanel` has no
 * copy of its own (`AgentPanelLabels`), so this file is the caller that supplies it — and it is
 * the only caller, which is why the builder lives beside the markup instead of in a shared
 * module.
 *
 * Three states, and the difference between them is the point:
 *
 *  - **live** — the session, drawn by the panel itself.
 *  - **refused** — the backend's own sentence, verbatim, over the two ways out: ask again, or
 *    go back to the chat panel. §12's rollback is a decision the user takes from here, so it
 *    has to be one click away from the failure rather than buried in settings, and nothing on
 *    this branch may describe the failure as a fault of the app.
 *  - **waiting** — one line, and it is a real state rather than a placeholder: the engine is
 *    being started, or there is no folder open yet for it to work in.
 */
import { t } from '../i18n'
import type { AgentPanelLabels } from '../features/agent'

/**
 * The catalogue, read into the panel's labels tree.
 *
 * One key per sentence and no fallbacks: the panel's copy is required, so a missing key would
 * be a blank word in the transcript rather than an English one — which is why the catalogue's
 * `state`, `result` and `status` records are keyed by the contract's own unions and a new arm
 * there fails to compile here instead.
 *
 * `engineName` is the live arm's own name ({@link AgentRailState} carries it, and it falls back
 * to the agent id). The two sentences that name the engine take it as a slot rather than being
 * assembled from parts here, so a translator sees the whole line. The arms that never mount the
 * panel pass the empty string: their sentences are the rail's own, and the alternative — a name
 * guessed on this side — is the one thing the registry read exists to avoid.
 */
export function agentPanelLabels(engineName: string): AgentPanelLabels {
  return {
    empty: {
      line: t('agent.panel.empty.line', { engine: engineName }),
    },
    bar: {
      untitled: t('agent.panel.bar.untitled', { engine: engineName }),
      state: {
        idle: t('agent.panel.bar.state.idle'),
        starting: t('agent.panel.bar.state.starting'),
        ready: t('agent.panel.bar.state.ready'),
        running: t('agent.panel.bar.state.running'),
        'waiting-permission': t('agent.panel.bar.state.waitingPermission'),
        completed: t('agent.panel.bar.state.completed'),
        cancelled: t('agent.panel.bar.state.cancelled'),
        failed: t('agent.panel.bar.state.failed'),
      },
      result: {
        'end-turn': t('agent.panel.bar.result.endTurn'),
        'max-tokens': t('agent.panel.bar.result.maxTokens'),
        'max-turn-requests': t('agent.panel.bar.result.maxTurnRequests'),
        refusal: t('agent.panel.bar.result.refusal'),
        cancelled: t('agent.panel.bar.result.cancelled'),
        // An ending whose reason this version does not know. It has a sentence of its own rather
        // than reusing one of the five: none of them is true, and the state line is where a
        // reader would go looking for what happened.
        unrecognised: t('agent.panel.bar.result.unrecognised'),
      },
    },
    timeline: {
      aria: t('agent.panel.timeline.aria'),
      you: t('agent.panel.timeline.you'),
      thoughtOpen: t('agent.panel.timeline.thoughtOpen'),
      thoughtClosed: t('agent.panel.timeline.thoughtClosed'),
      jump: t('agent.panel.timeline.jump'),
      tool: {
        status: {
          pending: t('agent.panel.timeline.tool.status.pending'),
          in_progress: t('agent.panel.timeline.tool.status.inProgress'),
          completed: t('agent.panel.timeline.tool.status.completed'),
          failed: t('agent.panel.timeline.tool.status.failed'),
          cancelled: t('agent.panel.timeline.tool.status.cancelled'),
        },
        expand: t('agent.panel.timeline.tool.expand'),
        collapse: t('agent.panel.timeline.tool.collapse'),
        args: t('agent.panel.timeline.tool.args'),
        output: t('agent.panel.timeline.tool.output'),
        argsAbsent: t('agent.panel.timeline.tool.argsAbsent'),
        argsUnreadable: t('agent.panel.timeline.tool.argsUnreadable'),
        outputAbsent: t('agent.panel.timeline.tool.outputAbsent'),
        outputUnreadable: t('agent.panel.timeline.tool.outputUnreadable'),
      },
    },
    composer: {
      placeholder: t('agent.panel.composer.placeholder'),
      send: t('agent.panel.composer.send'),
      stop: t('agent.panel.composer.stop'),
      hint: t('agent.panel.composer.hint'),
      hintBusy: t('agent.panel.composer.hintBusy'),
    },
    notice: {
      gap: t('agent.panel.notice.gap'),
      resync: t('agent.panel.notice.resync'),
    },
  }
}
</script>

<script setup lang="ts">
import { computed } from 'vue'
import { AgentPanel } from '../features/agent'
import type { AgentRailState } from './agent-rail'

const props = defineProps<{
  /** Which state the rail's host is in. */
  state: AgentRailState
  /** Whether a folder is open. The agent works inside one, so "no vault yet" is a sentence
   *  rather than a spinner that would never stop. */
  vaultOpen: boolean
}>()

const emit = defineEmits<{
  (e: 'retry'): void
  (e: 'use-chat'): void
  /** A session the reader picked out of the engine's history. The reopen itself belongs to the
   *  rail (`agent-rail.ts`'s `resume`), which is the layer that owns the vault it is made for. */
  (e: 'resume', sessionId: string): void
}>()

/** The engine's own name, and only while a session is live — the one arm that mounts the panel. */
const engineName = computed(() => (props.state.kind === 'live' ? props.state.engineName : ''))

/** Rebuilt when the locale changes: `t` reads the shared i18n instance, so a computed is what
 *  makes the language switch in General settings reach a panel that is already on screen. */
const labels = computed(() => agentPanelLabels(engineName.value))
</script>

<template>
  <AgentPanel
    v-if="state.kind === 'live'"
    :key="state.key"
    :gateway="state.gateway"
    :session="state.session"
    :cwd="state.cwd"
    :labels="labels"
    @resume="emit('resume', $event)"
  />
  <div
    v-else-if="state.kind === 'refused'"
    class="agent-rail-block"
    data-agent-rail="refused"
    role="status"
  >
    <p class="agent-rail-title">
      {{ t('agent.rail.refused') }}
    </p>
    <p class="agent-rail-sentence">
      {{ state.reason }}
    </p>
    <div class="agent-rail-actions">
      <button
        class="agent-rail-btn"
        type="button"
        data-agent-rail-action="retry"
        @click="emit('retry')"
      >
        {{ t('agent.rail.retry') }}
      </button>
      <button
        class="agent-rail-btn"
        type="button"
        data-agent-rail-action="chat"
        @click="emit('use-chat')"
      >
        {{ t('agent.rail.useChat') }}
      </button>
    </div>
  </div>
  <div
    v-else
    class="agent-rail-block"
    data-agent-rail="waiting"
    role="status"
  >
    <p class="agent-rail-sentence">
      {{ vaultOpen ? t('agent.rail.starting') : t('agent.rail.noVault') }}
    </p>
  </div>
</template>

<style scoped>
.agent-rail-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 12px;
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 12px;
  line-height: 1.6;
}
.agent-rail-title {
  margin: 0;
  color: var(--app-text);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.agent-rail-sentence {
  margin: 0;
  /* The backend's sentence is the one thing on this branch that must not be reworded,
     truncated into a tooltip or elided: it names the program, the profile or the vault. */
  overflow-wrap: anywhere;
}
.agent-rail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}
.agent-rail-btn {
  min-height: 26px;
  padding: 0 10px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-elevated);
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.agent-rail-btn:hover {
  background: color-mix(in srgb, var(--app-elevated) 84%, var(--app-accent-soft));
}
.agent-rail-btn:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
</style>
