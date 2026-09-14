<script setup lang="ts">
/**
 * The export preview: the document, in the frame it would be exported in.
 *
 * It shows the real thing rather than a picture of it. The document is rendered
 * by the same code path the exporters use and displayed in an `<iframe>`, so
 * the preview cannot drift from the output: there is no second renderer to
 * drift from. What the component adds is the frame around it — the sheet, its
 * margin, and the page boundaries — and the scale that fits it into the dialog.
 *
 * The paper settings are written into the loaded frame's head when they change,
 * never by reloading it (§"no re-render as a side effect"): `pageCss` is the
 * only thing a margin, a paper size or an orientation touches, and the frame is
 * patched in place. Resizing re-measures in a `requestAnimationFrame`, and a
 * scroll does nothing at all — neither re-parses anything.
 *
 * It reads no store (§10.2): `useExportPreview` owns the state and the render
 * command, and this file owns the element, the measurement and the scale.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../../../i18n'
import { EXPORT_FRAME_SIZE } from '../../../services/export-image'
import { useExportPreview, PREVIEW_MAX_PAGES, PREVIEW_MAX_PX } from '../composables/use-export-preview'

const preview = useExportPreview()
const { mode, srcdoc, pageCss, box, measured, truncated, busy, error } = preview

const viewportEl = ref<HTMLElement | null>(null)
const frameEl = ref<HTMLIFrameElement | null>(null)
const viewportWidth = ref(0)

/** The sheet at scale 1. Page mode adds the paper margin around the frame;
 *  image mode IS the document's own box, measured out of the frame. */
const sheet = computed(() => {
  if (mode.value === 'image') {
    return { width: measured.value?.width ?? box.value.width, left: measured.value?.left ?? 0, pad: 0 }
  }
  // Exactly the margin, with no floor: a margin of zero has to look like zero,
  // or the preview is answering a question the user did not ask.
  return { width: box.value.width, left: 0, pad: (box.value.width - box.value.contentWidth) / 2 }
})

/** How wide the frame is laid out.
 *
 * Page mode uses the page's own content box, so the frame IS the column the
 * printer will use. Image mode uses the exporter's frame width, unchanged —
 * the document is laid out in the same viewport the export lays it out in, and
 * the sheet is then cropped to the box the image will actually be. */
const frameWidth = computed(() =>
  mode.value === 'image' ? EXPORT_FRAME_SIZE : box.value.contentWidth,
)

const scale = computed(() => {
  const width = sheet.value.width
  if (width <= 0 || viewportWidth.value <= 0) return 1
  return Math.min(1, viewportWidth.value / width)
})

/** How tall the sheet is laid out. Page mode never shows less than one page,
 *  and stops at {@link PREVIEW_MAX_PAGES}; image mode stops at
 *  {@link PREVIEW_MAX_PX}. */
const sheetHeight = computed(() => {
  const content = measured.value?.height ?? 0
  if (mode.value === 'image') return Math.max(1, Math.min(content, PREVIEW_MAX_PX))
  return Math.min(Math.max(content, box.value.contentHeight), box.value.contentHeight * PREVIEW_MAX_PAGES)
})

const frameHeight = computed(() => {
  const content = measured.value?.height ?? 0
  return Math.max(content, sheetHeight.value)
})

/** Where the page boundaries fall, in the sheet's own coordinates. One line per
 *  page break, starting at the end of page one — the whole point of the
 *  surface: the user's question is what lands on page 1. */
const boundaries = computed<number[]>(() => {
  if (mode.value !== 'page') return []
  const page = box.value.contentHeight
  if (page <= 0) return []
  const lines: number[] = []
  for (let y = page; y < sheetHeight.value; y += page) lines.push(Math.round(y))
  return lines
})

const note = computed(() => {
  if (truncated.value) return t('settings.export.previewTruncated')
  return mode.value === 'page' ? t('settings.export.previewPages') : t('settings.export.previewWhole')
})

/**
 * Read the document's own box out of the frame.
 *
 * `getBoundingClientRect` and not `offsetLeft`: the body is `position:relative`,
 * so its `offsetParent` is itself and `offsetLeft` is always 0 — the offset the
 * crop needs is where the body sits in the frame's viewport, which only the
 * client rect reports.
 *
 * This is a measurement, not a render: nothing is parsed or rebuilt, and it
 * runs once per settings change or resize rather than per scroll.
 */
function measureFrame(): void {
  const body = frameEl.value?.contentDocument?.body
  if (!body) return
  const rect = body.getBoundingClientRect()
  measured.value = { left: rect.left, width: rect.width, height: rect.height }
}

function onLoad(): void {
  preview.applyPageCss(frameEl.value)
  measureFrame()
}

