/**
 * One vault change, end to end.
 *
 * Every way the app's vault can change comes through here — the sidebar, the
 * settings panel, the folder dialog, the vault startup restores, and a file the
 * OS handed the process — because a second implementation of "switch vaults"
 * beside this one is how the outgoing vault's unsaved work gets dropped, its
 * watcher is left armed, or its authorization outlives it. `app-bootstrap` is
 * left with the composition and the startup ORDER; what a switch does is here.
 *
 * It has one optional input and it is not a detail: whether this switch makes
 * `path` the vault the app OPENS ON next launch. The folder dialog, the sidebar
 * and the settings panel are answers to "where is my workspace?", and startup's
 * restore is too. A file the OS handed the process is not: it is evidence that
 * someone asked for a DOCUMENT, and if that document happens to live outside
 * every vault, the folder it sits in is served for it (the backend has already
 * vouched for the root — `open_file.rs`) and must not become the workspace.
 * That is `remember: false`, and it is what one double-click on
 * `~/Downloads/report.md` no longer does to the vault the user was working in.
 */

import type { Ref } from 'vue'
import type { FsPort } from '../platform/gateways/contracts'
// Imported for its TYPE: `ReturnType<typeof useTabsStore>` is the store's own
// instance type, so this dependency cannot drift from the store. The tabs store
// is constructed by the composition root, which passes the instance in.
import { useTabsStore } from '../stores/tabs'
import { createUnflushableRescue } from '../stores/unflushable-rescue'
import { invalidateImageResolution } from '@nekowite/editor-core'
import { notifyError, notifyRecovery } from '../services/errors'
import { persistence } from '../services/persistence'
import { t } from '../i18n'
import { requestUntitledVaultSwitch } from './recovery-closed-loop'
import type { VaultBackground } from './vault-background'

/**
 * The root the app starts on next launch, as the backend's record and this
 * module's own write: `runStartup` reads it, and `apply` writes it on the
 * switches that are answers about the workspace.
 */
export const VAULT_LS_KEY = 'nekowite.vault'

export interface VaultSwitchOptions {
  /**
   * Whether this switch records `path` as the vault the next launch opens on.
   * Defaults to true — every caller that is the user choosing a workspace.
   * `false` is for a root a LAUNCH adopted around a file it was handed: the
   * switch serves the document and the workspace stays where the user left it.
   */
  remember?: boolean
}

export interface VaultSwitchDeps {
  tabs: ReturnType<typeof useTabsStore>
  fs: FsPort
  /** The vault the runtime has open. Owned by the caller because the window
   *  reads it, and written here on commit. */
  vaultPath: Ref<string | null>
  /** True once the runtime is torn down, so no completion point below can
   *  revive work after teardown. */
  isDisposed: () => boolean
  /** Everything the committed vault keeps running. Armed only by a commit. */
  background: VaultBackground
}

export interface VaultSwitch {
  /** Switch to `path`: flush the outgoing vault's unsaved work, authorize the
   *  root with the backend, and commit. Resolves without committing when it
   *  refuses, with the reason already on screen. */
  apply(path: string, options?: VaultSwitchOptions): Promise<void>
  /** Abort any in-flight switch and stop the vault-scoped work. Idempotent. */
  teardown(): void
}

