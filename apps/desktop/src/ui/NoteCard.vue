<script setup lang="ts">
import { computed } from 'vue'
import { Code2, FileText, Star } from 'lucide-vue-next'
import { formatRelativeTime } from '../services/noteMeta'
import type { NoteSummary } from '../services/noteMeta'

const props = defineProps<{
  note: NoteSummary
  active: boolean
  favorite: boolean
}>()

const emit = defineEmits<{
  (e: 'open'): void
  (e: 'toggle-favorite'): void
}>()

const isMdx = computed(() => /\.mdx$/i.test(props.note.path))
const shownTags = computed(() => props.note.tags.slice(0, 3))
const timeLabel = computed(() => formatRelativeTime(props.note.mtime))
</script>

<template>
  <article
    class="note-card"
    :class="{ active: props.active }"
    role="button"
    tabindex="0"
    :title="props.note.path"
    @click="emit('open')"
    @keydown.enter.prevent="emit('open')"
    @keydown.space.prevent="emit('open')"
  >
    <div class="card-head">
      <Code2
        v-if="isMdx"
        class="card-icon"
        :size="14"
        :stroke-width="1.8"
      />
      <FileText
        v-else
        class="card-icon"
        :size="14"
        :stroke-width="1.8"
      />
      <h3 class="card-title">
        {{ props.note.title }}
      </h3>
      <button
        class="card-star"
        :class="{ on: props.favorite }"
        :title="props.favorite ? '取消收藏' : '收藏'"
        @click.stop="emit('toggle-favorite')"
      >
        <Star
          :size="14"
          :stroke-width="1.8"
          class="star-icon"
        />
      </button>
    </div>
    <p
      class="card-summary"
      :class="{ placeholder: !props.note.summary }"
    >
      {{ props.note.summary || '暂无摘要' }}
    </p>
    <div class="card-foot">
      <div class="card-tags">
        <span
          v-for="tag in shownTags"
          :key="tag"
          class="card-tag"
        >{{ tag }}</span>
      </div>
      <span class="card-time">{{ timeLabel }}</span>
    </div>
  </article>
</template>

<style scoped>
.note-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--app-radius-lg);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  user-select: none;
  transition: background var(--app-motion-fast) var(--app-ease),
              border-color var(--app-motion-fast) var(--app-ease),
              box-shadow var(--app-motion-fast) var(--app-ease);
}
.note-card:hover {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.note-card:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.note-card.active {
  background: color-mix(in srgb, var(--app-accent-soft) 72%, var(--app-panel));
  border-color: transparent;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-accent) 10%, transparent);
}

.card-head {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
}
.card-icon {
  color: var(--app-accent);
}
.card-title {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--app-text);
}
.card-star {
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
  opacity: 0;
  cursor: pointer;
  transition: opacity var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease),
              background var(--app-motion-fast) var(--app-ease);
}
.note-card:hover .card-star,
.card-star.on {
  opacity: 1;
}
.card-star:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-panel) 72%, transparent);
}
.card-star.on {
  color: var(--app-accent);
}
.card-star.on .star-icon {
  fill: currentColor;
}

.card-summary {
  margin: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  font-size: 11px;
  line-height: 1.65;
  color: var(--app-muted);
}
.card-summary.placeholder {
  opacity: 0.72;
  font-style: italic;
}

.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.card-tags {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}
.card-tag {
  flex: none;
  max-width: 72px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  height: 17px;
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0;
  color: color-mix(in srgb, var(--app-muted) 92%, var(--app-text));
  background: color-mix(in srgb, var(--app-elevated) 62%, var(--app-panel));
  border: 1px solid color-mix(in srgb, var(--app-border) 62%, transparent);
}
.note-card.active .card-tag {
  background: color-mix(in srgb, var(--app-panel) 60%, transparent);
}
.card-time {
  flex: none;
  font-size: 10px;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
  font-variant-numeric: tabular-nums;
}
</style>
