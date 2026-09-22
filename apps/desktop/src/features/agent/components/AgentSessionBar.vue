<script lang="ts">

import type {
  AgentRunEnding,
  AgentSessionState,
} from '../../../platform/gateways/agent-contracts'

export interface AgentSessionBarLabels {

  untitled: string

  state: Record<AgentSessionState, string>

  result: Record<AgentRunEnding, string>

  history?: string
}
</script>

<script setup lang="ts">

import { computed, ref } from 'vue'
import {
  Circle,
  CircleCheck,
  CircleSlash,
  CircleX,
  History,
  Loader,
  MoreHorizontal,
  ShieldQuestion,
} from 'lucide-vue-next'
import { t } from '../../../i18n'
import type { AgentRunResult, AgentUsage } from '../../../platform/gateways/agent-contracts'
import { turnDurationParts } from '../services/agent-turn-stats'

const props = defineProps<{

  title: string | null

  state: AgentSessionState | null

  failure: { code: string; message: string } | null

  result: AgentRunResult | null

  elapsedMs: number | null

  history: boolean

  historyOpen: boolean

  menu: boolean

  menuOpen: boolean

  menuLabel: string
  labels: AgentSessionBarLabels
}>()

const emit = defineEmits<{

  history: []

  menu: []
}>()

const triggerEl = ref<HTMLButtonElement | null>(null)
const menuTriggerEl = ref<HTMLButtonElement | null>(null)

function triggerElement(): HTMLElement | null {
  return triggerEl.value
}

function menuElement(): HTMLElement | null {
  return menuTriggerEl.value
}

defineExpose({ triggerElement, menuElement })

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (!props.menuOpen) return
    event.preventDefault()
    event.stopPropagation()
    emit('menu')
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (props.menuOpen) return
    event.preventDefault()
    emit('menu')
  }
}

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

const SPINNING: readonly AgentSessionState[] = ['starting', 'running']

const stateLabel = computed(() =>
  props.state === null ? '' : props.labels.state[props.state],
)
const stateIcon = computed(() => (props.state === null ? Circle : STATE_ICONS[props.state]))
const spinning = computed(() => props.state !== null && SPINNING.includes(props.state))

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

const usage = computed<AgentUsage | null>(() => props.result?.usage ?? null)

const USAGE_COUNTERS: readonly (keyof AgentUsage)[] = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'thoughtTokens',
  'cachedReadTokens',
  'cachedWriteTokens',
]

function humanized(count: number): string {
  if (count < 1_000) return String(count)
  const thousands = count / 1_000
  if (thousands < 10) return `${oneDecimal(thousands)}k`
  if (thousands < 1_000) return `${Math.round(thousands)}k`
  return `${oneDecimal(count / 1_000_000)}M`
}

function oneDecimal(value: number): string {
  return (Math.round(value * 10) / 10).toString().replace(/\.0$/, '')
}

function counterLine(counter: keyof AgentUsage, count: number): string {
  switch (counter) {
    case 'inputTokens':
      return t('agent.panel.bar.usage.detail.input', { n: count })
    case 'outputTokens':
      return t('agent.panel.bar.usage.detail.output', { n: count })
    case 'totalTokens':
      return t('agent.panel.bar.usage.detail.total', { n: count })
    case 'thoughtTokens':
      return t('agent.panel.bar.usage.detail.thought', { n: count })
    case 'cachedReadTokens':
      return t('agent.panel.bar.usage.detail.cachedRead', { n: count })
    case 'cachedWriteTokens':
      return t('agent.panel.bar.usage.detail.cachedWrite', { n: count })
  }
}

const usageParts = computed<readonly string[]>(() => {
  const held = usage.value
  if (held === null) return []
  if (held.totalTokens !== undefined) {
    return [t('agent.panel.bar.usage.total', { n: humanized(held.totalTokens) })]
  }
  const parts: string[] = []
  if (held.inputTokens !== undefined) {
    parts.push(t('agent.panel.bar.usage.input', { n: humanized(held.inputTokens) }))
  }
  if (held.outputTokens !== undefined) {
    parts.push(t('agent.panel.bar.usage.output', { n: humanized(held.outputTokens) }))
  }
  return parts
})

const usageDetail = computed<string | null>(() => {
  const held = usage.value
  if (held === null) return null
  const lines: string[] = []
  for (const counter of USAGE_COUNTERS) {
    const count = held[counter]
    if (count !== undefined) lines.push(counterLine(counter, count))
  }
  return lines.length === 0 ? null : lines.join('\n')
})

const elapsedLabel = computed<string | null>(() => {
  const ms = props.elapsedMs
  if (ms === null) return null
  const { hours, minutes, seconds } = turnDurationParts(ms)
  if (hours > 0) return t('agent.panel.bar.elapsed.hours', { h: hours, m: minutes, s: seconds })
  if (minutes > 0) return t('agent.panel.bar.elapsed.minutes', { m: minutes, s: seconds })
  return t('agent.panel.bar.elapsed.seconds', { s: seconds })
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
    <slot name="actions" />

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

    <button
      v-if="menu"
      ref="menuTriggerEl"
      class="agent-bar-menu"
      type="button"
      data-agent-menu
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      :title="menuLabel"
      :aria-label="menuLabel"
      @click="emit('menu')"
      @keydown="onMenuKeydown"
    >
      <MoreHorizontal
        :size="14"
        :stroke-width="1.8"
        aria-hidden="true"
      />
    </button>

    <p
      v-if="elapsedLabel !== null"
      class="agent-bar-clock"
      data-agent-clock
    >
      {{ elapsedLabel }}
    </p>
    <p
      v-if="usageParts.length > 0"
      class="agent-bar-usage"
      data-agent-usage
      :title="usageDetail ?? undefined"
    >
      {{ usageParts.join(' · ') }}
    </p>
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

<style scoped src="./agent-session-bar.css"></style>
