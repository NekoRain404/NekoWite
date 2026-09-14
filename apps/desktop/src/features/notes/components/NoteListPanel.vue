<script setup lang="ts">
/**
 * The note list column: the notes / outline / links panel, the folders tree and
 * the graph and attachments embeds.
 *
 * Orchestration only (§13.3). The list's state and its projections come from
 * `useNoteList`, the note commands (open, favourite, rename, delete, export)
 * from `useNoteActions`, and every section renders itself; what is left here is
 * composition, prop passing and event forwarding — including the store reads,
 * which the composables do so that this file touches none (§10.2).
 *
 * The note menu lives here because its trigger is the card grid: the menu keeps
 * the path the user right-clicked, and each of its items acts on that note
 * rather than on the open tab.
 */
import AttachmentsPanel from '../../../ui/AttachmentsPanel.vue'
import ContextMenu from '../../../ui/ContextMenu.vue'
import { GraphPanel } from '../../graph'
import { FileTree } from '../../vault'
import LinkList from './LinkList.vue'
import NoteListContent from './NoteListContent.vue'
import NoteListToolbar from './NoteListToolbar.vue'
import OutlineList from './OutlineList.vue'
import { useNoteActions } from '../composables/use-note-actions'
import { useNoteList } from '../composables/use-note-list'
import { t } from '../../../i18n'

const {
  panelMode,
  setMode,
  listView,
  vault,
  activePath,
  hasActiveTab,
  results,
  favorites,
  query,
  setQuery,
  sortOrder,
  setSortOrder,
  contentEnabled,
  toggleContentSearch,
  contentResults,
  contentSearching,
  contentSearched,
  indexing,
  indexState,
  indexStatusLabel,
  showIndexStatus,
  vaultTruncated,
  rebuildIndex,
  outlineItems,
  links,
  toggleFavorite,
} = useNoteList()

const {
  noteMenu,
  noteMenuItems,
  openNoteMenu,
  onNoteMenuSelect,
  closeNoteMenu,
  openNote,
  jumpOutline,
  renameTarget,
  renameName,
  renameError,
  cancelNoteRename,
  onRenameKeydown,
  deleteConfirmPath,
  performNoteDelete,
  cancelNoteDelete,
} = useNoteActions()
</script>

<template>
  <section class="note-list">
    <NoteListToolbar
      :list-view="listView"
      :panel-mode="panelMode"
      :query="query"
      :content-enabled="contentEnabled"
      :indexing="indexing"
      :note-count="results.length"
      :content-count="contentResults.length"
      :index-state="indexState"
      :index-status-label="indexStatusLabel"
      :show-index-status="showIndexStatus"
      :sort-order="sortOrder"
      :vault-truncated="vaultTruncated"
      @set-mode="setMode"
      @search="setQuery"
      @toggle-content="toggleContentSearch"
      @rebuild-index="rebuildIndex"
      @set-sort="setSortOrder"
    />

    <div
      v-if="listView === 'graph'"
      class="nl-embed"
    >
      <GraphPanel />
    </div>

    <div
      v-else-if="listView === 'attachments'"
      class="nl-embed"
    >
      <AttachmentsPanel />
    </div>

    <div
      v-else-if="listView === 'folders'"
      class="nl-embed"
    >
      <FileTree
        v-if="vault"
        :vault="vault"
      />
      <p
        v-else
        class="empty-hint"
      >
        {{ t('notelist.openFolderAfter') }}
      </p>
    </div>

    <div
      v-else-if="listView !== 'notes'"
      class="nl-body nl-empty"
    >
      <p class="empty-hint">
        {{ t('notelist.comingSoon') }}
      </p>
    </div>

    <NoteListContent
      v-else-if="panelMode === 'notes'"
      v-model:rename-name="renameName"
      :content-enabled="contentEnabled"
      :content-searching="contentSearching"
      :content-searched="contentSearched"
      :content-results="contentResults"
      :notes="results"
      :active-path="activePath"
      :favorites="favorites"
      :indexing="indexing"
      :rename-path="renameTarget?.path ?? null"
      :rename-error="renameError"
      :delete-confirm-path="deleteConfirmPath"
      @open="openNote"
      @toggle-favorite="toggleFavorite"
      @contextmenu="openNoteMenu"
      @rename-keydown="onRenameKeydown"
      @rename-cancel="cancelNoteRename"
      @delete-confirm="performNoteDelete"
      @delete-cancel="cancelNoteDelete"
    />

    <div
      v-else-if="panelMode === 'outline'"
      class="nl-body"
    >
      <OutlineList
        :items="outlineItems"
        :note-open="hasActiveTab"
        @jump="jumpOutline"
      />
    </div>

    <div
      v-else-if="panelMode === 'links'"
      class="nl-body"
    >
      <LinkList
        :out="links.out"
        :back="links.back"
        :note-open="hasActiveTab"
        @open="openNote"
      />
    </div>

    <ContextMenu
      v-if="noteMenu"
      :x="noteMenu.x"
      :y="noteMenu.y"
      :items="noteMenuItems"
      @select="onNoteMenuSelect"
      @close="closeNoteMenu"
    />
  </section>
</template>

<style scoped>
.note-list {
  width: var(--app-notelist-width);
  min-width: var(--app-notelist-width);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--app-panel);
  border-right: 1px solid var(--app-border);
  overflow: hidden;
  user-select: none;
}

.nl-embed {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.nl-embed :deep(.graph-panel),
.nl-embed :deep(.attachments-panel) {
  height: 100%;
  padding: 6px 8px;
}
.nl-embed :deep(.file-tree) {
  height: 100%;
  flex: 1;
  min-height: 0;
  width: 100%;
  border-right: none;
  background: transparent;
}

.nl-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 4px 10px 12px;
  align-items: stretch;
}
.nl-empty {
  align-items: center;
  justify-content: center;
}
.empty-hint {
  margin: 0;
  font-size: 12px;
  color: var(--app-muted);
}

@media (max-width: 920px) {
  .note-list {
    display: none;
  }
}
</style>
