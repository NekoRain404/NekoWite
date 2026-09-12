import { ref, type Ref } from 'vue'
import { useTabsStore } from '../stores/tabs'
import { useSettingsStore } from '../stores/settings'
import { useVaultSessionStore } from '../stores/vaultSession'
import { useRefsStore } from '../stores/refs'
import { getSharedGateways } from '../platform/runtime/gatewayRuntime'
import { loadVaultPlugins, deactivateVaultPlugins } from '../services/plugins'
import { notifyError, notifyRecovery } from '../services/errors'
import { t } from '../i18n'
import { setupWindowTracking, type WindowTracking } from './windowState'
import { createTmpRecovery, requestUntitledVaultSwitch } from './recoveryClosedLoop'
import { setActiveEditor } from '@nekowite/plugin-host'
import { editorBridge } from '../services/editorBridge'
import { invalidateImageResolution } from '@nekowite/editor-core'
import { editorSessionManager } from '../features/editor/sessionManager'

const VAULT_LS_KEY = 'nekowite.vault'

export interface DesktopRuntime {
  /** The currently-open vault root (null before the first folder is picked). */
  vaultPath: Ref<string | null>
  /** Window size/position persistence, shared with the lifecycle module. */
  windowTracking: WindowTracking
  /** Switch the app to a new vault, flushing dirty tabs and authorizing the
   *  root with the backend before any path-confined command. Registration failure
   *  (missing/permission) does not switch; the switch stays on the current vault. */
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

  function makeTmpRecovery() {
    return createTmpRecovery({
      fs: fsPort,
      getReferencedTmp: () => tabs.referencedTmpPaths(),
      notify: notifyRecovery,
    })
  }
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
    // A fresh folder pick is already auto-authorized by open_folder_dialog, but the
    // localStorage-restore path needs this explicit call. Must run before indexVault.
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
    localStorage.setItem(VAULT_LS_KEY, path)
    // Open tabs keep absolute paths from the previous vault — leaving them open
    // would route every save to "path escapes vault" errors. Start fresh.
    tabs.closeAll()
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
    const recovery = makeTmpRecovery()
    tmpRecovery = recovery
    void (async () => {
      void recovery.gc(path)
      void recovery.scan(path)
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
    void refs.loadVault(path, { signal }).catch(() => {
      // A stale vault path (deleted/renamed folder) must not crash startup;
      // the tree shows the failure and the user can pick another folder.
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
      const saved = localStorage.getItem(VAULT_LS_KEY)
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
    // Cancel any in-flight vault switch so a superseded switch can never touch
    // state after teardown (its controller is aborted; all completion points bail).
    vaultSwitchController?.abort()
    vaultSwitchController = null
    tmpRecovery?.cancel()
    tmpRecovery = null
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