// The paper rule reaches the loaded frame in place — the document is not
// re-rendered, and no `load` fires. Coalesced into a frame so dragging a slider
// writes once per paint rather than once per input event.
let cssFrame = 0
watch([pageCss, mode], () => {
  if (cssFrame) return
  cssFrame = requestAnimationFrame(() => {
    cssFrame = 0
    preview.applyPageCss(frameEl.value)
    // The rule just changed, so the document's box changed with it: different
    // paper or a different margin re-wraps the text, and image mode drops the
    // paper entirely. `getBoundingClientRect` below forces the layout this
    // needs, so the new numbers are the ones on screen.
    measureFrame()
  })
})

// The scale follows the dialog's width, and nothing else. rAF-coalesced for
// the same reason: a resize observer fires per frame at most, but the handler
// must not do layout work of its own on the way.
let resizeFrame = 0
let observer: ResizeObserver | null = null
function measureViewport(): void {
  if (resizeFrame) return
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0
    viewportWidth.value = viewportEl.value?.clientWidth ?? 0
  })
}

onMounted(() => {
  measureViewport()
  if (typeof ResizeObserver !== 'undefined' && viewportEl.value) {
    observer = new ResizeObserver(measureViewport)
    observer.observe(viewportEl.value)
  }
  void preview.render()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  if (cssFrame) cancelAnimationFrame(cssFrame)
  if (resizeFrame) cancelAnimationFrame(resizeFrame)
})
</script>

<template>
  <div class="export-preview">
    <div class="export-preview-modes">
      <button
        class="export-preview-mode"
        :class="{ 'is-on': mode === 'page' }"
        type="button"
        @click="mode = 'page'"
      >
        {{ t('settings.export.previewModePage') }}
      </button>
      <button
        class="export-preview-mode"
        :class="{ 'is-on': mode === 'image' }"
        type="button"
        @click="mode = 'image'"
      >
        {{ t('settings.export.previewModeImage') }}
      </button>
    </div>

    <div
      ref="viewportEl"
      class="export-preview-viewport"
    >
      <p
        v-if="error"
        class="export-preview-note is-error"
      >
        {{ error }}
      </p>
      <p
        v-else-if="busy"
        class="export-preview-note"
      >
        {{ t('settings.export.previewRendering') }}
      </p>
      <p
        v-else-if="!srcdoc"
        class="export-preview-note"
      >
        {{ t('settings.export.none') }}
      </p>
      <div
        v-else
        class="export-preview-sizer"
        :style="{ width: `${sheet.width * scale}px`, height: `${sheetHeight * scale}px` }"
      >
        <div
          class="export-preview-sheet"
          :style="{
            width: `${sheet.width}px`,
            height: `${sheetHeight}px`,
            padding: `${sheet.pad}px`,
            transform: `scale(${scale})`,
          }"
        >
          <div
            class="export-preview-crop"
            :style="{ marginLeft: `${-sheet.left}px` }"
          >
            <iframe
              ref="frameEl"
              class="export-preview-frame"
              :title="t('settings.export.preview')"
              :srcdoc="srcdoc"
              :style="{ width: `${frameWidth}px`, height: `${frameHeight}px` }"
              @load="onLoad"
            />
          </div>
          <span
            v-for="y in boundaries"
            :key="y"
            class="export-preview-break"
            :style="{ top: `${y}px` }"
          />
        </div>
      </div>
    </div>
    <span class="export-preview-note">{{ note }}</span>
  </div>
</template>

<style scoped>
.export-preview { display: flex; flex-direction: column; gap: 6px; }
.export-preview-modes { display: flex; gap: 6px; }
.export-preview-mode {
  padding: 3px 9px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  font-size: 11px;
  cursor: pointer;
}
.export-preview-mode.is-on {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-accent) 12%, transparent);
}
.export-preview-viewport {
  max-height: 260px;
  overflow: auto;
  border: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
  border-radius: var(--app-radius-sm);
  background: color-mix(in srgb, var(--app-canvas) 60%, var(--app-panel));
  padding: 8px;
}
.export-preview-sizer { position: relative; margin: 0 auto; }
/* The sheet is laid out at its real size and scaled afterwards, so every
   measurement inside it is the number the printer will use. */
.export-preview-sheet {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: top left;
  overflow: hidden;
  box-sizing: border-box;
  background: #fff;
  box-shadow: 0 1px 4px color-mix(in srgb, var(--app-canvas) 35%, transparent);
}
.export-preview-crop { overflow: hidden; }
.export-preview-frame { display: block; border: 0; background: #fff; }
/* A page boundary, drawn across the content box: the line the user reads as
   "page 1 ends here". */
.export-preview-break {
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  border-top: 1px dashed color-mix(in srgb, var(--app-accent) 70%, transparent);
}
.export-preview-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.export-preview-note.is-error { color: var(--app-danger); }
</style>
