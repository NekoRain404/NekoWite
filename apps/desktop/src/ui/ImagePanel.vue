<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NodeSelection } from '@milkdown/prose/state'
import {
  getImageAttrs,
  deleteImageNode,
  onImageSelectionChange,
  restoreImageSize,
  updateImageAttrs,
  clearImageSelection,
} from '@nekowite/editor-core'
import type { NekoEditor, ImageSelectionState } from '@nekowite/editor-core'
import { useFocusTrap } from '../composables/use-focus-trap'
import { t } from '../i18n'
import { isComposingKey } from '../services/key-guard'
import SelectMenu from '../components/SelectMenu.vue'

const props = defineProps<{ editor: NekoEditor | null }>()

const selected = ref<ImageSelectionState | null>(null)
const alt = ref('')
const title = ref('')
const link = ref('')
const width = ref('')
// `'left'`, not `''`: the control below is a SelectMenu, which shows the option
// matching its value and nothing when none does. An empty value is only ever
// reachable before the first sync, and a blank control in that window reads as
// a bug rather than as "unset".
const align = ref('left')
/** The three alignments the editor's schema understands (see the `patch` call
 *  in the `align` watcher, which is what rejects anything else). */
const alignOptions = computed(() => [
  { value: 'left', label: t('imagePanel.alignLeft') },
  { value: 'center', label: t('imagePanel.alignCenter') },
  { value: 'right', label: t('imagePanel.alignRight') },
])
const natural = ref<{ width: number; height: number } | null>(null)

const visible = computed(() => selected.value !== null)

// Non-modal property panel focus management (reuses the app's focus-trap
// pattern, same as the ConflictDialog): on open, focus moves to the first
// focusable field (the Alt input); Tab / Shift+Tab cycle inside; on close
// (Escape or a deselection), focus returns to whatever had it before — typically
// the editor. It stays non-modal (`aria-modal="false"`) but is focus-contained
// only while it is open so a keyboard user can edit an image without a mouse.
const panelEl = ref<HTMLElement | null>(null)
useFocusTrap(panelEl, visible)

function onKeydown(e: KeyboardEvent): void {
  // Escape dismisses the IME candidate list first; the panel has inputs.
  if (isComposingKey(e)) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    clearImageSelection()
  }
}

let unlisten: (() => void) | null = null
let naturalRev = 0
// True while populating the form from the node; watchers skip during sync so
// selecting an image never emits a spurious (no-change) transaction/undo step.
let syncing = false

function currentAttrs(): ReturnType<typeof getImageAttrs> {
  const sel = selected.value
  if (!sel || !props.editor) return null
  return getImageAttrs(props.editor.getView(), sel.pos)
}

function syncFromNode(): void {
  const sel = selected.value
  if (!sel || !props.editor) return
  const attrs = getImageAttrs(props.editor.getView(), sel.pos)
  if (!attrs) return
  syncing = true
  alt.value = attrs.alt ?? ''
  title.value = attrs.title ?? ''
  link.value = attrs.src ?? ''
  width.value = attrs.width != null ? String(attrs.width) : ''
  align.value = attrs.align ?? 'left'
  syncing = false
  // Load the intrinsic size so the panel can show "original" dimensions.
  const rev = ++naturalRev
  natural.value = null
  const probe = new Image()
  probe.onload = () => {
    if (rev !== naturalRev) return
    natural.value = { width: probe.naturalWidth, height: probe.naturalHeight }
  }
  probe.onerror = () => {
    if (rev !== naturalRev) return
    natural.value = null
  }
  if (attrs.src) probe.src = attrs.src
}

/**
 * `updateImageAttrs` writes the new attrs with a `setNodeMarkup` transaction.
 * On a leaf node that is a ReplaceStep at the selection anchor, and
 * ProseMirror's mapping treats the anchor boundary of such a replace as
 * "deleted" — so the NodeSelection is remapped to a text caret, the image
 * selection plugin emits null, and the panel would close itself after every
 * single field edit (typing one character in Alt would dismiss the panel;
 * a multi-field edit was impossible). Restoring the NodeSelection with a
 * selection-only transaction (no doc change, no undo step) keeps the panel
 * open across a series of edits. The same repair belongs in editor-core's
 * attribute writers — this panel-level repair is the contract the UI needs.
 */
