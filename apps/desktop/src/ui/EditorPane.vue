<script setup lang="ts">
import { onBeforeUnmount, onMounted, computed, defineAsyncComponent, ref, watch } from 'vue'
import { setImageInsertHandler } from '@nekowite/editor-core'
import { FileText } from 'lucide-vue-next'
import { useViewStore, SPLIT_RATIO_DEFAULT, SPLIT_RATIO_MAX, SPLIT_RATIO_MIN } from '../stores/view'
import { useTabsStore } from '../stores/tabs'
import RenderedPane from '../view/RenderedPane.vue'
import LayoutResizeHandle from './LayoutResizeHandle.vue'
import WordToolbar from '../components/WordToolbar.vue'
import FloatToolbar from '../components/FloatToolbar.vue'
import RenameDialog from '../components/RenameDialog.vue'
import ContextMenu from './ContextMenu.vue'
import {
  editorSessionManager,
  useClipboardFidelity,
  useEditorContextMenu,
  useEditorTailSpace,
  useImageIntake,
  usePaneInput,
  useSourcePaneSlot,
  useSplitScrollSync,
} from '../features/editor'
import { runEditorCommand } from '../services/run-editor-command'
import AgentNoteProposals from '../features/agent/components/AgentNoteProposals.vue'
import AgentChangedFiles from '../features/agent/components/AgentChangedFiles.vue'
import type { AgentInsertionSource } from '../features/agent/services/agent-insertion-source'
import type { AgentIdentity } from '../platform/gateways/agent-contracts'
import { useFloatStore } from '../stores/float'
import { resetFocusedPane } from '../services/editor-ownership'
import { t } from '../i18n'

// ---- What the agent proposes for the note this pane has open (N8/N9) -------------------------
//
// The surface `agent-edit-apply.ts` names as belonging to "whoever holds the editor pane": an
// agent edit's conflict question, and an SVG the run staged for this note, both decided where the
// document they are about is on screen. It is mounted HERE rather than in the rail because the
// rail is where the request is made and this pane is where its subject is — and because the host's
// `ask` is a question about the reader's own paragraph, which is only answerable with the
// paragraph in front of them.
//
// `AgentChangedFiles` is the third surface of the same family and sits above them: what a run
// changed, with Review / Keep / Reject per file, which is `agent-change-review.ts`'s judgement
// drawn. It is here for the reason its answers are: Review opens the note, Keep answers about it,
// and Reject writes it back through its own save transaction — so the list belongs where the notes
// are, not where the request was made.
//
// Both props are the shell's, not this pane's: which session a runtime is serving and which
// composition can mint an insertion binding are the assembly's decisions (`app/agent-rail.ts`),
// and a pane that read them from a store would be answering about a runtime it cannot see. The
// pane is also where they arrive, because it is the unit the shell mounts.
const props = withDefaults(
  defineProps<{
    /** The session the runtime on screen is serving, or null when none is up. */
    agentIdentity?: AgentIdentity | null
    /** Where an SVG insertion is bound, or null. */
    agentInsertions?: AgentInsertionSource | null
  }>(),
  { agentIdentity: null, agentInsertions: null },
)

// The source (CodeMirror) pane is loaded only when the user actually needs it:
// its graph (@codemirror/*, @lezer/*, the host and highlighting services) would
// otherwise be pulled into the first-load bundle even though the Milkdown
// rendered view is what shows on open. Importing it on demand keeps CodeMirror
// off the eager path and lets the pane be torn down (v-if, not v-show) so it is
// not kept resident while the rendered editor is displayed. What that costs —
// and how the slot it leaves behind is warmed and held — is the composable's.
const SourcePane = defineAsyncComponent(() => import('../view/SourcePane.vue'))

const view = useViewStore()
const tabs = useTabsStore()
const floatStore = useFloatStore()

const hasTab = computed(() => tabs.activeTab !== null)

const { sourcePane, awaitingSource } = useSourcePaneSlot()
const renderedPane = ref<InstanceType<typeof RenderedPane> | null>(null)
const panesEl = ref<HTMLElement | null>(null)

