import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { renderForPrint } from '../../../services/export'
import { exportBaseName } from '../../../services/export-name'
import { exportPageCss, pageBox, type PageBox } from '../../../services/export-page'
import { toExportRefs } from '../../../services/export-refs'
import { describeExportError } from '../../../services/errors'
import { useRefsStore } from '../../../stores/refs'
import { useSettingsStore } from '../../../stores/settings'
import { useTabsStore } from '../../../stores/tabs'

/** Which of the two exports the preview is showing. One surface, two modes: the
 *  document is the same document, and what differs is the frame around it — a
 *  sheet with page boundaries, or the whole thing as one strip. Two components
 *  would have duplicated the frame plumbing, the measurement and the live
 *  settings patching, which is nearly all of a preview. */
export type ExportPreviewMode = 'page' | 'image'

/** The most the preview lays out, in CSS pixels of the sheet.
 *
 * Not a limit on what can be exported — the exporters render the whole
 * document. It is the preview's own bound: a 200-page note is ~100 000px of
 * iframe inside a 400px scroll box, and a settings dialog that takes seconds to
 * open is a worse answer than one that says how much it is showing. The
 * component reports the truncation; it does not hide it. */
export const PREVIEW_MAX_PX = 12000

/** How many pages the page-mode preview will lay out. Four pages is three
 *  more than the question the preview exists to answer ("what lands on page
 *  1"), and it bounds the frame at a value that is always cheap. */
export const PREVIEW_MAX_PAGES = 4

/** What the frame reports about itself once its document has laid out. */
export interface FrameMeasurement {
  /** The document's own box inside the frame — the rectangle the long image
   *  crops to. In page mode the frame IS the content box, so this is it. */
  left: number
  width: number
  height: number
}

export interface ExportPreviewModel {
  mode: Ref<ExportPreviewMode>
  /** The rendered document, ready to be the frame's `srcdoc`. Empty until the
   *  first render finishes, and empty when there is no note. */
  srcdoc: Ref<string>
  /** The paper rule the export would use, live. Written INTO the loaded frame
   *  rather than reloading it: changing the margin has to move the preview
   *  without re-parsing the note. */
  pageCss: ComputedRef<string>
  /** The sheet at scale 1, in CSS pixels. The component scales it to fit. */
  box: ComputedRef<PageBox>
  /** Filled by the component on the frame's `load`. */
  measured: Ref<FrameMeasurement | null>
  /** True when the document is taller than the preview lays out. */
  truncated: ComputedRef<boolean>
  busy: Ref<boolean>
  error: Ref<string | null>
  /** (Re)render the open note into `srcdoc`. */
  render: () => Promise<void>
  /** Write the current rule into an already-loaded frame, in place. Empty in
   *  image mode, where the document is shown with the renderer's own stylesheet
   *  and no paper at all. */
  applyPageCss: (frame: HTMLIFrameElement | null) => void
}

/**
 * The export preview's state and its one command.
 *
 * §10.2 is why this exists: the preview component must not read a store, and
 * rendering a note into a document is a side effect. Everything the surface
 * needs is here, and the component is left with the frame element, the
 * measurement and the scale.
 *
 * The document is rendered **once**, when the section opens. The paper settings
 * only change the CSS at the end of the frame's head; a preview that re-parsed
 * the markdown every time the margin moved is exactly what §"no re-rendering as
 * a side effect" forbids. Nothing that can change the document is reachable
 * while the section is up — the settings dialog is a modal overlay — so there
 * is nothing to re-render for, and the `path` watch covers the one case that
 * does change it.
 */
export function useExportPreview(): ExportPreviewModel {
  const tabs = useTabsStore()
  const refs = useRefsStore()
  const settings = useSettingsStore()

  const mode = ref<ExportPreviewMode>('page')
  const srcdoc = ref('')
  const measured = ref<FrameMeasurement | null>(null)
  const busy = ref(false)
  const error = ref<string | null>(null)

  const box = computed(() =>
    pageBox(settings.exportPdfPageSize, settings.exportPdfOrientation, settings.exportMarginMm),
  )

  const pageCss = computed(() =>
    exportPageCss(settings.exportPdfPageSize, settings.exportPdfOrientation, settings.exportMarginMm),
  )

  const truncated = computed(() => {
    const height = measured.value?.height ?? 0
    return mode.value === 'image'
      ? height > PREVIEW_MAX_PX
      : height > box.value.contentHeight * PREVIEW_MAX_PAGES
  })

  async function render(): Promise<void> {
    const tab = tabs.activeTab
    measured.value = null
    // The gate is the CONTENT, the same one the export buttons use — not the
    // path. An unsaved untitled document has content and can be exported, so a
    // preview that refused it would be the one surface saying there is nothing
    // to show while five buttons beside it offered to export it.
    if (!tab?.content) {
      srcdoc.value = ''
      return
    }
    busy.value = true
    error.value = null
    try {
      srcdoc.value = await renderForPrint(tab.content, {
        title: exportBaseName(tab.path),
        refs: toExportRefs(refs.refs.values()),
        notePath: tab.path,
      })
    } catch (e) {
      srcdoc.value = ''
      error.value = describeExportError(e)
    } finally {
      busy.value = false
    }
  }

  function applyPageCss(frame: HTMLIFrameElement | null): void {
    const style = frame?.contentDocument?.querySelector('style[data-neko-export-page]')
    if (!style) return
    style.textContent = mode.value === 'page' ? pageCss.value : ''
  }

  // The note the preview is of. The tab's IDENTITY and not its `content`: while
  // the section is up the document cannot change, so re-rendering on every
  // content write would buy nothing and cost a markdown parse each time. Not the
  // `path` either — two unsaved documents both have a null path, and switching
  // between them has to re-render.
  watch(() => tabs.activeId, () => { void render() })

  return { mode, srcdoc, pageCss, box, measured, truncated, busy, error, render, applyPageCss }
}
