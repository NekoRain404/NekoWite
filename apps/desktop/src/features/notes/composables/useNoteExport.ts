/**
 * Exporting the note the user acted on: the two commands, and the arguments
 * both hand to the export pipeline.
 *
 * Every export here is about ONE path — the note the menu was opened on. The
 * vault, the target's own tab and the citation library arrive as parameters, so
 * nothing in this module can fall back to the active tab: the wrong-note export
 * this whole boundary exists to prevent is not reachable from here.
 */

import { fsService } from '../../../platform/gateways/fs'
import { t } from '../../../i18n'
import { isPathWithinVault } from '../../attachments'
import { describeExportError, notifyError } from '../../../services/errors'
import { exportHtml, exportToPdf, type ExportUiOptions } from '../../../services/export'
import { exportBaseName } from '../../../services/exportName'
import { toExportRefs } from '../../../services/exportRefs'
import type { Reference } from '../../../services/refs'
import { flushEdits } from '../../../services/editorOwnership'
import { noteActionTarget, readTargetContent } from '../../../services/noteActions'
import type { NoteActionDeps, NoteActionTab } from '../../../services/noteActions'

export interface UseNoteExportOptions {
  /** The vault the target note lives in, or null when none is open. */
  vault: () => string | null
  /** The open tab for `path`, or null when the note is not open. The lookup
   *  must key on the path — it is asked for the target's path, not for "the
   *  current tab". */
  findTab: (path: string) => NoteActionTab | null
  /** Open a note as a tab, for the reads `readTargetContent` routes through the
   *  editor. */
  openTab: (path: string) => Promise<void>
  /** The vault's citation library, so a cited `[@key]` renders identically
   *  whichever way the note leaves the app. */
  refs: () => Iterable<Reference>
}

export interface NoteExportModel {
  /** Export the target as a self-contained `.html` file. */
  exportHtml(path: string): Promise<void>
  /** Export the target through the app's own print frame. */
  exportPdf(path: string): Promise<void>
}

export function useNoteExport(options: UseNoteExportOptions): NoteExportModel {
  /**
   * The dependencies {@link readTargetContent} resolves a target's text with.
   * The lookup keys on the path — it is asked for the right-clicked note's tab,
   * not for the active one — and the read is the fs gateway's own vault read.
   */
  function exportDeps(): NoteActionDeps {
    return {
      read: (vault, path) => fsService.read(vault, path),
      findTab: (path) => options.findTab(path),
      flushEdits: () => flushEdits(),
      openTab: (path) => options.openTab(path),
    }
  }

  /**
   * The options both exports hand to the pipeline.
   *
   * `notePath` is the load-bearing one: attachments and citations are resolved
   * against it, so leaving it out resolves the target's `![](pic.png)` against
   * whatever note happens to be open — the wrong-note bug this whole menu is
   * built to avoid. `refs` is the same map the settings dialog exports with, so
   * a cited `[@key]` renders identically whichever way the note leaves the app.
   */
  function exportOptions(path: string): ExportUiOptions {
    return {
      title: exportBaseName(path),
      notePath: path,
      refs: toExportRefs(options.refs()),
    }
  }

  /**
   * Export the right-clicked note as a self-contained `.html` file.
   *
   * The source is the target's LATEST text ({@link readTargetContent}: its own
   * open tab, flushed first when it is the active one, its file otherwise), and
   * the default name is the target's. Everything happens about `path`; the
   * active tab is not an input.
   */
  async function exportNoteHtml(path: string): Promise<void> {
    const vault = options.vault()
    // The dialog comes first, so a cancelled save is a decision with no side
    // effects at all — nothing is read, nothing is exported, nothing is said.
    const savePath = await fsService.saveFileDialog(exportBaseName(path) + '.html', vault ?? undefined)
    if (!savePath) return
    // The native dialog can aim anywhere (Desktop, Home, …), but the backend's
    // write is vault-confined: an outside path is rejected with "path escapes
    // vault" and the export dies silently behind the closed dialog. Refuse it up
    // front, with the message the settings dialog already shows.
    if (vault && !isPathWithinVault(savePath, vault)) {
      notifyError(t('error.exportOutsideVault'))
      return
    }
    try {
      const source = await readTargetContent(exportDeps(), vault, noteActionTarget(path))
      await exportHtml(source, vault ?? '', savePath, exportOptions(path))
    } catch (e) {
      // Reported, never swallowed: a rejected read (the note is gone) and a
      // rejected write look exactly like the menu item doing nothing.
      notifyError(describeExportError(e))
    }
  }

  /** Export the right-clicked note through the app's own print frame. There is
   *  no destination to pick, so only the target matters. */
  async function exportNotePdf(path: string): Promise<void> {
    const vault = options.vault()
    try {
      const source = await readTargetContent(exportDeps(), vault, noteActionTarget(path))
      await exportToPdf(source, exportOptions(path))
    } catch (e) {
      notifyError(describeExportError(e))
    }
  }

  // Renamed on the way out: inside this module `exportHtml` is the pipeline
  // function, and a local handler of the same name would shadow it (and recurse
  // into itself) at the call site below.
  return { exportHtml: exportNoteHtml, exportPdf: exportNotePdf }
}
