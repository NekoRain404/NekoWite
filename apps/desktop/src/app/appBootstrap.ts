import { ref, type Ref } from 'vue'
import { useTabsStore } from '../stores/tabs'
import { useSettingsStore } from '../stores/settings'
import { useVaultSessionStore } from '../stores/vaultSession'
import { useRefsStore } from '../stores/refs'
import { getSharedGateways } from '../platform/runtime/gatewayRuntime'
import { loadVaultPlugins } from '../services/plugins'
import { notifyError, notifyRecovery } from '../services/errors'
import { t } from '../i18n'
import { setupWindowTracking, type WindowTracking } from './windowState'
import { createTmpRecovery, requestUntitledVaultSwitch } from './recoveryClosedLoop'

const VAULT_LS_KEY = 'nekowite.vault'

export interface DesktopRuntime {
  /** The currently-open vault root (null before the first folder is picked). */
  vaultPath: Ref<string | null>
  /** Window size/position persistence, shared with the lifecycle module. */
  windowTracking: WindowTracking
  /** Switch the app to a new vault, flushing dirty tabs and authorizing the
   *  root with the backend before any path-confined command. */
  applyVault(path: string): Promise<void>
  /** Record the chosen vault and switch to it. Used by the sidebar and the
   *  settings "vault saved" flow. */
  onOpenFolder(path: string): void
  /** Open the native folder picker and switch to the chosen vault. */
  pickFolder(): Promise<void>
  /** Run the startup sequence once: restore window geometry, load the vault
   *  session, apply the persisted vault, reopen tabs, start window tracking. */
  start(): void
  /** Release the window tracking listeners. Also invoked by lifecycle teardown. */
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

  async function applyVault(path: string): Promise<void> {
    // A vault switch must not silently drop unsaved edits from the vault we are
    // leaving. Flush the current dirty tabs first; if one fails to save, block
    // the switch so the work is lost to a pending autosave timer that will
    // never fire on the new vault.
    const flushed = await tabs.flushDirty()
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
      if (choice === 'save') {
        for (const tab of untitled) {
          const saved = await tabs.saveTab(tab.id)
          if (!saved) {
            notifyError(t('tabs.unsavedWorkBlocker'))
            return
          }
        }
      } else {
        for (const tab of untitled) tabs.removeTab(tab.id)
      }
    }
    // Authorize the vault root with the backend BEFORE any path-confined command:
    // the Rust commands now reject any root the user did not open this session.
    // A fresh folder pick is already auto-authorized by open_folder_dialog, but the
    // localStorage-restore path needs this explicit call. Must run before indexVault.
    // Cancel a prior vault's in-flight scan/GC so its results can never leak here,
    // then arm a fresh controller for the new vault.
    tmpRecovery?.cancel()
    await fsPort.registerVault(path).catch(() => {
      // Registration failure (e.g. stale path) must not crash startup; the tree
      // surfaces the bad vault and the user can pick another folder.
    })
    vaultPath.value = path
    // Open tabs keep absolute paths from the previous vault — leaving them open
    // would route every save to "path escapes vault" errors. Start fresh.
    tabs.closeAll()
    tabs.setVault(path)
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
    void vaultSession.indexVault(path)
    void loadVaultPlugins(path)
    void refs.loadVault(path).catch(() => {
      // A stale vault path (deleted/renamed folder) must not crash startup;
      // the tree shows the failure and the user can pick another folder.
    })
  }

  function onOpenFolder(path: string): void {
    localStorage.setItem(VAULT_LS_KEY, path)
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
    const saved = localStorage.getItem(VAULT_LS_KEY)
    if (saved) void applyVault(saved)
    // Reopen the tabs that were open at the last capture (no-op when there is no
    // matching session). Runs after the vault is applied so restoreSession sees
    // the correct vault and its duplicate guard can focus existing tabs.
    void tabs.restoreSession()
    void windowTracking.start()
  }

  function dispose(): void {
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
