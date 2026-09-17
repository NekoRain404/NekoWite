<script setup lang="ts">
/**
 * The history list's head: the find box, and the one entry in this popup that is not a row.
 *
 * Split out of the list for the reason the app splits any control that has grown its own
 * keyboard and its own geometry: the list owns the rows, the highlight and the engine's answer,
 * and this owns a field and a button. It is the same division the config picker uses
 * (`AgentConfigOptionsPopup.vue` draws the filter box; the picker owns the query and the index),
 * and the two boxes are the same box: a text field inside a popup whose keys belong to the list
 * under it.
 *
 * **Neither half decides anything.** The query is a prop with an `update:query` event, so the
 * list keeps one copy of it, and the entry is drawn only when the caller said it can carry the
 * call out (`openable`) — opening a session is the rail's move, and a popup that offered it
 * whenever it had rows would be offering something nobody had said it could do.
 *
 * The field is a `combobox` in ARIA's own sense: the listbox it filters is named by `listId`, the
 * row the arrows are on is named by `activeOptionId` (absent when a search has left no rows, and
 * then the box says it is not expanded and points at nothing), and the list under it does not
 * hold a second keyboard — the arrows, Home/End and Enter all arrive at the list's own handler by
 * bubbling, which is what lets a reader type, arrow and commit without leaving the field.
 */
import { nextTick, ref } from 'vue'
import { Plus, Search, X } from 'lucide-vue-next'
import { t } from '../../../i18n'

const props = defineProps<{
  /** What is in the box. Owned by the list, which is also where the query is applied. */
  query: string
  /** Whether the box is drawn at all: there is one only when there are rows to narrow, and a
   *  field over an empty list would be a control that cannot act. */
  searchable: boolean
  /** Whether the caller can open a new session on the runtime this list belongs to. */
  openable: boolean
  /** The listbox's id, which the box's `aria-controls` names. */
  listId: string
  /** The option the arrows are on, or `undefined` when the search left no rows to point at. */
  activeOptionId: string | undefined
}>()

const emit = defineEmits<{
  'update:query': [value: string]
  /** The reader asked for a new session. The caller decides what that means and who does it. */
  open: []
}>()

const queryEl = ref<HTMLInputElement | null>(null)

/** Focus the box: the list's own `focus()` sends the reader here on arrival, because a list that
 *  is filtered by typing should not need a second press before it can be. */
function focusQuery(): void {
  queryEl.value?.focus()
}

/**
 * Give the whole list back.
 *
 * What is cleared is the query and nothing else — the engine's rows are not this popup's to
 * forget — and the focus stays in the box, because a reader who cleared it is about to type
 * again rather than to leave.
 */
function clear(): void {
  emit('update:query', '')
  void nextTick(() => focusQuery())
}

defineExpose({ focusQuery })
</script>

<template>
  <div
    class="agent-history-head"
    role="presentation"
  >
    <div
      v-if="searchable"
      class="agent-history-find"
      role="search"
    >
      <!-- Decoration: the box's own name is on the box, and a second announcement of "search"
           beside a field already labelled is noise. Zed's own bar leads with the same icon
           (`threads_archive_view.rs:899-903`). -->
      <Search
        class="agent-history-find-icon"
        :size="12"
        :stroke-width="1.8"
        aria-hidden="true"
      />
      <input
        ref="queryEl"
        class="agent-history-find-input"
        type="text"
        spellcheck="false"
        role="combobox"
        aria-autocomplete="list"
        :value="query"
        :aria-label="t('agent.panel.history.search.label')"
        :placeholder="t('agent.panel.history.search.placeholder')"
        :aria-expanded="activeOptionId !== undefined"
        :aria-controls="activeOptionId === undefined ? undefined : listId"
        :aria-activedescendant="activeOptionId"
        data-history-search
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      >
      <!-- Drawn only while there is something to clear, and it is the query it clears: the rows
           the engine sent come back the moment the box is empty. -->
      <button
        v-if="query !== ''"
        class="agent-history-find-clear"
        type="button"
        :title="t('agent.panel.history.search.clear')"
        :aria-label="t('agent.panel.history.search.clear')"
        data-history-clear
        @mousedown.prevent
        @click="clear"
      >
        <X
          :size="12"
          :stroke-width="1.8"
          aria-hidden="true"
        />
      </button>
    </div>
    <!-- One press, no question: this takes nothing away from the session that is open — it stays
         in this list, and the tooltip is where that is said, because the name alone ("New
         session") does not say it. -->
    <button
      v-if="openable"
      class="agent-history-new"
      type="button"
      :title="t('agent.panel.history.newSession.note')"
      :aria-label="t('agent.panel.history.newSession.label')"
      data-history-new
      @mousedown.prevent
      @click="emit('open')"
    >
      <Plus
        :size="13"
        :stroke-width="1.8"
        aria-hidden="true"
      />
    </button>
  </div>
</template>

<style scoped>
/* A row at the top of the popup, kept there while the rows scroll under it: a search box that
   scrolls away is one the reader has to hunt for in the list it is filtering. The popup itself is
   the scroller (`AgentSessionHistoryMenu.vue`), so the stickiness is against its padding box. */
.agent-history-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
  background: color-mix(in srgb, var(--app-elevated) 96%, var(--app-panel));
}
.agent-history-find {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 0 6px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-panel);
}
.agent-history-find:focus-within {
  outline: 2px solid var(--app-accent);
  outline-offset: -1px;
}
.agent-history-find-icon {
  flex: none;
  color: var(--app-muted);
}
.agent-history-find-input {
  flex: 1;
  min-width: 0;
  padding: 5px 0;
  border: 0;
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  /* The box is the ring: a second outline inside it would draw two rectangles. */
  outline: none;
}
.agent-history-find-input::placeholder {
  color: var(--app-muted);
}
.agent-history-find-clear,
.agent-history-new {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.agent-history-new {
  border: 1px solid var(--app-border);
  background: var(--app-panel);
}
.agent-history-find-clear:hover,
.agent-history-new:hover {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
  color: var(--app-text);
}
.agent-history-find-clear:focus-visible,
.agent-history-new:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -1px;
}
</style>
