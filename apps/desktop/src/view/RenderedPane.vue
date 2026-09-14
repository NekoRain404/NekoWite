<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'
import { useFloatStore } from '../stores/float'
import { useAppearanceStore } from '../stores/appearance'
import { useDocumentListStore } from '../stores/document-list'
import { resolveDirection } from '../services/rtl'
import { t } from '../i18n'
import { resolveLinkPath } from '../features/vault'
import { dirRelativeToVault } from '../features/notes'
import RenderSearchPanel from './RenderSearchPanel.vue'
import ImagePanel from '../ui/ImagePanel.vue'
import TableMenu from '../ui/TableMenu.vue'
import { useEditorTailSpace, useRenderedEditorStack } from '../features/editor'

const tabs = useTabsStore()
const view = useViewStore()
const floatStore = useFloatStore()
const documentList = useDocumentListStore()
const appearance = useAppearanceStore()

const scrollEl = ref<HTMLElement | null>(null)
const editorEl = ref<HTMLElement | null>(null)

// Trailing space: the last line can be scrolled up to a comfortable place. The
// pad lives on the content container (never in the document) and is subtracted
// from the range the split sync reads.
const { tailSpacePx } = useEditorTailSpace({
  getScrollEl: () => scrollEl.value,
  apply: (px) => editorEl.value?.style.setProperty('--nkw-tail-space', `${px}px`),
})

// Reported to the pane's parent (the editor pane), which owns the split-view
// scroll coordinator. Only the user's own scrolls are reported: the echo of a
// programmatic write is consumed inside the scroll controller.
const emit = defineEmits<{ 'user-scroll': [] }>()

// Base direction for the rendered content: the user's explicit override wins,
// otherwise the document text decides (Arabic/Hebrew -> rtl). Bound as `dir` on
// the pane root so the browser lays the note out from the correct edge.
const renderDir = computed(() => resolveDirection(appearance.contentDirection, tabs.activeTab?.content ?? ''))

// The pane is a thin orchestrator: it owns the template-bound DOM refs, its own
// reactive UI state and its delegated events. The editor itself — session,
// controller stack, mount/teardown contract and the store subscriptions that
// re-configure them — is the composable's, so it can be reasoned about without
// mounting a component. The two handlers below are handed back to it because
// they go on with the rest of the mount (see the composable).
const {
  editorForPanel,
  documentVersion,
  searchOpen,
  spellPopup,
  searchOverlay,
  externalSync,
  scrollSync,
  focus,
  wordCount,
  wordGoalMet,
  wordProgressPct,
} = useRenderedEditorStack({
  getScrollEl: () => scrollEl.value,
  getEditorEl: () => editorEl.value,
  handlers: { onEditorClick, onKeydown },
  getTailSpace: () => tailSpacePx.value,
})

function onScroll(): void {
  if (scrollSync.onScroll()) emit('user-scroll')
}

function onEditorClick(e: MouseEvent): void {
  const target = e.target as Element | null
  const anchor = target?.closest?.('a') as HTMLAnchorElement | null
  const href = anchor?.getAttribute('href') ?? ''
  if (anchor && href) {
    // Every in-document link is handled here, and the default is always
    // prevented: letting the webview follow a relative href would try to
    // navigate the app window itself.
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault()
      e.stopPropagation()
      window.open(href, '_blank', 'noopener,noreferrer')
      return
    }
    if (href.startsWith('#')) {
      e.preventDefault()
      e.stopPropagation()
      scrollSync.scrollToHeading(href.slice(1))
      return
    }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      // A same-vault reference (notes/other.md, ../a.md): open it as a tab.
      e.preventDefault()
      e.stopPropagation()
      void openLinkedNote(href)
      return
    }
    // Any other scheme (mailto:, asset:, a hand-written javascript:) is not
    // this pane's business — but it must not navigate the app either.
    e.preventDefault()
    e.stopPropagation()
    return
  }
  const span = target?.closest?.('.nkw-spell') as HTMLElement | null
  if (span) {
    e.preventDefault()
    e.stopPropagation()
    searchOverlay.openSpellPopup(span, e.clientX, e.clientY)
    return
  }
  if (spellPopup.value) {
    const hit = target?.closest?.('.nw-spell-popup')
    if (!hit) spellPopup.value = null
  }
}