function reselectImage(view: ReturnType<NekoEditor['getView']>, pos: number): void {
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'image') return
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
}

const patch = (p: Record<string, unknown>): void => {
  const sel = selected.value
  if (!sel || !props.editor || syncing) return
  const view = props.editor.getView()
  updateImageAttrs(view, sel.pos, p as never)
  reselectImage(view, sel.pos)
}

// `flush: 'sync'` is essential: without it Vue fires these watchers
// asynchronously, AFTER `syncFromNode()` has already reset the `syncing` guard,
// so the initial field population would re-patch the node with identical values
// and dispatch a spurious no-change transaction — resetting the NodeSelection
// and closing the panel the moment it opens. Synchronous flush runs the watcher
// while `syncing` is still true, so the guard is honored.
watch(align, (v) => {
  if (!visible.value) return
  patch({ align: v === 'left' || v === 'center' || v === 'right' ? v : null })
}, { flush: 'sync' })
watch(width, (v) => {
  if (!visible.value) return
  const n = Number(v)
  patch({ width: Number.isFinite(n) && n > 0 ? n : null })
}, { flush: 'sync' })
watch(alt, (v) => {
  if (!visible.value) return
  patch({ alt: v })
}, { flush: 'sync' })
watch(title, (v) => {
  if (!visible.value) return
  patch({ title: v })
}, { flush: 'sync' })
watch(link, (v) => {
  if (!visible.value) return
  const attrs = currentAttrs()
  if (attrs && v !== attrs.src) patch({ src: v })
}, { flush: 'sync' })

function onRestore(): void {
  const sel = selected.value
  if (!sel || !props.editor) return
  const view = props.editor.getView()
  restoreImageSize(view, sel.pos)
  reselectImage(view, sel.pos)
  width.value = ''
  syncFromNode()
}
function onReplace(): void {
  const sel = selected.value
  if (!sel || !props.editor) return
  const view = props.editor.getView()
  const src = link.value.trim()
  if (src) {
    updateImageAttrs(view, sel.pos, { src })
    reselectImage(view, sel.pos)
  }
}
function onDelete(): void {
  const sel = selected.value
  if (!sel || !props.editor) return
  deleteImageNode(props.editor.getView(), sel.pos)
  selected.value = null
}

const onSelection = (info: ImageSelectionState | null): void => {
  if (info && props.editor) {
    selected.value = info
    syncFromNode()
  } else {
    selected.value = null
    natural.value = null
  }
}

// Subscribe once on mount; the module-level listener set dedups.
unlisten = onImageSelectionChange(onSelection)

watch(
  () => props.editor,
  () => {
    if (selected.value) syncFromNode()
  },
)

onBeforeUnmount(() => {
  naturalRev += 1
  unlisten?.()
  unlisten = null
})
</script>