export function createVaultSwitch(deps: VaultSwitchDeps): VaultSwitch {
  const { tabs, fs, vaultPath, isDisposed, background } = deps
  // App-level latest-wins guard for vault switches. Each switch bumps the
  // sequence and aborts the previous switch's controller; every async completion
  // point re-checks `isStale` (seq mismatch or an aborted signal) and bails, so a
  // superseded switch can never overwrite state after a newer one has claimed it.
  let vaultSwitchSeq = 0
  let vaultSwitchController: AbortController | null = null

  function startVaultSwitch(): { seq: number; signal: AbortSignal } {
    vaultSwitchController?.abort()
    const controller = new AbortController()
    vaultSwitchController = controller
    return { seq: ++vaultSwitchSeq, signal: controller.signal }
  }

  /**
   * The route out of a switch a refused save would otherwise block forever: a
   * copy of the stuck tab's text under a name the user picks, from the one loop
   * the window close and "Close all" already ask for
   * (`stores/unflushable-rescue.ts`). A note restored from the trash carries the
   * read-only bit, so the user need never have set it — and without this, "the
   * vault was not switched" left them with no move that did not cost them either
   * the edits or a trip out of the app to `chmod` the file.
   *
   * A third instantiation of the same stateless factory, not a fourth copy of
   * the loop: `128` established that one instance registered in the store would
   * make a route depend on mount order, so each control builds its own from this
   * factory — the app layer building one is what the extraction was for. This is
   * the app layer's second (the window close is `app-lifecycle.ts`'s).
   */
  const rescueUnflushableTabs = createUnflushableRescue({
    listTabs: () => tabs.tabs,
    t,
    notifyRecovery,
    saveTab: (id, opts) => tabs.saveTab(id, opts),
    saveUntilSettled: (id) => tabs.saveUntilSettled(id),
  })

  async function apply(path: string, options: VaultSwitchOptions = {}): Promise<void> {
    const { remember = true } = options
    const { seq, signal } = startVaultSwitch()
    // `disposed` makes any completion point after teardown stale, so no fire-and-
    // forget work re-launches (e.g. a stale plugin load re-running for the vault).
    const isStale = (): boolean => isDisposed() || seq !== vaultSwitchSeq || signal.aborted

    // A vault switch must not silently drop unsaved edits from the vault we are
    // leaving. Flush the current dirty tabs first; if one fails to save, block
    // the switch so the work is lost to a pending autosave timer that will
    // never fire on the new vault.
    //
    // A tab whose first read has not landed is a placeholder — an EMPTY document
    // wearing the note's path — and no write can settle it (`tab-write-
    // preconditions.ts` refuses every write while `loading`), so `flushDirty()`
    // answers false for as long as that read is pending: forever, if it never
    // lands, and nothing else on this path can settle it. What the user typed
    // into such a tab is not the note's text and cannot be written to the note,
    // so it moves to a tab of its own FIRST — before the flush, and before the
    // untitled prompt below, which is what offers it back to the user before
    // `removeAllTabs()` takes the tab set away. The same step, in the same
    // place, as the two closes (`tab-close.ts`): one function, three routes.
    await tabs.reconcilePlaceholders()
    const flushed = await tabs.flushDirty()
    if (isStale()) return
    if (!flushed) {
      // A save did not land, and for a file that REFUSES the write it will not
      // land however many times it is retried (`refused-save.ts`). Refusing the
      // switch is still right — `removeAllTabs()` below takes the tab set — but
      // a refusal with no move behind it is how a user who typed into a
      // protected note ended up choosing between their edits and `chmod`. Offer
      // the copy route, the same one the two closes offer, and go on once the
      // text is somewhere the user chose.
      //
      // HERE, and not one line later: `registerVault` below REPLACES the
      // authorized root, and a copy is written through the vault-tagged write
      // path, so a rescue below that line would aim the Save-As at the vault
      // being switched TO — the wrong vault to file it in, and a root the
      // backend refuses anyway once the new one is registered. This is the same
      // ordering `521a0d4` established for `reconcilePlaceholders` above:
      // everything that writes into the OUTGOING vault happens while it is still
      // the open one.
      //
      // AFTER the flush, and not before it: the flush is what decides which tabs
      // the route is even about. A tab the gate settled is not one to offer a
      // copy of, and asking about it would put a Save-As dialog in front of a
      // user whose save had just landed.
      const rescued = await rescueUnflushableTabs()
      // The route is user time — the dialog stays open for as long as they take
      // — so this is a completion point like the flush above, and the switch is
      // judged stale by the same rule.
      if (isStale()) return
      if (!rescued) {
        notifyError(t('tabs.unsavedWorkBlocker'))
        return
      }
    }
    // Unnamed dirty docs have no path, so `flushDirty` skipped them (a Save-As
    // dialog is too interactive for a background/bulk flush). A switch must not
    // silently discard them either — surface a keep-or-discard prompt and block
    // the switch until the user chooses: save-as each (restore) and proceed, or
    // discard them (dismiss) and proceed.
    const untitled = tabs.untitledDirtyTabs()
    if (untitled.length > 0) {
      const choice = await requestUntitledVaultSwitch({ count: untitled.length, notify: notifyRecovery })
      if (isStale()) return
      if (choice === 'save') {
        for (const tab of untitled) {
          // The gate, not `saveTab`: an untitled tab is saved here by the
          // Save-As write, and that write's `true` says only that the text it
          // captured landed. `removeAllTabs()` below is the point of no return
          // for the tab set, and a keystroke during the write would go with it —
          // the write path's own comment promises the newer text a pending
          // autosave timer of its own (see `tab-settle.ts`), and this switch is
          // where that promise stops being keepable.
          const settled = await tabs.saveUntilSettled(tab.id)
          if (isStale()) return
          if (!settled) {
            notifyError(t('tabs.unsavedWorkBlocker'))
            return
          }
        }
      } else {
        for (const tab of untitled) tabs.removeTab(tab.id)
        if (isStale()) return
      }
    }
    // Authorize the vault root with the backend BEFORE any path-confined command:
    // the Rust commands now reject any root the user did not open this session.
    // This is the ONLY registration point, for a fresh pick and a localStorage
    // restore alike. Must run before indexVault.
    //
    // It must also stay AFTER the `flushDirty()` above: `registerVault` REPLACES
    // the authorized root, so registering (or letting the folder dialog register,
    // as it once did) before the outgoing vault's dirty tabs are saved makes that
    // save fail with "vault root not opened" — which aborts the switch and leaves
    // the UI on a vault the backend now refuses.
    //
    // Registration success is a PRECONDITION to committing the switch. If the vault
    // is stale (deleted / permission lost), committing it would take over the UI and
    // then fail every subsequent path-confined command from Rust. So on failure we
    // DO NOT switch: no setVault/closeAll/index/plugins/refs/tmp-recovery, we surface
    // a recoverable error, and we stay on the current vault (the previous state).
    try {
      await fs.registerVault(path)
    } catch {
      if (isStale()) return
      notifyError(`could not open the vault (missing/permission): ${path}`)
      return
    }
    if (isStale()) return

    // Commit to the new vault. Only a current switch reaches this point, so a
    // superseded switch never applies its vault/path/tab-set to the session. Record
    // the chosen vault only now that the switch is actually committed, so a failed
    // open never leaves a bad path behind to retry on the next launch.
    vaultPath.value = path
    // Through the persistence port: a disabled/quota-full storage throws on
    // `localStorage.setItem` and would abort the switch AFTER the vault was
    // registered and the tabs were closed — an unrecoverable half-switch.
    //
    // And only when this switch IS the user choosing where their workspace is.
    // A launch-adopted root (see `VaultSwitchOptions.remember`) is written
    // nowhere: recording it would make the next launch start in a folder the
    // user never chose, which is precisely what a double-clicked `.md` in
    // `~/Downloads` must not do.
    if (remember) persistence.set(VAULT_LS_KEY, path)
    // Open tabs keep absolute paths from the previous vault — leaving them open
    // would route every save to "path escapes vault" errors. Start fresh. This
    // uses the non-interactive variant on purpose: every dirty tab was flushed
    // and every untitled one was prompted for above, so `closeAll`'s own guard
    // would only ask the user a second time for a decision they just made.
    tabs.removeAllTabs()
    tabs.setVault(path)
    // Arm the OS-level folder watcher HERE, at the app level. It used to be armed
    // only by the file tree, which exists while the Folders panel is shown — so a
    // vault opened through the default Notes panel was not watched at all: an
    // external edit was never noticed and the next save silently overwrote it.
    // The backend keeps exactly one managed watcher and replaces it on each call,
    // so re-arming (e.g. from the tree) is idempotent rather than additive.
    void fs.watch(path).catch((e) => {
      // External-change detection silently stops working if this fails, so make
      // the failure visible in the console instead of swallowing it.
      console.error("[NekoWrite] could not watch the vault: external edits will not be detected", e)
    })
    // The vault is now committed (and authorized with the backend), so every
    // attachment path finally resolves. Drop any resolution that ran before
    // this point — the editor panel can mount and render before the vault is
    // ready, and a failure recorded then would otherwise stick forever.
    invalidateImageResolution()

    // The rest is the committed vault's own background work: it disposes the
    // outgoing vault's resources and starts the incoming vault's index,
    // plugins, `.tmp` recovery and reference watching.
    background.arm(path, { signal, isStale })
  }

  function teardown(): void {
    // Cancel any in-flight vault switch so a superseded switch can never touch
    // state after teardown (its controller is aborted; all completion points bail).
    vaultSwitchController?.abort()
    vaultSwitchController = null
    background.stop()
  }

  return { apply, teardown }
}
