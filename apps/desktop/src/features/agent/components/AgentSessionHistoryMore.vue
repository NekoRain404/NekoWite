<script setup lang="ts">
/**
 * The way to the page the engine named, drawn under the list.
 *
 * Split out of `AgentSessionHistoryMenu.vue` at the line budget. It is a control and not a
 * sentence, and that is the whole reason it exists as one: the sentence used to say a further page
 * was there and offer no way to it, which is this app's own worst shape — a surface claiming
 * something the reader cannot reach — so the words are the button's explanation (`title`) and the
 * press is the act.
 *
 * Whether it is drawn at all is the menu's answer (`more`), and so is whether a read is in flight:
 * `disabled` while one is, because a second press would ask for the same page twice. What the
 * button's own words say — which page, and how far the list has come — is the copy's business.
 */
import { t } from '../../../i18n'

defineProps<{
  /** Whether the page the engine named is being read right now. */
  busy: boolean
  /** Why the last attempt at that page failed, in the gateway's own sentence. Optional as well as
   *  nullable, because the menu forwards a prop that is itself optional: absent and null are both
   *  "nothing went wrong", which is what the sentence's own guard below reads. */
  reason?: string | null
}>()

const emit = defineEmits<{
  /** The user asked for the page the engine named. The caller holds the cursor and the gateway. */
  more: []
}>()
</script>

<template>
  <div
    class="agent-history-more"
    role="presentation"
  >
    <button
      class="agent-history-more-btn"
      type="button"
      data-history-more
      :title="t('agent.panel.history.more')"
      :disabled="busy"
      :aria-busy="busy ? 'true' : undefined"
      @mousedown.prevent
      @click="emit('more')"
    >
      {{ busy ? t('agent.panel.history.moreLoad.loading') : t('agent.panel.history.moreLoad.load') }}
    </button>
    <p
      v-if="reason !== null && reason !== undefined"
      class="agent-history-more-reason"
      data-history-more-failed
      role="status"
    >
      {{ t('agent.panel.history.moreLoad.failed', { reason }) }}
    </p>
  </div>
</template>

<style scoped>
.agent-history-more {
  padding: 6px 8px 2px;
  border-top: 1px solid var(--app-border);
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.agent-history-more-btn {
  min-height: 26px;
  width: 100%;
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
.agent-history-more-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-elevated) 84%, var(--app-accent-soft));
}
.agent-history-more-btn:disabled {
  color: var(--app-muted);
  cursor: default;
}
.agent-history-more-btn:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.agent-history-more-reason {
  margin: 4px 0 0;
}
</style>
