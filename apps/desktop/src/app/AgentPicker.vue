<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Bot, ChevronDown, Plus, Settings2 } from 'lucide-vue-next'
import { t } from '../i18n'
import type { AgentRegistryClient, AgentRegistryEntry } from '../features/agent-settings/services/agent-registry-policy'
import { useDetachedPopup } from '../features/agent/composables/use-detached-popup'
import { popupHostOf } from '../components/popup-host'

const props = defineProps<{ client: AgentRegistryClient; currentAgentId?: string; busy?: boolean }>()
const emit = defineEmits<{ select: [agentId: string]; manage: [page: 'registry' | 'catalogue'] }>()
const trigger = ref<HTMLElement | null>(null)
const popup = ref<HTMLElement | null>(null)
const popupHost = ref<Element | string>('body')
onMounted(() => { popupHost.value = popupHostOf(trigger.value) })
const entries = ref<readonly AgentRegistryEntry[]>([])
const status = ref<'loading' | 'ready' | 'failed'>('loading')
const { open, placement, show, hide } = useDetachedPopup({ floor: 240, claim: 'agent-picker', trigger, popup: () => popup.value })
let generation = 0
const sourceOrder = { bundled: 0, managed: 1, external: 2 }
const enabled = computed(() => entries.value.filter(entry => entry.enabled).sort((left, right) =>
  sourceOrder[left.source] - sourceOrder[right.source] || (left.displayName || left.agentId).localeCompare(right.displayName || right.agentId),
))
function entryTitle(entry: AgentRegistryEntry): string {
  if (props.busy) return t('agent.registry.picker.busy')
  return entry.programState === 'launchable' ? entry.program : t(`agent.registry.programState.${entry.programState}`, { path: entry.program })
}

function close(): void { generation += 1; hide(); trigger.value?.focus() }
async function load(): Promise<void> {
  const mine = ++generation
  status.value = 'loading'
  try {
    const readout = await props.client.read()
    if (mine !== generation) return
    entries.value = readout.entries
    status.value = 'ready'
  } catch {
    if (mine === generation) status.value = 'failed'
  }
  await nextTick()
  if (mine === generation && open.value) popup.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
}
async function toggle(): Promise<void> {
  if (open.value) { close(); return }
  await show()
  await load()
}
function choose(entry: AgentRegistryEntry): void {
  if (props.busy || entry.programState !== 'launchable') return
  close()
  emit('select', entry.agentId)
}
function manage(page: 'registry' | 'catalogue'): void { close(); emit('manage', page) }
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = Array.from(popup.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  if (!buttons.length) return
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}
onBeforeUnmount(() => { generation += 1 })
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="agent-picker-trigger"
    data-agent-picker
    :title="t('agent.registry.picker.title')"
    :aria-label="t('agent.registry.picker.title')"
    aria-haspopup="menu"
    :aria-expanded="open"
    @click="toggle"
    @keydown.down.prevent="toggle"
  >
    <Bot
      :size="15"
      aria-hidden="true"
    />
    <ChevronDown
      :size="12"
      aria-hidden="true"
    />
  </button>
  <Teleport :to="popupHost">
    <div
      v-if="open"
      ref="popup"
      class="agent-picker-menu"
      role="menu"
      :aria-label="t('agent.registry.picker.title')"
      :style="{ left: `${placement.left}px`, top: `${placement.top}px`, minWidth: `${placement.minWidth}px` }"
      @keydown="keydown"
    >
      <span
        v-if="status === 'loading'"
        role="status"
      >{{ t('agent.registry.list.loading') }}</span>
      <template v-else-if="status === 'failed'">
        <span role="alert">{{ t('agent.registry.list.unreadable') }}</span>
        <button
          type="button"
          role="menuitem"
          @click="load"
        >
          {{ t('agent.registry.list.retry') }}
        </button>
      </template>
      <template v-else>
        <span v-if="!enabled.length">{{ t('agent.registry.list.empty') }}</span>
        <template
          v-for="(entry, index) in enabled"
          :key="entry.agentId"
        >
          <span
            v-if="index === 0 || enabled[index - 1]?.source !== entry.source"
            class="agent-picker-group"
          >{{ t(`agent.registry.provenance.${entry.source}`) }}</span>
          <button
            type="button"
            role="menuitem"
            :data-agent-choice="entry.agentId"
            :disabled="busy || entry.programState !== 'launchable'"
            :title="entryTitle(entry)"
            @click="choose(entry)"
          >
            <Bot
              :size="15"
              aria-hidden="true"
            /><span>{{ entry.displayName || entry.agentId }}</span><span
              v-if="entry.agentId === currentAgentId"
              class="agent-picker-current"
            >{{ t('agent.registry.picker.current') }}</span>
          </button>
        </template>
      </template>
      <div class="agent-picker-divider" />
      <button
        type="button"
        role="menuitem"
        data-agent-add
        @click="manage('catalogue')"
      >
        <Plus
          :size="15"
          aria-hidden="true"
        />{{ t('agent.registry.picker.add') }}
      </button>
      <button
        type="button"
        role="menuitem"
        data-agent-manage
        @click="manage('registry')"
      >
        <Settings2
          :size="15"
          aria-hidden="true"
        />{{ t('agent.registry.picker.manage') }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.agent-picker-trigger { display: inline-flex; align-items: center; justify-content: center; gap: 2px; align-self: center; flex: none; width: 34px; height: 26px; border: 0; border-radius: var(--app-radius-sm); background: transparent; color: var(--app-muted); cursor: pointer; }
.agent-picker-trigger:hover, .agent-picker-trigger[aria-expanded='true'] { background: var(--app-elevated); color: var(--app-accent); }
.agent-picker-menu { position: fixed; z-index: 1000; max-width: calc(100vw - 16px); max-height: min(420px, calc(100vh - 16px)); overflow: auto; padding: 4px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-panel); color: var(--app-text); box-shadow: 0 5px 18px #0003; font: 12px var(--app-font); }
.agent-picker-menu button { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 30px; padding: 6px 8px; border: 0; border-radius: var(--app-radius-sm); background: transparent; color: inherit; text-align: left; cursor: pointer; }
.agent-picker-menu button:hover, .agent-picker-menu button:focus-visible { background: var(--app-elevated); outline: 1px solid var(--app-accent); }
.agent-picker-menu button:disabled { opacity: .45; cursor: default; }
.agent-picker-menu button span { overflow-wrap: anywhere; min-width: 0; }
.agent-picker-menu svg { flex: none; }
.agent-picker-current { margin-left: auto; color: var(--app-muted); font-size: 10px; }
.agent-picker-menu > span { display: block; padding: 8px; }
.agent-picker-divider { border-top: 1px solid var(--app-border); margin: 4px 0; }
.agent-picker-group { display: block; padding: 6px 8px 3px; color: var(--app-muted); font-size: 11px; }
</style>
