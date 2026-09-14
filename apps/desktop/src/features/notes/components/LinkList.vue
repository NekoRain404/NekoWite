<script setup lang="ts">
/**
 * The open note's links: what it points at, and which notes point back at it.
 *
 * Both lists are resolved elsewhere (`useNoteList` asks the vault index's
 * queries), so a row here is a rendered path and a label. An outlink whose
 * target is not in the index keeps its row — disabled, so the user sees that the
 * link is there and broken rather than missing it.
 */
import { t } from '../../../i18n'
import type { NoteSummary } from '../../../services/note-meta'
import type { NoteOutlink } from '../composables/use-note-list'

const props = defineProps<{
  out: NoteOutlink[]
  back: NoteSummary[]
  /** Whether a note is open at all — without one there are no links to show. */
  noteOpen: boolean
}>()

const emit = defineEmits<{
  (e: 'open', path: string | null): void
}>()
</script>

<template>
  <template v-if="props.noteOpen">
    <p class="nl-group-label">
      {{ t('notelist.outLinks') }}
    </p>
    <button
      v-for="link in props.out"
      :key="`out-${link.target}-${link.text}`"
      class="link-item"
      :class="{ missing: !link.path }"
      :disabled="!link.path"
      @click="emit('open', link.path)"
    >
      <span class="link-text">{{ link.text || link.target }}</span>
      <span class="link-target">{{ link.target }}</span>
    </button>
    <p
      v-if="props.out.length === 0"
      class="nl-empty-hint"
    >
      {{ t('notelist.outLinksEmpty') }}
    </p>
    <p class="nl-group-label">
      {{ t('notelist.inLinks') }}
    </p>
    <button
      v-for="note in props.back"
      :key="`back-${note.path}`"
      class="link-item"
      @click="emit('open', note.path)"
    >
      <span class="link-text">{{ note.title }}</span>
      <span class="link-target">{{ note.dir || t('notelist.rootDir') }}</span>
    </button>
    <p
      v-if="props.back.length === 0"
      class="nl-empty-hint"
    >
      {{ t('notelist.inLinksEmpty') }}
    </p>
  </template>
  <p
    v-else
    class="nl-empty-hint"
  >
    {{ t('notelist.openNoteLinks') }}
  </p>
</template>

<style scoped>
/* `.nl-empty-hint` is restated in NoteListContent and OutlineList: a scoped
   block belongs to the component that renders the element, and the rule is too
   small to belong in the shared stylesheet. */
.nl-empty-hint {
  margin: 0;
  padding: 10px 6px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--app-muted);
  text-align: center;
}

.nl-group-label {
  margin: 8px 2px 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}
.nl-group-label:first-child {
  margin-top: 2px;
}
.link-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.link-item:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-accent-soft) 70%, var(--app-elevated));
}
.link-item:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.link-item.missing {
  cursor: default;
  opacity: 0.6;
}
.link-text {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  font-weight: 550;
  letter-spacing: -0.01em;
  color: var(--app-text);
}
.link-target {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 10px;
  color: var(--app-muted);
}
</style>
