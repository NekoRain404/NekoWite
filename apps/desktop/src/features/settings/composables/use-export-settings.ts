import { computed, type ComputedRef, type WritableComputedRef } from 'vue'
import { t } from '../../../i18n'
import {
  exportHtml,
  exportImage,
  exportToPdf,
  renderCsv,
  renderPlainText,
  type ExportUiOptions,
} from '../../../services/export'
import { exportBaseName, exportFileName, forceExportExtension } from '../../../services/export-name'
import type { ExportFileFormat } from '../../../services/export-name'
import { toExportRefs } from '../../../services/export-refs'
import { fsService } from '../../../platform/gateways/fs'
import { VAULT_ROOT_DIR } from '../../../platform/gateways/contracts'
import { flushEdits } from '../../../services/editor-ownership'
import { describeExportError, notifyError } from '../../../services/errors'
import { announce } from '../../../services/announcer'
import { MAX_ATTACHMENT_BYTES, formatAttachmentBytes, isPathWithinVault } from '../../attachments'
import { useRefsStore } from '../../../stores/refs'
import { useSettingsStore } from '../../../stores/settings'
import type {
  ExportImageFormat,
  ExportPdfOrientation,
  ExportPdfPageSize,
} from '../../../stores/settings'
import { useTabsStore } from '../../../stores/tabs'

export interface ExportSettingsModel {
  /** Whether a note is open for the export buttons to act on. */
  hasActiveTab: ComputedRef<boolean>
  /** Writable, so the section binds them with `v-model` and the write still
   *  lands in the store rather than in a copy (§10.3-C). */
  frontmatter: WritableComputedRef<boolean>
  pageSize: WritableComputedRef<ExportPdfPageSize>
  orientation: WritableComputedRef<ExportPdfOrientation>
  /** The paper margin in millimetres, uniform on all four sides. */
  marginMm: WritableComputedRef<number>
  imageFormat: WritableComputedRef<ExportImageFormat>
  imageQuality: WritableComputedRef<number>
  exportHtmlFile: () => Promise<void>
  exportPdfFile: () => Promise<void>
  exportImageFile: () => Promise<void>
  exportTextFile: () => Promise<void>
  exportCsvFile: () => Promise<void>
}

/** The vault-relative form of a path the vault-confinement check has already
 *  accepted, split into the directory the export writes into and the file name
 *  it asks for. `saveAttachment` takes the two separately — it resolves the
 *  directory through its own traversal guard and sanitizes the name itself, so
 *  handing it an absolute path is not an option.
 *
 *  A destination AT the vault root has no directory part, and `''` must not be
 *  sent for it: empty already means "no directory was chosen" at both gateways
 *  and files the image under the legacy `attachments/{YYYY-MM}` — the native
 *  dialog opens in the vault root and Save-without-navigating is its default
 *  answer, so that case wrote the file where the user did not put it. The root
 *  gets its own value instead; see {@link VAULT_ROOT_DIR}. */
function splitVaultPath(vault: string, savePath: string): { dir: string; name: string } {
  const rel = savePath.replace(/\\/g, '/').slice(vault.replace(/\\/g, '/').replace(/\/+$/, '').length)
  const parts = rel.replace(/^\/+/, '').split('/').filter(Boolean)
  const name = parts.pop() ?? ''
  return { dir: parts.length > 0 ? parts.join('/') : VAULT_ROOT_DIR, name }
}

/**
 * The export section's state and its commands.
 *
 * §10.3-C: the export *commands* live here rather than in the section, which
 * emits nothing and reads no store of its own. The section is given writable
 * computeds so a `v-model` write still lands in the store rather than in a
 * copy.
 *
 * The implementation belongs to `services/export` and its siblings; this file
 * is the orchestration the UI needs around it — pick a destination, prove it
 * is inside the vault, flush the editors so the export is of the live text, and
 * say what happened.
 */