<template>
  <div
    v-if="visible"
    ref="panelEl"
    class="neko-image-panel"
    role="dialog"
    aria-modal="false"
    :aria-label="t('imagePanel.aria')"
    @pointerdown.stop
    @click.stop
    @keydown="onKeydown"
  >
    <div class="neko-image-panel-title">
      {{ t('imagePanel.title') }}
    </div>

    <label
      class="neko-image-field"
      for="neko-image-alt"
    >
      <span class="neko-image-field-label">{{ t('imagePanel.alt') }}</span>
      <input
        id="neko-image-alt"
        v-model="alt"
        type="text"
        class="neko-image-input"
      >
    </label>

    <label
      class="neko-image-field"
      for="neko-image-title"
    >
      <span class="neko-image-field-label">{{ t('imagePanel.titleField') }}</span>
      <input
        id="neko-image-title"
        v-model="title"
        type="text"
        class="neko-image-input"
      >
    </label>

    <label
      class="neko-image-field"
      for="neko-image-link"
    >
      <span class="neko-image-field-label">{{ t('imagePanel.link') }}</span>
      <input
        id="neko-image-link"
        v-model="link"
        type="text"
        class="neko-image-input"
      >
    </label>

    <div class="neko-image-row">
      <label
        class="neko-image-field neko-image-width"
        for="neko-image-width"
      >
        <span class="neko-image-field-label">{{ t('imagePanel.width') }}</span>
        <input
          id="neko-image-width"
          v-model="width"
          type="number"
          min="1"
          class="neko-image-input"
        >
      </label>
      <label
        class="neko-image-field"
        for="neko-image-align"
      >
        <span class="neko-image-field-label">{{ t('imagePanel.align') }}</span>
        <SelectMenu
          id="neko-image-align"
          v-model="align"
          class="neko-image-input"
          :options="alignOptions"
        />
      </label>
    </div>

    <div class="neko-image-size">
      <div class="neko-image-size-line">
        <span class="neko-image-field-label">{{ t('imagePanel.currentSize') }}</span>
        <span class="neko-image-size-value">
          {{ width || 'auto' }}{{ width && natural ? '×' + natural.height : '' }}
        </span>
      </div>
      <div class="neko-image-size-line">
        <span class="neko-image-field-label">{{ t('imagePanel.originalSize') }}</span>
        <span class="neko-image-size-value">
          {{ natural ? `${natural.width}×${natural.height}` : '—' }}
        </span>
      </div>
    </div>

    <div class="neko-image-actions">
      <button
        type="button"
        class="neko-image-btn"
        @click="onRestore"
      >
        {{ t('imagePanel.restoreSize') }}
      </button>
      <button
        type="button"
        class="neko-image-btn"
        @click="onReplace"
      >
        {{ t('imagePanel.replace') }}
      </button>
      <button
        type="button"
        class="neko-image-btn neko-image-btn-danger"
        @click="onDelete"
      >
        {{ t('imagePanel.delete') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.neko-image-panel {
  position: absolute;
  top: 0;
  right: 8px;
  z-index: 40;
  width: 240px;
  padding: 10px 12px;
  background: var(--app-elevated);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-md);
  box-shadow: 0 8px 28px color-mix(in srgb, var(--app-text) 16%, transparent);
  font-family: var(--app-font);
  font-size: 12px;
}
.neko-image-panel-title {
  margin-bottom: 8px;
  font-weight: 650;
  color: var(--app-text);
}
.neko-image-field {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.neko-image-field-label {
  flex: none;
  width: 64px;
  color: var(--app-muted);
  font-size: 11px;
}
.neko-image-input {
  flex: 1;
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
  border-radius: var(--app-radius-sm);
  background: var(--app-canvas);
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
}
.neko-image-row {
  display: flex;
  gap: 8px;
}
.neko-image-width {
  flex: 1;
}
.neko-image-row .neko-image-field-label {
  width: 44px;
}
.neko-image-size {
  margin: 8px 0;
  padding: 6px 0;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
}
.neko-image-size-line {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
}
.neko-image-size-value {
  color: var(--app-text);
  font-variant-numeric: tabular-nums;
}
.neko-image-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.neko-image-btn {
  flex: 1;
  padding: 5px 4px;
  border: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
  border-radius: var(--app-radius-sm);
  background: var(--app-panel);
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 11px;
  cursor: pointer;
  /* The shared hover rung, which every other control in the app already runs
     on: this row — the plain buttons and the danger one that carries this class
     beside its own — was one the unification pass never reached, so a hover
     snapped here while it eased everywhere else. */
  transition: border-color var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.neko-image-btn:hover {
  border-color: var(--app-accent);
  color: var(--app-accent);
}
.neko-image-btn-danger:hover {
  border-color: var(--app-danger);
  color: var(--app-danger);
}
</style>