// The trailing space below the last line: ONE number, measured here on the box
// the panes are laid out in and handed to both of them. That box is the only
// height they share — measured per pane, each on its own scroller, the source
// pane came out a scrollbar short of the rendered pane and the two spaced the
// same last line differently (see `useEditorTailSpace`).
const { tailSpacePx } = useEditorTailSpace({ getPanelEl: () => panesEl.value })

// Split-view scroll sync, the divider's drag handling and the pane widths: the
// pane they belong to is the layout, and the layout is this component's. What
// they need from the panes is only "where are you and how do I move you".
const {
  sourceStyle,
  renderedStyle,
  onUserScroll,
  onSplitResizeStart,
  onSplitResize,
  onSplitResizeEnd,
  clearResizing,
} = useSplitScrollSync({
  getSourcePane: () => sourcePane.value,
  getRenderedPane: () => renderedPane.value,
  getPanesEl: () => panesEl.value,
})

// Copy and Cut: the rendered pane's node views are `contenteditable="false"`,
// so the engine's own serialisation of a selection loses maths, code blocks,
// tables and wiki-links (measured: `Inline maths  sits here.`, and the empty
// string for a formula on its own — while Cut deleted the paragraph too). The
// handler fixes the payload and is scoped to the rendered pane: the source
// pane's copy is byte-exact and must stay that way.
useClipboardFidelity({
  getPanesEl: () => panesEl.value,
  getEditor: () => editorSessionManager.getActiveEditor(),
})

// Image intake (paste / drop / file picker) is shared by both panes, so it is
// registered on the common ancestor rather than inside the rendered pane: the
// source pane used to have no handler at all, which is why pasting an image in
// source mode fell through to the raw-text paste.
const {
  renamePrompt,
  onRenameConfirm,
  onRenameCancel,
  onPaste,
  onDrop,
  onDragOver,
  insertImagesFromPicker,
} = useImageIntake()

// The editor's own right-click menu, on the same common ancestor and for the
// same reason as the paste plumbing above: one listener covers both panes, the
// split divider and the dead space beside them. It is registered in the capture
// phase so it runs before ProseMirror's and CodeMirror's own handlers, and the
// `preventDefault` it raises is the whole mechanism that keeps the webview's
// native menu off the screen. See the composable for what the menu may offer
// and why it is not everything the native one did.
const {
  target: menuTarget,
  items: menuItems,
  onContextMenu,
  close: closeMenu,
  select: selectMenu,
} = useEditorContextMenu({ runCommand: handleCommand })

// The floating-box toolbar lives on the shared pane container, so it stays on
// screen in source mode even though the element it operates on is hidden. Its
// buttons edit the rendered model, which source mode does not own, so the
// selection is dropped rather than offering controls that cannot work.
watch(
  () => view.mode,
  (mode) => {
    if (mode === 'source') floatStore.select(null)
  },
)

/**
 * Dispatch a toolbar command through the shared, mode-aware runner so the
 * button does the same thing in every view mode (the palette, the plugin
 * buttons and the editor's context menu use the same entry point).
 */
function handleCommand(id: string): void {
  runEditorCommand(id)
}

function onKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    // saveTab flushes the source pane itself, so the save always sees the live
    // document.
    void tabs.saveActive()
  }
}

// Paste / drop / focus plumbing for the pane container both editors live in.
const paneInput = usePaneInput(() => panesEl.value, { onPaste, onDrop, onDragOver })

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('blur', clearResizing)
  // The `image` toolbar / palette command has no way to reach the clipboard or
  // the file picker from editor-core; this is the host side of that hook.
  setImageInsertHandler(() => void insertImagesFromPicker())
})

onBeforeUnmount(() => {
  paneInput.attach(null)
  setImageInsertHandler(null)
  resetFocusedPane()
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('blur', clearResizing)
})
</script>

