<script setup lang="ts">
/**
 * The note list's search box: the query and the content-search toggle.
 *
 * It holds no query of its own — the value is the store's, handed down as a
 * prop and reported back on every keystroke, so the box and the list can never
 * disagree about what is being searched. The toggle only marks the intent to
 * search note bodies; whether that search is running, and what it found, is the
 * list's own state.
 */
import { Search, TextSearch } from 'lucide-vue-next'
import { t } from '../../../i18n'

const props = defineProps<{
  query: string
  contentEnabled: boolean
}>()

const emit = defineEmits<{
  (e: 'search', value: string): void
  (e: 'toggle-content'): void
}>()
</script>

<template>
  <div class="nl-search">
    <Search
      class="nl-search-icon"
      :size="14"
      :stroke-width="1.8"
    />
    <input
      :value="props.query"
      class="nl-search-input"
      type="text"
      :placeholder="t(props.contentEnabled ? 'notelist.contentSearchHint' : 'notelist.search')"
      @input="emit('search', ($event.target as HTMLInputElement).value)"
    >
    <button
      type="button"
      class="nl-search-toggle"
      :class="{ on: props.contentEnabled }"
      :title="t('notelist.searchContent')"
      :aria-pressed="props.contentEnabled"
      @click="emit('toggle-content')"
    >
      <TextSearch
        :size="13"
        :stroke-width="1.8"
      />
    </button>
  </div>
</template>

<style scoped>
.nl-search {
  position: relative;
  display: block;
  margin: 4px 12px 0;
}
.nl-search-icon {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--app-muted);
  pointer-events: none;
}
.nl-search-input {
  width: 100%;
  height: 30px;
  padding: 0 30px 0 28px;
  font-family: var(--app-font);
  font-size: 12px;
  font-weight: 450;
  letter-spacing: -0.01em;
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 42%, var(--app-panel));
  border: 1px solid color-mix(in srgb, var(--app-border) 54%, transparent);
  border-radius: var(--app-radius-lg);
  outline: none;
  transition: border-color var(--app-motion-fast) var(--app-ease),
              background var(--app-motion-fast) var(--app-ease),
              box-shadow var(--app-motion-fast) var(--app-ease);
}
.nl-search-input::placeholder { color: color-mix(in srgb, var(--app-muted) 82%, transparent); }
.nl-search-input:hover {
  border-color: color-mix(in srgb, var(--app-border) 88%, transparent);
}
.nl-search-input:focus {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
  background: color-mix(in srgb, var(--app-elevated) 72%, var(--app-panel));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 14%, transparent);
}
.nl-search-toggle {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: color var(--app-motion-fast) var(--app-ease),
              background var(--app-motion-fast) var(--app-ease);
}
.nl-search-toggle:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.nl-search-toggle.on {
  color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent-soft) 60%, transparent);
}
.nl-search-toggle:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
</style>
