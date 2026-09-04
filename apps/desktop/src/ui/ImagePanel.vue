<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  getImageAttrs,
  deleteImageNode,
  onImageSelectionChange,
  restoreImageSize,
  updateImageAttrs,
} from '@nekowite/editor-core'
import type { NekoEditor, ImageSelectionState } from '@nekowite/editor-core'
import { t } from '../i18n'

const props = defineProps<{ editor: NekoEditor | null }>()

const selected = ref<ImageSelectionState | null>(null)
const alt = ref('')
const title = ref('')
const link = ref('')
const width = ref('')
const align = ref('')
const natural = ref<{ width: number; height: number } | null>(null)

const visible = computed(() => selected.value !== null)

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

const patch = (p: Record<string, unknown>): void => {
  const sel = selected.value
  if (!sel || !props.editor || syncing) return
  updateImageAttrs(props.editor.getView(), sel.pos, p as never)
}

watch(align, (v) => {
  if (!visible.value) return
  patch({ align: v === 'left' || v === 'center' || v === 'right' ? v : null })
})
watch(width, (v) => {
  if (!visible.value) return
  const n = Number(v)
  patch({ width: Number.isFinite(n) && n > 0 ? n : null })
})
watch(alt, (v) => {
  if (!visible.value) return
  patch({ alt: v })
})
watch(title, (v) => {
  if (!visible.value) return
  patch({ title: v })
})
watch(link, (v) => {
  if (!visible.value) return
  const attrs = currentAttrs()
  if (attrs && v !== attrs.src) patch({ src: v })
})

function onRestore(): void {
  const sel = selected.value
  if (!sel || !props.editor) return
  restoreImageSize(props.editor.getView(), sel.pos)
  width.value = ''
  syncFromNode()
}
function onReplace(): void {
  const sel = selected.value
  if (!sel || !props.editor) return
  const src = link.value.trim()
  if (src) updateImageAttrs(props.editor.getView(), sel.pos, { src })
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
    class="neko-image-panel"
    role="dialog"
    :aria-label="t('imagePanel.aria')"
    @pointerdown.stop
    @click.stop
  >
    <div class="neko-image-panel-title">
      {{ t('imagePanel.title') }}
    </div>

    <label class="neko-image-field">
      <span class="neko-image-field-label">{{ t('imagePanel.alt') }}</span>
      <input
        v-model="alt"
        type="text"
        class="neko-image-input"
      >
    </label>

    <label class="neko-image-field">
      <span class="neko-image-field-label">{{ t('imagePanel.title') }}</span>
      <input
        v-model="title"
        type="text"
        class="neko-image-input"
      >
    </label>

    <label class="neko-image-field">
      <span class="neko-image-field-label">{{ t('imagePanel.link') }}</span>
      <input
        v-model="link"
        type="text"
        class="neko-image-input"
      >
    </label>

    <div class="neko-image-row">
      <label class="neko-image-field neko-image-width">
        <span class="neko-image-field-label">{{ t('imagePanel.width') }}</span>
        <input
          v-model="width"
          type="number"
          min="1"
          class="neko-image-input"
        >
      </label>
      <label class="neko-image-field">
        <span class="neko-image-field-label">{{ t('imagePanel.align') }}</span>
        <select
          v-model="align"
          class="neko-image-input"
        >
          <option value="left">{{ t('imagePanel.alignLeft') }}</option>
          <option value="center">{{ t('imagePanel.alignCenter') }}</option>
          <option value="right">{{ t('imagePanel.alignRight') }}</option>
        </select>
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
