/**
 * Data-recovery closed loop (dev.md §4 P0.4).
 *
 * Two gaps close the recovery model in `docs/RECOVERY.md`:
 *
 * 1. **Orphaned `.tmp` crash-litter** — a paste/drop staged an image under
 *    `.tmp` but a crash (or a closed, never-saved tab) left it there. On
 *    vault open we scan `.tmp`, surface a "recoverable versions" notice for the
 *    files nobody references, and auto-GC the ones older than a threshold that
 *    are confirmed untracked (so a recent crash stays reviewable while old
 *    litter is swept). Scan/GC are cancellable and non-blocking (fire-and-forget
 *    from the bootstrap, never awaiting the vault open).
 * 2. **Unnamed dirty documents on a vault switch** — `tabs.flushDirty()` saves
 *    path'd tabs silently but skips untitled ones (they would need a Save-As
 *    dialog a background flush must not open). `requestUntitledVaultSwitch`
 *    surfaces a keep-or-discard prompt for exactly those tabs and resolves to a
 *    user choice so `applyVault` can block the switch until the work is either
 *    saved or dropped — never silently discarded.
 *
 * Pure controller — injects the fs port, the "referenced" source of truth and
 * a notify sink, so it runs unchanged against the Tauri gateway, an in-memory
 * gateway, or a mock (see `recoveryClosedLoop.test.ts`).
 */

import { ATTACHMENTS_DIR, attachmentMonthDir } from '../services/attachments'
import { notifyError, type RecoveryPrompt } from '../services/errors'
import { t as i18nT } from '../i18n'
import type { FsPort } from '../platform/gateways/contracts'
import { stripVaultPrefix } from '../services/paths'

/** Default age (ms) after which an *orphaned* `.tmp` file is GC'd. 7 days is
 *  generous enough that a real crash's staged assets stay reviewable, but flushes
 *  truly abandoned litter. */
export const TMP_GC_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface TmpFileRef {
  /** Vault-relative path, e.g. `.tmp/paste-20260904-123456.png` (normalised
   *  from whatever spelling `list` returned). */
  path: string
  /** Basename as listed by the fs. */
  name: string
  /** Last-modified time (ms epoch, from `stat`). */
  mtime: number
  size: number
}

export interface TmpRecoveryDeps {
  fs: Pick<FsPort, 'list' | 'stat' | 'deleteFile' | 'renameEntry'>
  /** Vault-relative `.tmp` paths still referenced by a note — the open tabs'
   *  pending staged assets/body refs, or the app's composed promise that also
   *  scans every note whose tab is closed. Never GC'd or surfaced. A provider
   *  that can tell the answer is partial returns `{ paths, complete: false }`;
   *  the plain-set form means "complete" for callers that have nothing more to
   *  say (see {@link TmpReferenceSet}). */
  getReferencedTmp: () => TmpReferenceSet | Set<string> | Promise<TmpReferenceSet | Set<string>>
  /** Where a "recoverable versions" prompt is surfaced. Defaults to the app
   *  recovery toast via `notifyRecovery`. */
  notify?: (p: RecoveryPrompt) => void
  /** Clock (default `Date.now`) so age thresholds are testable. */
  now?: () => number
  /** Translate a message key (defaults to the shared i18n `t`). */
  t?: (key: string, params?: Record<string, unknown>) => string
  /** Surface a failed restore. Defaults to the app's error toast. */
  notifyError?: (message: string) => void
}

export interface TmpReferenceSet {
  paths: Set<string>
  /** False when the provider knows it did not see every note. */
  complete: boolean
}

export interface TmpRecoveryController {
  /** Enumerate orphaned `.tmp` files (not referenced by any note — the app's
   *  provider unions the open tabs with a vault-wide scan). Surfaces a
   *  "recoverable versions" notice when any exist. Non-blocking; honours
   *  {@link cancel}. */
  scan(vault: string): Promise<TmpFileRef[]>
  /** Remove orphaned `.tmp` files older than `thresholdMs`. Returns the count
   *  removed. Non-blocking; honours {@link cancel}. */
  gc(vault: string, thresholdMs?: number): Promise<number>
  /** Cancel any in-flight scan/GC at the next await boundary. */
  cancel(): void
  /** True after {@link cancel}. */
  isCancelled(): boolean
}

