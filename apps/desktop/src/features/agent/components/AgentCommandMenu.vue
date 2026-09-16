<script lang="ts">
/**
 * Every sentence the menu shows, overridable by whoever wires it up.
 *
 * This was a required prop while the keys did not exist: the app's catalogue
 * enforces both directions — a key the source uses must be defined, and a
 * defined key must be used — so a component reaching for `agent.commandMenu.empty`
 * would have failed that check or needed a catalogue file the task did not own.
 * Taking the copy as an argument kept the missing keys a visible integration
 * point instead of an English string quietly shipped in their place.
 *
 * The keys now exist (`src/i18n/namespaces/agent.ts`), so the prop is optional
 * and the defaults come from `t()`. It stays overridable because the caller is
 * the one holding the failure `code` and may want to say more about it than the
 * generic sentence can.
 */
export interface AgentCommandMenuLabels {
  /** Names the list for a screen reader. */
  aria: string
  /** No list has arrived for this session yet. */
  waiting: string
  /** The engine published a list, and it was empty. */
  empty: string
  /** There are published commands, but none match the token being typed. */
  noMatch: string
  /** The list could not be received. */
  unavailable: string
}
</script>

<script setup lang="ts">
/**
 * The `/` menu's rows: the commands the engine published, the one Enter would
 * take, and the sentence that stands in when there is nothing to show.
 *
 * It draws a list and reports what the user did to a row — no store, no
 * gateway, no protocol (§6.1): `view` and `commands` arrive already decided by
 * `useAgentCommands`, and nothing here inspects a frame or a key.
 *
 * Two of its rules are about the boundary rather than the drawing. The rows are
 * the engine's list and nothing else, so there is no way for an action the app
 * owns to appear among them (§4.1: 「插入选区」「打开变更」and their like get a
 * surface of their own rather than squatting the `/` namespace). And the four
 * ways of having nothing to show are four different renderings rather than one
 * empty box, because §4.1 asks the menu to say which one it is: waiting for the
 * engine, published-and-empty, nothing matching, and could-not-be-received.
 */
import { computed } from 'vue'
import type { AgentCommand, AgentFailureCode } from '../../../platform/gateways/agent-contracts'
import type { AgentCommandMenuView } from '../composables/use-agent-commands'
import { t } from '../../../i18n'

const props = defineProps<{
  /** What to draw; `closed` means the composer's text is not an unfinished command. */
  view: AgentCommandMenuView
  /** The published commands matching the token, in the engine's order. */
  commands: AgentCommand[]
  /** The row Enter would take, as an index into `commands`. */
  activeIndex: number
  /** The failure behind an `unavailable` list, for the caller's wording. */
  reason: AgentFailureCode | null
  /** Overrides for the default copy; see {@link AgentCommandMenuLabels}. */
  labels?: Partial<AgentCommandMenuLabels>
}>()

const emit = defineEmits<{
  /** The user settled on a command — a click, or Enter on the highlighted row. */
  select: [command: AgentCommand]
  /** The pointer moved onto a row: it becomes the one Enter would take. */
  highlight: [index: number]
}>()

/** Defaults from the catalogue, with any caller override layered on top. */
const labels = computed((): AgentCommandMenuLabels => ({
  aria: t('agent.commandMenu.aria'),
  waiting: t('agent.commandMenu.waiting'),
  empty: t('agent.commandMenu.empty'),
  noMatch: t('agent.commandMenu.noMatch'),
  unavailable: t('agent.commandMenu.unavailable'),
  ...props.labels,
}))

const notice = computed((): string => {
  switch (props.view) {
    case 'waiting':
      return labels.value.waiting
    case 'empty':
      return labels.value.empty
    case 'no-match':
      return labels.value.noMatch
    case 'unavailable':
      return labels.value.unavailable
    default:
      return ''
  }
})
</script>

<template>
  <div
    v-if="view !== 'closed'"
    class="agent-command-menu"
    role="listbox"
    :aria-label="labels.aria"
    :data-view="view"
  >
    <button
      v-for="(command, index) in view === 'rows' ? commands : []"
      :key="command.name"
      class="agent-command-item"
      :class="{ 'is-active': index === activeIndex }"
      type="button"
      role="option"
      :aria-selected="index === activeIndex"
      :data-index="index"
      :data-name="command.name"
      tabindex="-1"
      @mousedown.prevent
      @mouseenter="emit('highlight', index)"
      @click="emit('select', command)"
    >
      <span class="agent-command-name">/{{ command.name }}</span>
      <!-- Absent when the engine advertised the command without describing it:
           §4.1 gives the description as optional, and an empty line reads as a
           rendering bug rather than as a missing field. -->
      <span
        v-if="command.description"
        class="agent-command-description"
      >{{ command.description }}</span>
    </button>
    <!-- role=presentation: a listbox may only own options, and a notice in
         between would otherwise be announced as one it could be picked. -->
    <p
      v-if="view !== 'rows'"
      class="agent-command-notice"
      role="presentation"
      :data-reason="reason ?? undefined"
    >
      {{ notice }}
    </p>
  </div>
</template>

<style scoped>
.agent-command-menu {
  max-height: min(280px, 44vh);
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-elevated);
}
.agent-command-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.agent-command-item.is-active {
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
}
.agent-command-name {
  flex: none;
  font-weight: 550;
}
.agent-command-item.is-active .agent-command-name {
  color: var(--app-accent);
}
.agent-command-description {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--app-muted);
}
.agent-command-notice {
  margin: 0;
  padding: 16px 8px;
  color: var(--app-muted);
  font-size: 12px;
  text-align: center;
}
</style>
