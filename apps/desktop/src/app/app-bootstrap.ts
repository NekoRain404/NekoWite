import { ref, type Ref } from 'vue'
import { useTabsStore } from '../stores/tabs'
import { useSettingsStore } from '../stores/settings'
import { useVaultSessionStore } from '../stores/vault-session'
import { useRefsStore } from '../stores/refs'
import { detectFormat } from '../services/refs'
import { getSharedGateways } from '../platform/runtime/gateway-runtime'
import { loadVaultPlugins, deactivateVaultPlugins } from '../services/plugins'
import { notifyError, notifyRecovery } from '../services/errors'
import { scanTmpReferences } from '../services/tmp-references'
import { vaultFileIndex } from '../services/vault-files'
import { t } from '../i18n'
import { setupWindowTracking, type WindowTracking } from './window-state'
import { persistence } from '../services/persistence'
import { createTmpRecovery, requestUntitledVaultSwitch } from './recovery-closed-loop'
import { createOpenFileHandler } from './open-file'
import { onOpenFileRequest, takePendingOpen } from '../platform/open-request'
import { setActiveEditor } from '@nekowite/plugin-host'
import { editorBridge } from '../services/editor-bridge'
import { invalidateImageResolution, refreshCiteChips, setCiteKeyResolver } from '@nekowite/editor-core'
import { editorSessionManager } from '../features/editor'

const VAULT_LS_KEY = 'nekowite.vault'

export interface DesktopRuntime {
  /** The currently-open vault root (null before the first folder is picked). */
  vaultPath: Ref<string | null>
  /** Window size/position persistence, shared with the lifecycle module. */
  windowTracking: WindowTracking
  /** Switch the app to a new vault: reconcile the tabs whose first read has not
   *  landed (their typing moves to a tab of its own), flush the dirty tabs, and
   *  authorize the root with the backend before any path-confined command.
   *  Registration failure (missing/permission) does not switch; the switch stays
   *  on the current vault. */
  applyVault(path: string): Promise<void>
  /** Open and switch to the chosen vault. Used by the sidebar and the settings
   *  "vault saved" flow. The vault is recorded only once applyVault commits. */
  onOpenFolder(path: string): void
  /** Open the native folder picker and switch to the chosen vault. */
  pickFolder(): Promise<void>
  /** Run the startup sequence once: restore window geometry, load the vault
   *  session, apply the persisted vault, reopen tabs, start window tracking. */
  start(): void
  /** Release every listener, cancels in-flight work, and tears down the active
   *  session. Also invoked by lifecycle teardown. Idempotent. */
  dispose(): void
}

/**
 * Application composition root.
 *
 * Builds the app-level runtime the shell uses: the vault session, the window
 * geometry tracker, and the folder/vault actions. It owns the startup sequence
 * (window restore → settings → vault → session restore → window tracking) and
 * does not touch the DOM directly — all browser listeners live in appLifecycle.
 */