export function createTmpRecovery(deps: TmpRecoveryDeps): TmpRecoveryController {
  let cancelled = false

  const notify = deps.notify
  const now = deps.now ?? (() => Date.now())
  const t = deps.t ?? i18nT
  const reportError = deps.notifyError ?? notifyError

  function cancel(): void {
    cancelled = true
  }

  function isCancelled(): boolean {
    return cancelled
  }

  /** The referenced `.tmp` set normalised to one spelling.
   *
   *  `getReferencedTmp` is vault-relative by contract, but the fs port is not:
   *  the real `list_dir` returns ABSOLUTE paths while a mock may list relative
   *  ones. Comparing the raw strings made every staged asset in the Tauri app
   *  look like crash litter — the prompt's "restore" then moved the file to
   *  `attachments/` while the note still referenced `.tmp/…`, and `gc` swept a
   *  still-referenced asset. `stripVaultPrefix` absorbs the separators and the
   *  `\\?\` verbatim prefix too, so both sides agree. */
  async function referencedPaths(vault: string): Promise<TmpReferenceSet> {
    // The provider may be async: the app unions the open-tab set with a
    // vault-wide scan that reads every note. Awaiting it here keeps `scan` and
    // `gc` using the exact same set, so they can never disagree about what is
    // still referenced.
    const provided = await deps.getReferencedTmp()
    const paths = provided instanceof Set ? provided : provided.paths
    return {
      paths: new Set([...paths].map((p) => stripVaultPrefix(p, vault))),
      complete: provided instanceof Set ? true : provided.complete,
    }
  }

  async function collect(vault: string): Promise<TmpFileRef[]> {
    // No `.tmp` dir yet (or a transient list error) is not a failure — there is
    // simply no crash-litter to reconcile.
    const entries = await deps.fs.list(vault, '.tmp').catch(() => [])
    const out: TmpFileRef[] = []
    for (const entry of entries) {
      if (cancelled) break
      if (entry.is_dir) continue
      const st = await deps.fs.stat(vault, entry.path).catch(() => null)
      if (st) {
        out.push({
          path: stripVaultPrefix(entry.path, vault),
          name: entry.name,
          mtime: st.mtime,
          size: st.size,
        })
      }
    }
    return out
  }

  function orphaned(files: TmpFileRef[], referenced: Set<string>): TmpFileRef[] {
    return files.filter((f) => !referenced.has(f.path))
  }

  async function scan(vault: string): Promise<TmpFileRef[]> {
    const files = await collect(vault)
    // LAZY ordering: the listing is collected BEFORE the referenced set is
    // looked up, and an empty `.tmp` returns right here. The app's provider now
    // includes a vault-wide scan that reads every note, so the common vault (no
    // `.tmp` dir, or nothing staged) must never pay for it. `gc` below is
    // ordered the same way to keep both on one contract.
    if (files.length === 0) return []
    const { paths: referenced, complete } = await referencedPaths(vault)
    // A cancel that landed while awaiting the (possibly async) provider must
    // not surface a notice for a vault the user has already left.
    if (cancelled) return []
    const orphans = orphaned(files, referenced)
    // An incomplete picture must never be acted on. "We could not read every
    // note" is not "nothing references these files": the restore below MOVES
    // the file into `attachments/`, so a `.tmp` reference in a note the scan
    // failed to read would be broken for good. Withhold the offer until a
    // complete scan says it is safe — the files stay in `.tmp` meanwhile.
    if (!complete) return orphans
    if (orphans.length > 0 && notify) {
      notify({
        message: t('recovery.tmpNotice', { count: orphans.length }),
        onRestore: () => {
          // Move the crashed srcs into the vault's attachment library so the
          // image data survives as a recoverable asset.
          //
          // Failures are REPORTED, not swallowed: this used to `.catch(() => {})`
          // every rename, so if a file had already been removed (the GC ran
          // between the scan and the click) the button did nothing at all — no
          // file in attachments/, no message, nothing to act on.
          void (async () => {
            const failed: string[] = []
            for (const o of orphans) {
              try {
                await deps.fs.renameEntry(
                  vault,
                  o.path,
                  `${ATTACHMENTS_DIR}/${attachmentMonthDir()}/${o.name}`,
                )
              } catch {
                failed.push(o.name)
              }
            }
            if (failed.length > 0) {
              reportError(
                i18nT('recovery.restoreFailed', { count: failed.length, names: failed.join(', ') }),
              )
            }
          })()
        },
        onDismiss: () => {
          // Leave the files for the age-threshold GC.
        },
      })
    }
    return orphans
  }

  async function gc(vault: string, thresholdMs = TMP_GC_AGE_MS): Promise<number> {
    const files = await collect(vault)
    // Same lazy ordering as `scan`: nothing collected means nothing can be
    // swept, so the vault-wide referenced-set scan is never launched.
    if (files.length === 0) return 0
    const { paths: referenced, complete } = await referencedPaths(vault)
    // Same rule as `scan`, for the same reason: a partial scan would DELETE
    // files that a note the scan could not read still points at. Litter we keep
    // is recoverable; litter we delete is not.
    if (!complete) return 0
    const cutoff = now() - thresholdMs
    let removed = 0
    for (const file of files) {
      if (cancelled) break
      // Only confirmed untracked/orphaned files are swept, and only past the age
      // threshold — a referenced `.tmp` asset (still awaiting relocation on its
      // note's first save) is never a GC candidate.
      if (referenced.has(file.path)) continue
      if (file.mtime > cutoff) continue
      try {
        await deps.fs.deleteFile(vault, file.path)
        removed += 1
      } catch {
        // A single unlink failure must not abort sweeping the rest.
      }
    }
    return removed
  }

  return { scan, gc, cancel, isCancelled }
}

export type UntitledVaultChoice = 'save' | 'discard'

/**
 * Ask the user what to do with `count` unnamed dirty documents before a vault
 * switch. Resolves to `'save'` (restore) or `'discard'` (dismiss) so the caller
 * can block the switch until the work is either saved via Save-As or dropped —
 * it is never silently discarded. The recovery prompt is the app's recovery
 * channel: "Restore" maps to save-and-switch, "Dismiss" to discard-and-switch.
 */
export function requestUntitledVaultSwitch(deps: {
  count: number
  notify: (p: RecoveryPrompt) => void
  /** Message key for the prompt. Defaults to the vault-switch wording; the
   *  close-all path passes its own because "save before switching" would
   *  describe an action the user is not taking. */
  messageKey?: string
}): Promise<UntitledVaultChoice> {
  return new Promise((resolve) => {
    deps.notify({
      message: i18nT(deps.messageKey ?? 'tabs.untitledVaultSwitchMsg', { count: deps.count }),
      onRestore: () => resolve('save'),
      onDismiss: () => resolve('discard'),
    })
  })
}
