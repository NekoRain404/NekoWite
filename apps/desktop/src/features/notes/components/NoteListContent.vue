<script setup lang="ts">
/**
 * The note list's scrolled area: either the content-search matches or the note
 * cards, with the inline rename editor and the delete question taking the place
 * of the card they belong to.
 *
 * It renders and reports; nothing here decides what an action means. The card
 * list is a snapshot handed down as a prop, so the panel can be rendered from
 * any source of notes, and the rename name is the one exception to the one-way
 * flow: it is a `defineModel`, because the user is typing into it.
 */
import NoteCard from '../../../ui/NoteCard.vue'
import type { NoteCardContextTarget } from '../../../ui/NoteCard.vue'
import { t } from '../../../i18n'
import type { NoteSummary } from '../../../services/note-meta'
import type { ContentMatch } from '../../../services/content-search'

const props = defineProps<{
  contentEnabled: boolean
  contentSearching: boolean
  contentSearched: boolean
  contentResults: ContentMatch[]
  notes: NoteSummary[]
  activePath: string | null
  favorites: ReadonlySet<string>
  indexing: boolean
  /** The path whose card is replaced by the inline rename editor. */
  renamePath: string | null
  renameError: string
  /** The path whose card is replaced by the delete question. */
  deleteConfirmPath: string | null
}>()

const renameName = defineModel<string>('renameName', { required: true })

const emit = defineEmits<{
  (e: 'open', path: string): void
  (e: 'toggle-favorite', path: string): void
  (e: 'contextmenu', target: NoteCardContextTarget): void
  (e: 'rename-keydown', event: KeyboardEvent): void
  (e: 'rename-cancel'): void
  (e: 'delete-confirm', path: string): void
  (e: 'delete-cancel'): void
}>()

/** Focus and pre-select the name as soon as the input renders, so a rename is
 *  type-then-Enter (the tree's inline rename behaves the same way). */
function setRenameInput(el: unknown): void {
  const input = el instanceof HTMLInputElement ? el : null
  if (!input) return
  input.focus()
  input.select()
}
</script>

<template>
  <div
    class="nl-cards"
    role="list"
    :aria-label="t('notelist.aria')"
  >
    <template v-if="props.contentEnabled">
      <p
        v-if="props.contentSearching"
        class="nl-empty-hint"
      >
        {{ t('notelist.searching') }}
      </p>
      <template v-else-if="props.contentResults.length > 0">
        <p class="nl-group-label">
          {{ t('notelist.contentResults') }}
        </p>
        <button
          v-for="r in props.contentResults"
          :key="r.path"
          class="content-result"
          :title="r.path"
          @click="emit('open', r.path)"
        >
          <span class="content-result-name">{{ r.name }}</span>
          <span class="content-result-snippet">{{ r.snippet }}</span>
        </button>
      </template>
      <p
        v-else-if="props.contentSearched"
        class="nl-empty-hint"
      >
        {{ t('notelist.noContentMatch') }}
      </p>
      <p
        v-else
        class="nl-empty-hint"
      >
        {{ t('notelist.contentSearchHint') }}
      </p>
    </template>
    <template v-else>
      <template
        v-for="note in props.notes"
        :key="note.path"
      >
        <!-- The rename editor takes the card's place: the note being
             renamed is the card the user right-clicked, so the input sits
             where they were looking instead of at the top of the list. -->
        <div
          v-if="props.renamePath === note.path"
          class="nl-rename-row"
        >
          <input
            :ref="setRenameInput"
            v-model="renameName"
            class="nl-rename-input"
            :class="{ invalid: !!props.renameError }"
            type="text"
            :aria-label="t('filetree.rename')"
            @click.stop
            @keydown.stop="emit('rename-keydown', $event)"
            @blur="emit('rename-cancel')"
          >
          <span
            v-if="props.renameError"
            class="nl-rename-error"
          >{{ props.renameError }}</span>
        </div>
        <!-- Same place for the delete question, and the name is shown so
             the note under it is never in doubt. -->
        <div
          v-else-if="props.deleteConfirmPath === note.path"
          class="nl-del-confirm"
        >
          <span
            class="nl-del-name"
            :title="note.path"
          >{{ note.name }}</span>
          <button
            type="button"
            class="btn btn-secondary btn-sm nl-del-yes"
            @click.stop="emit('delete-confirm', note.path)"
          >
            {{ t('filetree.confirm') }}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm nl-del-no"
            @click.stop="emit('delete-cancel')"
          >
            {{ t('filetree.cancel') }}
          </button>
        </div>
        <NoteCard
          v-else
          :note="note"
          :active="note.path === props.activePath"
          :favorite="props.favorites.has(note.path)"
          @open="emit('open', note.path)"
          @toggle-favorite="emit('toggle-favorite', note.path)"
          @contextmenu="emit('contextmenu', $event)"
        />
      </template>
      <p
        v-if="!props.indexing && props.notes.length === 0"
        class="nl-empty-hint"
      >
        {{ t('notelist.empty') }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.nl-cards {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 8px 12px;
}

/* Inline rename: the card's own place in the list, so the note being edited
   stays where the user right-clicked it. */
.nl-rename-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 4px 6px;
}
.nl-rename-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  font-family: var(--app-font);
  font-size: 12px;
  letter-spacing: -0.01em;
  color: var(--app-text);
  background: var(--app-canvas);
  border: 1px solid var(--app-accent);
  border-radius: var(--app-radius-sm);
  outline: none;
}
.nl-rename-input.invalid { border-color: var(--app-danger); }
.nl-rename-error {
  flex: none;
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--app-danger);
}

/* Delete question: the card's place, framed in the danger colour so it is not
   mistaken for the card itself. */
.nl-del-confirm {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 3px 8px;
  border: 1px solid color-mix(in srgb, var(--app-danger) 42%, transparent);
  border-radius: var(--app-radius-sm);
  background: color-mix(in srgb, var(--app-danger) 10%, transparent);
}
.nl-del-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 550;
  letter-spacing: -0.01em;
  color: var(--app-text);
}
.nl-del-confirm .btn { flex: none; }

/* `.nl-empty-hint` and `.nl-group-label` are restated in OutlineList and
   LinkList: a scoped block belongs to the component that renders the element,
   and the classes are too small to belong in the shared stylesheet. */
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

.content-result {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 7px 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.content-result:hover {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.content-result:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.content-result-name {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--app-text);
}
.content-result-snippet {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--app-muted);
}
</style>
