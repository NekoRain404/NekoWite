import { computed, type ComputedRef, type WritableComputedRef } from 'vue'
import { t } from '../../../i18n'
import { exportHtml, exportToPdf } from '../../../services/export'
import { exportBaseName } from '../../../services/export-name'
import { toExportRefs } from '../../../services/export-refs'
import { fsService } from '../../../platform/gateways/fs'
import { flushEdits } from '../../../services/editor-ownership'
import { describeExportError, notifyError } from '../../../services/errors'
import { isPathWithinVault } from '../../attachments'
import { useRefsStore } from '../../../stores/refs'
import { useSettingsStore } from '../../../stores/settings'
import type { ExportPdfOrientation, ExportPdfPageSize } from '../../../stores/settings'
import { useTabsStore } from '../../../stores/tabs'

export interface ExportSettingsModel {
  /** Whether a note is open for the two export buttons to act on. */
  hasActiveTab: ComputedRef<boolean>
  /** Writable, so the section binds them with `v-model` and the write still
   *  lands in the store rather than in a copy (§10.3-C). */
  frontmatter: WritableComputedRef<boolean>
  pageSize: WritableComputedRef<ExportPdfPageSize>
  orientation: WritableComputedRef<ExportPdfOrientation>
  exportHtmlFile: () => Promise<void>
  exportPdfFile: () => Promise<void>
}

/**
 * The export section's state and its two commands.
 *
 * §10.3-C sends the export *commands* here and leaves the section to emit only
 * `export-html` / `export-pdf`, so this is deliberately the one settings domain
 * a section does not call for itself: the panel owns the commands and forwards
 * the section's events into them.
 *
 * The implementation still belongs to `features/export/services` in the target
 * tree (§10.3-C); until that feature exists, the two commands are orchestration
 * over the existing export services and are the seam that moves.
 */
export function useExportSettings(): ExportSettingsModel {
  const tabs = useTabsStore()
  const refs = useRefsStore()
  const settings = useSettingsStore()

  const hasActiveTab = computed(() => !!tabs.activeTab?.content)

  async function exportHtmlFile(): Promise<void> {
    const tab = tabs.activeTab
    if (!tab) return
    // The native dialog lets the user aim anywhere (Desktop, Home, …), but the
    // Rust `write_file` command is vault-confined — an absolute path outside the
    // vault is rejected with "path escapes vault" and the export silently fails.
    // (Preferred fix, needing a backend change: a dedicated non-confined
    // `export_file` command that writes an absolute path outside the vault.)
    // Until that lands, do not lead the user to a doomed path: short-circuit a
    // vault-external destination up front and tell them to pick a vault path.
    const vault = tabs.vault
    const savePath = await fsService.saveFileDialog(exportBaseName(tab.path) + '.html', vault ?? undefined)
    if (!savePath) return
    if (vault && !isPathWithinVault(savePath, vault)) {
      notifyError(t('error.exportOutsideVault'))
      return
    }
    try {
      // The tab lags the source pane by its debounce window; export the live text.
      await flushEdits()
      await exportHtml(tab.content, vault ?? '', savePath, {
        title: exportBaseName(tab.path),
        refs: toExportRefs(refs.refs.values()),
      })
    } catch (e) {
      // Belt-and-braces: if the backend still rejects (e.g. a symlink resolved
      // outside, or no vault open) describeExportError maps it to a clear hint.
      notifyError(describeExportError(e))
    }
  }

  async function exportPdfFile(): Promise<void> {
    const tab = tabs.activeTab
    if (!tab) return
    try {
      // Persist the live text into the tab before handing it to the exporter.
      await flushEdits()
      // Awaited, and reported on failure: this used to be a bare call whose
      // rejection went nowhere, so a render error or a missing vault looked
      // exactly like the button doing nothing at all.
      await exportToPdf(tab.content, {
        title: exportBaseName(tab.path),
        refs: toExportRefs(refs.refs.values()),
      })
    } catch (e) {
      notifyError(describeExportError(e))
    }
  }

  return {
    hasActiveTab,
    frontmatter: computed({
      get: () => settings.exportIncludeFrontmatter,
      set: (on) => { settings.exportIncludeFrontmatter = on },
    }),
    pageSize: computed({
      get: () => settings.exportPdfPageSize,
      set: (v) => { settings.exportPdfPageSize = v },
    }),
    orientation: computed({
      get: () => settings.exportPdfOrientation,
      set: (v) => { settings.exportPdfOrientation = v },
    }),
    exportHtmlFile,
    exportPdfFile,
  }
}