/** Open a same-vault markdown reference in a new tab. */
async function openLinkedNote(href: string): Promise<void> {
  const vault = tabs.vault
  const notePath = tabs.activeTab?.path
  if (!vault || !notePath) return
  let decoded = href
  try {
    decoded = decodeURIComponent(href)
  } catch {
    // A malformed escape sequence: fall back to the raw href.
  }
  const resolved = resolveLinkPath(
    documentList.notes,
    vault,
    dirRelativeToVault(notePath, vault),
    decoded,
  )
  if (resolved) await tabs.openTab(resolved)
}

/**
 * A click in the trailing space — the content container's own padding, below
 * the last block — puts the caret at the document's end.
 *
 * The padding is outside `.ProseMirror`, so a click there reaches no editor
 * handler at all and the space would be dead: a patch of the panel that looks
 * like the note and swallows the click. `.self` is what keeps this off the
 * text: a click on a block has that block as its target, not the container.
 */
function onTailClick(): void {
  scrollSync.setCaretAtEnd()
  focus()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && floatStore.selectedId) {
    floatStore.select(null)
  }
  if (e.key === 'Escape' && (searchOpen.value || spellPopup.value)) {
    searchOpen.value = false
    spellPopup.value = null
    return
  }
  // Ctrl/Cmd+F opens the rendered-pane find panel. In source mode and when
  // focus is inside the CodeMirror host (split mode), leave the shortcut to
  // the source view's own search panel.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    if (view.mode === 'source') return
    const target = e.target as Element | null
    if (target && target.closest('.cm-editor')) return
    e.preventDefault()
    searchOpen.value = true
  }
}

// The scroll surface and the caret the pane's parent (the split-view
// coordinator, the handoff) drives through the template ref — see
// `RenderedPaneHandoff`. The caret is part of it because a mode switch carries
// both: the pane keeps its model across a switch, so a caret the source pane
// moved is a caret the rendered pane has to be told about.
defineExpose({
  getDocumentVersion: () => documentVersion.value,
  getScrollTop: scrollSync.getScrollTop,
  setCaretAtEnd: scrollSync.setCaretAtEnd,
  getScrollRange: scrollSync.getScrollRange,
  setScrollTop: scrollSync.setScrollTop,
  getHeadingTops: scrollSync.getHeadingTops,
  setScrollToLine: scrollSync.setScrollToLine,
  getCaretLine: scrollSync.getCaretLine,
  setCaretLine: scrollSync.setCaretLine,
  focus,
})
</script>

<template>
  <div
    ref="scrollEl"
    class="rendered-pane"
    :dir="renderDir"
    @scroll="onScroll"
    @focusin="externalSync.flushPendingSync()"
  >
    <div
      v-if="appearance.wordGoal > 0"
      class="nw-word-goal"
      :class="{ 'is-done': wordGoalMet }"
    >
      <span class="nw-word-goal-label">
        {{ t('settings.editor.wordGoalProgress', { current: wordCount, goal: appearance.wordGoal }) }}
      </span>
      <span class="nw-word-goal-track">
        <span
          class="nw-word-goal-fill"
          :style="{ width: `${wordProgressPct}%` }"
        />
      </span>
    </div>
    <RenderSearchPanel
      v-if="searchOpen"
      class="nw-render-search-host"
      @close="searchOverlay.closeSearch"
    />
    <div
      ref="editorEl"
      class="editor-container"
      @click.self="onTailClick"
    >
      <ImagePanel
        v-if="editorForPanel"
        :editor="editorForPanel"
      />
      <TableMenu
        v-if="editorForPanel"
        :editor="editorForPanel"
      />
    </div>
    <div
      v-if="spellPopup"
      class="nw-spell-popup"
      :style="{ left: `${spellPopup.x}px`, top: `${spellPopup.y}px` }"
      @click.stop
    >
      <div class="nw-spell-popup-title">
        {{ spellPopup.word }}
      </div>
      <div class="nw-spell-popup-label">
        {{ t('spell.suggestions') }}
      </div>
      <template v-if="spellPopup.suggestions.length">
        <button
          v-for="s in spellPopup.suggestions"
          :key="s"
          class="nw-spell-popup-item"
          type="button"
          @click="searchOverlay.handleSpellSuggestion(s)"
        >
          {{ s }}
        </button>
      </template>
      <div
        v-else
        class="nw-spell-popup-none"
      >
        {{ t('spell.noSuggestions') }}
      </div>
    </div>
  </div>
</template>

<style scoped src="../features/editor/styles/renderedPane.css"></style>
