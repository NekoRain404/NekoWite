<script lang="ts">

import { t } from '../i18n'
import type { AgentPanelLabels } from '../features/agent'

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
      attached: t('agent.panel.timeline.attached'),
      thoughtOpen: t('agent.panel.timeline.thoughtOpen'),
      thoughtClosed: t('agent.panel.timeline.thoughtClosed'),
      controls: {
        jump: t('agent.panel.timeline.jump'),
        follow: t('agent.panel.timeline.follow'),
        followStop: t('agent.panel.timeline.followStop'),
        copy: t('agent.panel.timeline.copy'),
        copied: t('agent.panel.timeline.copied'),
        copyFailed: t('agent.panel.timeline.copyFailed'),
        toUser: t('agent.panel.timeline.toUser'),
        toTop: t('agent.panel.timeline.toTop'),
      },
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
    menu: {
      label: t('agent.panel.menu.label'),
      settings: t('agent.panel.menu.settings'),
      // The same sentence as the refused arm's 用对话面板 button, and deliberately the same key:
      // the two controls ask for one thing, and two strings would be two places for it to drift.
      chat: t('agent.rail.useChat'),
      // The same again, with the rail's own retry button: the live panel's row and the refused
      // block's button both run `agent-rail.ts`'s `retry()`, so they are one control in two
      // places and they say one thing.
      restart: t('agent.rail.retry'),
    },
  }
}
</script>

<script setup lang="ts">
import { computed } from 'vue'
import { AgentPanel } from '../features/agent'
import type { AgentRailState } from './agent-rail'
import AgentPicker from './AgentPicker.vue'
import type { AgentRegistryClient } from '../features/agent-settings/services/agent-registry-policy'

const props = defineProps<{

  state: AgentRailState

  vaultOpen: boolean
  registry?: AgentRegistryClient
}>()

const emit = defineEmits<{

  (e: 'retry'): void
  (e: 'use-chat'): void

  (e: 'resume', sessionId: string): void

  (e: 'new-session', agentId?: string): void

  (e: 'open-settings', page?: 'registry' | 'catalogue'): void
}>()

const engineName = computed(() => (props.state.kind === 'live' ? props.state.engineName : ''))

const labels = computed(() => agentPanelLabels(engineName.value))
</script>

<template>
  <AgentPanel
    v-if="state.kind === 'live'"
    :key="state.key"
    :gateway="state.gateway"
    :session="state.session"
    :cwd="state.cwd"
    :openable="true"
    :settings-openable="true"
    :chat-openable="true"
    :restart-openable="true"
    :labels="labels"
    @new-session="emit('new-session')"
    @resume="emit('resume', $event)"
    @open-settings="emit('open-settings')"
    @use-chat="emit('use-chat')"
    @restart="emit('retry')"
  >
    <template #actions="{ busy }">
      <AgentPicker
        v-if="registry"
        :client="registry"
        :current-agent-id="state.session.agentId"
        :busy="busy"
        @select="emit('new-session', $event)"
        @manage="emit('open-settings', $event)"
      />
    </template>
  </AgentPanel>
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
      <AgentPicker
        v-if="registry"
        :client="registry"
        @select="emit('new-session', $event)"
        @manage="emit('open-settings', $event)"
      />
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