<template>
  <div class="editor-pane">
    <template v-if="hasTab">
      <!-- What the run changed, and the three answers about it (row 20). Mounted here for the
           same reason the proposals are: the answers are about notes, and this pane is where the
           note is. It is above the proposals because it is about the whole run rather than about
           the one document, and with no rows it draws one line saying so — which is also how a
           reader learns where the answers will appear. -->
      <AgentChangedFiles :identity="props.agentIdentity" />
      <AgentNoteProposals
        :identity="props.agentIdentity"
        :insertions="props.agentInsertions"
      />
      <WordToolbar @command="handleCommand" />
      <div
        ref="panesEl"
        class="panes"
        :class="view.mode"
        @contextmenu.capture="onContextMenu"
      >
        <!-- Holds the source pane's place until its chunk lands. -->
        <div
          v-if="awaitingSource"
          class="pane-pending"
          aria-hidden="true"
        />
        <SourcePane
          v-if="view.mode !== 'rendered'"
          ref="sourcePane"
          class="pane source"
          :style="sourceStyle"
          :tail-space-px="tailSpacePx"
          @user-scroll="onUserScroll('source')"
        />
        <LayoutResizeHandle
          v-if="view.mode === 'split'"
          class="split-handle"
          :label="t('editorPane.resizeSplit')"
          :min="SPLIT_RATIO_MIN"
          :max="SPLIT_RATIO_MAX"
          :value="view.splitRatio"
          :default-value="SPLIT_RATIO_DEFAULT"
          :step="0.02"
          delta-unit="fraction"
          @resize-start="onSplitResizeStart"
          @change="onSplitResize"
          @resize-end="onSplitResizeEnd"
        />
        <RenderedPane
          v-show="view.mode !== 'source'"
          ref="renderedPane"
          class="pane rendered"
          :style="renderedStyle"
          :tail-space-px="tailSpacePx"
          @user-scroll="onUserScroll('rendered')"
        />
        <!-- The toolbar is presentational: this pane owns the float store, so
             it feeds the selection down and routes the three actions back into
             the store (whose actions edit the rendered model). -->
        <FloatToolbar
          :selected-id="floatStore.selectedId"
          @bring-forward="floatStore.bringForward()"
          @send-backward="floatStore.sendBackward()"
          @remove="floatStore.removeSelected()"
        />
      </div>
      <!-- The exit. A context menu is mounted with `v-if` in every host, so its
           own leave rule never ran and it was gone in the frame the user acted;
           `<Transition>` keeps the node mounted for that rule and nothing else
           changes. See `ui/ContextMenu.vue` for the selectors that had to
           out-specify its own `.is-open`. -->
      <Transition name="ctx">
        <ContextMenu
          v-if="menuTarget"
          :x="menuTarget.x"
          :y="menuTarget.y"
          :items="menuItems"
          @select="selectMenu"
          @close="closeMenu"
        />
      </Transition>
      <!-- The shared dialog departure (see motion.css). It has to sit where the
           `v-if` is, so every host of a `.dialog` needs its own wrapper, and
           `type="transition"` is required: the arrival is a *keyframe* and the
           exit a transition, and Vue otherwise waits out the longer of the two
           (460ms) before removing an element whose fade ended at 280ms. -->
      <Transition
        name="dialog"
        type="transition"
      >
        <RenameDialog
          v-if="renamePrompt"
          :initial="renamePrompt.initial"
          @confirm="onRenameConfirm"
          @cancel="onRenameCancel"
        />
      </Transition>
    </template>
    <div
      v-else
      class="editor-empty"
    >
      <div class="empty-icon">
        <FileText
          :size="28"
          :stroke-width="1.5"
        />
      </div>
      <p class="empty-title">
        {{ t('editorPane.emptyTitle') }}
      </p>
      <p class="empty-hint">
        {{ t('editorPane.emptyHint') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.editor-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--app-canvas);
}
.panes {
  position: relative;
  flex: 1;
  display: flex;
  min-height: 0;
}
.pane {
  min-width: 0;
  overflow: auto;
}
.panes.source .pane,
.panes.rendered .pane {
  width: 100%;
}
.panes.split .pane.source {
  border-right: 1px solid var(--app-border);
}
.panes.split .split-handle {
  align-self: stretch;
}

.editor-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--app-muted);
  user-select: none;
}
.empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--app-panel) 70%, var(--app-canvas));
  border: 1px solid var(--app-border);
  color: color-mix(in srgb, var(--app-muted) 70%, transparent);
  margin-bottom: 6px;
}
.empty-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: color-mix(in srgb, var(--app-text) 72%, var(--app-muted));
}
.empty-hint {
  margin: 0;
  font-size: 11px;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
}
</style>

<style scoped src="../features/editor/styles/editorPane.css"></style>