export function useExportSettings(): ExportSettingsModel {
  const tabs = useTabsStore()
  const refs = useRefsStore()
  const settings = useSettingsStore()

  const hasActiveTab = computed(() => !!tabs.activeTab?.content)

  /**
   * The options every exporter is handed.
   *
   * `path` is `null` for an unsaved untitled document, which is a real state —
   * `tab-lifecycle` opens tabs that way and the session restores them — and not
   * a value to be asserted into a string. Nothing here needs one: the title
   * falls back to `untitled` (that is what `exportBaseName` is for) and the
   * image resolver degrades to no note context, exactly as it does when a note
   * is opened without a vault. Typing the parameter as the truth is what lets
   * the five export commands pass `tab.path` through unchanged instead of each
   * inventing an `?? ''` that would hide a null that should not be one.
   */
  function exportOptions(path: string | null): ExportUiOptions {
    return { title: exportBaseName(path), refs: toExportRefs(refs.refs.values()), notePath: path }
  }

  /**
   * Ask the user where the file goes, and refuse before any work is done when
   * the answer cannot be written.
   *
   * The native dialog lets the user aim anywhere (Desktop, Home, …), but the
   * Rust `write_file` command is vault-confined — an absolute path outside the
   * vault is rejected with "path escapes vault" and the export silently fails.
   * (Preferred fix, needing a backend change: a dedicated non-confined
   * `export_file` command that writes an absolute path outside the vault.)
   * Until that lands, do not lead the user to a doomed path: short-circuit a
   * vault-external destination up front and tell them to pick a vault path.
   */
  /**
   * The vault is the one thing an export cannot be without, and this is the
   * single place that says so: the return type carries a non-null `vault`, so
   * every caller downstream is holding a string the compiler has already
   * proved. An untitled note's null `path` is a different thing — see
   * {@link exportOptions} — and is threaded, not refused.
   */
  async function pickSavePath(
    notePath: string | null,
    format: ExportFileFormat,
  ): Promise<{ path: string; vault: string } | null> {
    const vault = tabs.vault
    const chosen = await fsService.saveFileDialog(exportFileName(notePath, format), vault ?? undefined)
    if (!chosen) return null
    if (!vault) {
      notifyError(t('error.exportOutsideVault'))
      return null
    }
    if (!isPathWithinVault(chosen, vault)) {
      notifyError(t('error.exportOutsideVault'))
      return null
    }
    // The dialog is a text field, so the extension it returns is whatever the
    // user typed. The bytes are decided by the format, so the extension is too.
    return { path: forceExportExtension(chosen, format), vault }
  }

  async function exportHtmlFile(): Promise<void> {
    const tab = tabs.activeTab
    if (!tab) return
    const target = await pickSavePath(tab.path, 'html')
    if (!target) return
    try {
      // The tab lags the source pane by its debounce window; export the live text.
      await flushEdits()
      await exportHtml(tab.content, target.vault, target.path, exportOptions(tab.path))
    } catch (e) {
      // Belt-and-braces: if the backend still rejects (e.g. a symlink resolved
      // outside), describeExportError maps it to a clear hint.
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
      await exportToPdf(tab.content, exportOptions(tab.path))
    } catch (e) {
      notifyError(describeExportError(e))
    }
  }

  async function exportImageFile(): Promise<void> {
    const tab = tabs.activeTab
    if (!tab) return
    const format = settings.exportImageFormat
    const target = await pickSavePath(tab.path, format)
    if (!target) return
    try {
      await flushEdits()
      const image = await exportImage(tab.content, format, settings.exportImageQuality, exportOptions(tab.path))
      // The Rust side caps an attachment at 10 MiB and says so in its own
      // words; checking here means the user gets a sentence about their image
      // instead of a backend error string, and gets it before the encode ships
      // 4/3 of it over IPC.
      if (image.bytes > MAX_ATTACHMENT_BYTES) {
        notifyError(t('settings.export.imageTooLarge', {
          size: formatAttachmentBytes(image.bytes),
          max: formatAttachmentBytes(MAX_ATTACHMENT_BYTES),
        }))
        return
      }
      // `dir` is `VAULT_ROOT_DIR` when the destination is the vault root
      // itself — the one value that says "here", not "nowhere" (see
      // `splitVaultPath`).
      const { dir, name } = splitVaultPath(target.vault, target.path)
      // `saveAttachment` is the vault's only binary write path (`fs.write`
      // takes a string, and a data URL in a `.png` is not a PNG), and it
      // deduplicates rather than overwrites — so the name on disk is the one
      // it returns, not necessarily the one that was asked for. Say where it
      // actually went.
      const written = await fsService.saveAttachment(target.vault, name, image.base64, dir)
      announce(t('settings.export.imageSaved', {
        path: written,
        width: image.width,
        height: image.height,
        size: formatAttachmentBytes(image.bytes),
      }))
    } catch (e) {
      notifyError(describeExportError(e))
    }
  }

  async function exportTextFile(): Promise<void> {
    const tab = tabs.activeTab
    if (!tab) return
    const target = await pickSavePath(tab.path, 'txt')
    if (!target) return
    try {
      await flushEdits()
      await fsService.write(target.vault, target.path, await renderPlainText(tab.content, exportOptions(tab.path)))
    } catch (e) {
      notifyError(describeExportError(e))
    }
  }

  async function exportCsvFile(): Promise<void> {
    const tab = tabs.activeTab
    if (!tab) return
    const target = await pickSavePath(tab.path, 'csv')
    if (!target) return
    try {
      await flushEdits()
      const csv = await renderCsv(tab.content, exportOptions(tab.path))
      // A document with no table has nothing to put in a spreadsheet. Writing
      // an empty file and letting the user find out in Excel would be a lie
      // dressed as a success.
      if (csv === null) {
        notifyError(t('settings.export.noTables'))
        return
      }
      await fsService.write(target.vault, target.path, csv)
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
    marginMm: computed({
      get: () => settings.exportMarginMm,
      set: (v) => { settings.exportMarginMm = v },
    }),
    imageFormat: computed({
      get: () => settings.exportImageFormat,
      set: (v) => { settings.exportImageFormat = v },
    }),
    imageQuality: computed({
      get: () => settings.exportImageQuality,
      set: (v) => { settings.exportImageQuality = v },
    }),
    exportHtmlFile,
    exportPdfFile,
    exportImageFile,
    exportTextFile,
    exportCsvFile,
  }
}