export function createDesktopRuntime(): DesktopRuntime {
  const tabs = useTabsStore()
  const settings = useSettingsStore()
  const vaultSession = useVaultSessionStore()
  const refs = useRefsStore()
  // The chip and the references panel both need to know which cite keys the
  // library holds; the library is app state, so it is published to the editor
  // here rather than guessed at in two places. Refreshing after each (re)load
  // is what makes a citation change from `[?]` to `[3]` when the `.bib` lands.
  setCiteKeyResolver((key) => refs.get(key) !== undefined)
  // Bootstrap is the composition root: it resolves the shared gateway instance
  // (owned by platform/runtime) and reaches into the narrow ports it needs.
  const gateways = getSharedGateways()
  const { fs: fsPort, dialogs } = gateways
  const vaultPath = ref<string | null>(null)
  const windowTracking = setupWindowTracking()
  // Owns the orphaned-`.tmp` scan/GC. A controller is created per vault switch:
  // `cancel()` permanently flags one instance, so a fresh instance is armed for
  // each new vault (and the prior one is cancelled first so a stale scan can
  // never write results into the new vault).
  let tmpRecovery: ReturnType<typeof createTmpRecovery> | null = null
  // Reference files are read once per vault open, so an export that overwrites
  // `Library.bib` outside the app left the session on the OLD library until the
  // next vault open — a citation the user just exported showed as "not in the
  // library". Watching the vault for reference-file changes keeps it current.
  let refsUnwatch: (() => void) | null = null
  let refsReloadTimer: ReturnType<typeof setTimeout> | null = null

  function makeTmpRecovery(vault: string, isStale: () => boolean) {
    return createTmpRecovery({
      fs: fsPort,
      // The referenced set must cover notes whose tab is CLOSED: `tabs` only
      // knows the open documents, so a vault note on disk that still embeds
      // `![p](.tmp/ok.png)` contributed nothing. The notice then offered to
      // "restore" its image (renaming it to `attachments/…` while the note kept
      // pointing at `.tmp/…`) and `gc` deleted it for good. Union the live set
      // with the vault-wide scan so both halves agree on what is referenced.
      getReferencedTmp: async () => {
        const open = tabs.referencedTmpPaths()
        const onDisk = await scanVaultTmpReferences(vault, isStale)
        // A stale scan belongs to a vault that is no longer current; falling
        // back to the open-tab set under-reports references, so it is reported
        // as INCOMPLETE: the recovery loop then leaves every `.tmp` file alone
        // instead of deleting or relocating one this vault might still use.
        if (!onDisk) return { paths: open, complete: false }
        return { paths: new Set([...open, ...onDisk.paths]), complete: onDisk.complete }
      },
      notify: notifyRecovery,
    })
  }

  /** Vault-wide `.tmp` references (`services/tmpReferences`), guarded by the
   *  switch's `isStale` so a superseded switch or teardown never spends reads on
   *  an abandoned vault. `null` means "fall back to the open-tab set". */
  async function scanVaultTmpReferences(
    vault: string,
    isStale: () => boolean,
  ): Promise<{ paths: Set<string>; complete: boolean } | null> {
    if (isStale()) return null
    try {
      const notes = await vaultFileIndex.get(vault)
      if (isStale()) return null
      const found = await scanTmpReferences(vault, {
        notes,
        read: (v, p) => fsPort.read(v, p),
        shouldAbort: isStale,
        // A walk that hit its directory cap — or that could not list part of
        // the tree — never saw the whole vault, so it cannot certify that a
        // `.tmp` file is unreferenced.
        isComplete: () =>
          !vaultFileIndex.isTruncated(vault) && !vaultFileIndex.isIncomplete(vault),
      })
      return isStale() ? null : found
    } catch {
      // The scan is a safety net for the recovery prompt, never a startup step:
      // a failed index read falls back to the open-tab set instead of breaking
      // the closed loop.
      return null
    }
  }
  // The file the OS asked us to open (`nekowite notes.md`, a double-clicked
  // `.md`). It rides on the vault switch above rather than beside it — see
  // `open-file.ts`.
  const openFiles = createOpenFileHandler({
    vaultPath,
    applyVault,
    openTab: (path) => tabs.openTab(path),
    notifyError,
    takePendingOpen,
    onOpenFileRequest,
  })
  let started = false
  let disposed = false
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

  async function applyVault(path: string): Promise<void> {
    const { seq, signal } = startVaultSwitch()
    // `disposed` makes any completion point after teardown stale, so no fire-and-
    // forget work re-launches (e.g. a stale plugin load re-running for the vault).
    const isStale = (): boolean => disposed || seq !== vaultSwitchSeq || signal.aborted

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
      notifyError(t('tabs.unsavedWorkBlocker'))
      return
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
          const saved = await tabs.saveTab(tab.id)
          if (isStale()) return
          if (!saved) {
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
      await fsPort.registerVault(path)
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
    persistence.set(VAULT_LS_KEY, path)
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
    void fsPort.watch(path).catch((e) => {
      // External-change detection silently stops working if this fails, so make
      // the failure visible in the console instead of swallowing it.
      console.error("[NekoWrite] could not watch the vault: external edits will not be detected", e)
    })
    // The vault is now committed (and authorized with the backend), so every
    // attachment path finally resolves. Drop any resolution that ran before
    // this point — the editor panel can mount and render before the vault is
    // ready, and a failure recorded then would otherwise stick forever.
    invalidateImageResolution()

    // Dispose the previous vault's resources now that the new vault is committed:
    // its active plugin instances/hooks, its index coordinator (which detaches
    // the fs watcher subscription and cancels in-flight index + search-index
    // tasks), and its `.tmp` recovery controller (cancelled before a fresh one
    // is armed so a stale scan can never write results into the new vault).
    deactivateVaultPlugins()
    vaultSession.detachVault()
    tmpRecovery?.cancel()
    tmpRecovery = null

    // Crash-litter reconciliation (recovery closed-loop). GC first (sweeps only
    // old, confirmed-orphaned `.tmp` files), then scan surfaces a "recoverable
    // versions" notice for the fresh orphans left by an interrupted session.
    // Fire-and-forget (never blocks vault open) and cancellable.
    const recovery = makeTmpRecovery(path, isStale)
    tmpRecovery = recovery
    void (async () => {
      // Reclaim first, THEN look for what is left. Running them concurrently (as
      // this did) meant scan listed the directory before gc deleted from it, so
      // the prompt advertised files that were already gone by the time it
      // appeared: the user clicked "restore" on an entry whose rename failed
      // silently, and nothing happened at all.
      await recovery.gc(path)
      if (isStale()) return
      await recovery.scan(path)
    })()
    // Index the new vault: `indexVault` is internally latest-wins (the new
    // coordinator detaches the stale one before subscribing). Plugins and refs
    // are fire-and-forget and guarded below so a superseded switch's late
    // result can never land in the newer vault.
    void vaultSession.indexVault(path)
    void loadVaultPlugins(path).then(() => {
      // A superseded vault's plugin load can settle after a newer switch claimed
      // the vault. Fully discard the stale plugin set, then re-run for the
      // current vault so its plugins stay active — an old vault never leaves its
      // components/commands/hooks registered in the new one.
      if (isStale()) {
        deactivateVaultPlugins()
        // After dispose we must never re-launch plugins — teardown sticks.
        if (!disposed) {
          const current = vaultPath.value
          if (current) void loadVaultPlugins(current)
        }
      }
    })
    watchRefs(path, signal, isStale)
    void refs
      .loadVault(path, { signal })
      .then(() => refreshCiteChips())
      .catch(() => {
        // A stale vault path (deleted/renamed folder) must not crash startup;
        // the tree shows the failure and the user can pick another folder.
      })
  }

  /** (Re)subscribe to the vault's fs-change events for reference files. A
   *  superseded switch's subscription is dropped before a new one is armed, so
   *  a stale watcher can never reload the previous vault's library. */
  function watchRefs(vault: string, signal: AbortSignal, isStale: () => boolean): void {
    refsUnwatch?.()
    refsUnwatch = null
    if (refsReloadTimer) {
      clearTimeout(refsReloadTimer)
      refsReloadTimer = null
    }
    const reload = (): void => {
      if (refsReloadTimer) clearTimeout(refsReloadTimer)
      // Editors export a `.bib` by writing several times (truncate, then
      // chunks); debounce so one export is one reload instead of five.
      refsReloadTimer = setTimeout(() => {
        refsReloadTimer = null
        if (isStale()) return
        void refs
          .loadVault(vault, { signal })
          .then(() => refreshCiteChips())
          .catch(() => {})
      }, 250)
    }
    void fsPort
      .onFsChange((e) => {
        if (isStale() || !detectFormat(e.path)) return
        reload()
      })
      .then((off) => {
        // The switch may have been superseded while the subscription was being
        // established: keep listening to nothing rather than to a stale vault.
        if (isStale()) off()
        else refsUnwatch = off
      })
      .catch(() => {
        // No fs events: the library is simply as fresh as the vault open, which
        // is the behaviour before this subscription existed.
      })
  }

  function onOpenFolder(path: string): void {
    // The chosen vault is recorded (localStorage) only inside applyVault, on a
    // successful commit — so a failed open never persists a bad path.
    void applyVault(path)
  }

  async function pickFolder(): Promise<void> {
    const picked = await dialogs.openFolderDialog()
    if (picked) onOpenFolder(picked)
  }

  function start(): void {
    if (started) return
    started = true
    // Subscribe BEFORE the pending request is collected, so a file that arrives
    // while startup is still running is neither missed by a window that is not
    // listening yet nor collected twice: whichever trigger gets there first
    // takes the request, and the slot is empty for the other.
    openFiles.subscribe()
    // Restore window geometry before the vault is opened so the layout is in
    // place while the editor initializes.
    void windowTracking.restore()
    // stronghold init/key-file errors are surfaced by the settings panel; a
    // failed background load on startup should not reject the mount
    void settings.loadKey().catch(() => {})
    void runStartup()
  }

  async function runStartup(): Promise<void> {
    try {
      // Through the persistence port: a webview with storage disabled throws on
      // the GETTER here, and an unguarded read meant startup failed before the
      // first render (no vault, no session, white screen).
      const saved = persistence.get(VAULT_LS_KEY)
      // Apply the persisted vault BEFORE restoring the session. The switch is
      // awaited (not fire-and-forget) so restoreSession sees the correct vault and
      // the previous tab set is closed first — it can never restore into the wrong
      // vault or race `closeAll`. A bad/blank path is handled inside applyVault, so
      // a stale saved vault cannot hang startup.
      if (saved) await applyVault(saved)
      // Reopen the tabs that were open at the last capture (no-op when there is no
      // matching session). Runs after the vault is applied so restoreSession sees
      // the correct vault and its duplicate guard can focus existing tabs.
      await tabs.restoreSession()
      // LAST, and deliberately so: the file the OS launched us with is the one
      // thing here that came from outside the app, and a request the backend
      // marked `same_vault` is only true once the vault it is speaking of is
      // actually applied — which is what the two lines above just did. A file
      // from another folder moves the vault through `applyVault`, closing the
      // restored tabs, which is the right outcome: the user asked for that file,
      // not for yesterday's session.
      await openFiles.drain()
    } catch (e) {
      // An unexpected startup error must not hang (or reject) the mount: applyVault
      // already swallows path-confined failures, so surface anything else and let
      // the app continue to window tracking rather than dying silently.
      console.error('[NekoWite] startup sequence failed', e)
    } finally {
      void windowTracking.start()
    }
  }

  function dispose(): void {
    // Mark the runtime as torn down so every fire-and-forget completion point
    // (plugin/ref/index/tmp-recovery) bails instead of re-launching or writing.
    disposed = true
    // Release the launch listener too: a request that arrives after teardown
    // must not start a vault switch in a runtime that is going away.
    openFiles.dispose()
    // Cancel any in-flight vault switch so a superseded switch can never touch
    // state after teardown (its controller is aborted; all completion points bail).
    vaultSwitchController?.abort()
    vaultSwitchController = null
    tmpRecovery?.cancel()
    tmpRecovery = null
    // Stop watching the vault for reference-file changes (and drop a pending
    // debounced reload so teardown cannot re-read a vault the app has left).
    refsUnwatch?.()
    refsUnwatch = null
    if (refsReloadTimer) {
      clearTimeout(refsReloadTimer)
      refsReloadTimer = null
    }
    // Detach the vault index coordinator: clears the fs watcher subscription,
    // cancels in-flight index tasks, and drops the persistent index mirror.
    vaultSession.detachVault()
    vaultSession.cancelSearchIndexBuild()
    // Deactivate every active vault plugin (components, commands, lifecycle hooks).
    deactivateVaultPlugins()
    // Drop vault-scoped refs state so no stale reference list survives.
    refs.clear()
    // Release the current editor session (plugin-host active editor + bridge) and
    // destroy every live editor session. Idempotent on the manager (an empty map is
    // a no-op, so a controller that already destroyed its own session is not
    // double-destroyed).
    setActiveEditor(null)
    editorBridge.setEditor(null)
    editorSessionManager.destroyAll()
    // Release window tracking listeners. Idempotent.
    windowTracking.dispose()
  }

  return {
    vaultPath,
    windowTracking,
    applyVault,
    onOpenFolder,
    pickFolder,
    start,
    dispose,
  }
}
