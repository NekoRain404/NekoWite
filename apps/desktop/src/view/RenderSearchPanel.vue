<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  Replace,
  ReplaceAll,
  SpellCheck,
  X,
} from 'lucide-vue-next'
import { t } from '../i18n'
import {
  closePanel,
  formatCount,
  moveActive,
  openPanel,
  renderSearchState,
  replaceAll,
  replaceCurrent,
  setCaseSensitive,
  setQuery,
  setSpellEnabled,
} from '../services/renderSearch'

const emit = defineEmits<{ (e: 'close'): void }>()

const findInput = ref<HTMLInputElement | null>(null)
const countText = computed(() => formatCount())
const hasQuery = computed(() => renderSearchState.query.length > 0)
const notFound = computed(
  () => hasQuery.value && renderSearchState.ranges.length === 0,
)
const replaceCount = ref(0)

function doReplaceAll(): void {
  const count = renderSearchState.ranges.length
  replaceAll()
  replaceCount.value = count
}

watch(
  () => renderSearchState.ranges.length,
  () => {
    replaceCount.value = 0
  },
)

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
    return
  }
  if (e.key !== 'Enter') return
  e.preventDefault()
  if (e.target === findInput.value) {
    if (e.shiftKey) moveActive(-1)
    else moveActive(1)
  }
}

onMounted(() => {
  openPanel()
  findInput.value?.focus()
  findInput.value?.select()
})

onBeforeUnmount(() => {
  closePanel()
})
</script>

<template>
  <div
    class="nw-render-search"
    role="search"
    @keydown.stop="onKeydown"
  >
    <div class="rs-row">
      <input
        ref="findInput"
        v-model="renderSearchState.query"
        class="rs-field"
        :placeholder="t('find.placeholder')"
        type="text"
        autocomplete="off"
        spellcheck="false"
        @input="setQuery(renderSearchState.query)"
      >
      <span
        class="rs-count"
        :class="{ 'is-empty': notFound }"
      >{{ countText }}</span>
      <span
        v-if="notFound"
        class="rs-empty-hint"
      >{{ t('find.notFound') }}</span>
      <div class="rs-group">
        <button
          class="rs-btn"
          type="button"
          :title="t('find.previous')"
          :aria-label="t('find.previous')"
          @mousedown.prevent
          @click="moveActive(-1)"
        >
          <ChevronUp :size="14" />
        </button>
        <button
          class="rs-btn"
          type="button"
          :title="t('find.next')"
          :aria-label="t('find.next')"
          @mousedown.prevent
          @click="moveActive(1)"
        >
          <ChevronDown :size="14" />
        </button>
      </div>
      <button
        class="rs-btn"
        type="button"
        :class="{ 'is-active': renderSearchState.caseSensitive }"
        :title="t('find.caseSensitive')"
        :aria-pressed="renderSearchState.caseSensitive"
        @mousedown.prevent
        @click="setCaseSensitive(!renderSearchState.caseSensitive)"
      >
        <CaseSensitive :size="14" />
      </button>
      <button
        class="rs-btn"
        type="button"
        :class="{ 'is-active': renderSearchState.spellEnabled }"
        :title="t('spell.title')"
        :aria-pressed="renderSearchState.spellEnabled"
        @mousedown.prevent
        @click="setSpellEnabled(!renderSearchState.spellEnabled)"
      >
        <SpellCheck :size="14" />
      </button>
      <button
        class="rs-btn rs-close"
        type="button"
        :title="t('find.closeEsc')"
        :aria-label="t('find.closeEsc')"
        @mousedown.prevent
        @click="emit('close')"
      >
        <X :size="14" />
      </button>
    </div>
    <div class="rs-row rs-row-replace">
      <input
        v-model="renderSearchState.replace"
        class="rs-field"
        :placeholder="t('find.replaceWith')"
        type="text"
        autocomplete="off"
        spellcheck="false"
      >
      <div class="rs-group">
        <button
          class="rs-btn rs-action"
          type="button"
          :disabled="!hasQuery"
          @mousedown.prevent
          @click="replaceCurrent"
        >
          <Replace :size="14" />
          {{ t('find.replace') }}
        </button>
        <button
          class="rs-btn rs-action"
          type="button"
          :disabled="!hasQuery"
          @mousedown.prevent
          @click="doReplaceAll"
        >
          <ReplaceAll :size="14" />
          {{ t('find.replaceAll') }}
        </button>
      </div>
      <span
        v-if="replaceCount"
        class="rs-replaced"
      >{{ t('find.replaced', { count: replaceCount }) }}</span>
    </div>
  </div>
</template>

<style scoped>
.nw-render-search {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  min-width: 340px;
  max-width: 92%;
  background: var(--app-elevated);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-md);
  box-shadow: 0 8px 28px color-mix(in srgb, var(--app-text) 16%, transparent);
  font-family: var(--app-font);
  font-size: 12px;
}
.rs-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rs-field {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid color-mix(in srgb, var(--app-border) 72%, transparent);
  border-radius: var(--app-radius-sm);
  background: var(--app-canvas);
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  outline: none;
}
.rs-field:focus {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
}
.rs-count {
  min-width: 48px;
  text-align: center;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
}
.rs-count.is-empty {
  color: var(--app-danger);
}
.rs-empty-hint {
  color: var(--app-muted);
  white-space: nowrap;
}
.rs-group {
  display: flex;
  align-items: center;
  gap: 2px;
}
.rs-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 26px;
  height: 26px;
  padding: 0 7px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 11px;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.rs-btn:hover:not(:disabled) {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 62%, transparent);
}
.rs-btn.is-active {
  color: var(--app-accent-contrast);
  background: var(--app-accent);
}
.rs-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.rs-action {
  padding: 0 10px;
}
.rs-replaced {
  color: var(--app-muted);
  white-space: nowrap;
}
</style>