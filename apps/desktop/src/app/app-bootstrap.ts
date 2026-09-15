import { ref, type Ref } from 'vue'
import { useTabsStore } from '../stores/tabs'
import { useSettingsStore } from '../stores/settings'
import { useVaultSessionStore } from '../stores/vault-session'
import { useRefsStore } from '../stores/refs'
import { getSharedGateways } from '../platform/runtime/gateway-runtime'
import { deactivateVaultPlugins } from '../services/plugins'
import { notifyError } from '../services/errors'
import { persistence } from '../services/persistence'
import { setupWindowTracking, type WindowTracking } from './window-state'
import { createOpenFileHandler } from './open-file'
import { createVaultBackground } from './vault-background'
import { createVaultSwitch, VAULT_LS_KEY, type VaultSwitchOptions } from './vault-switch'
import { onOpenFileRequest, takePendingOpen } from '../platform/open-request'
import { setActiveEditor } from '@nekowite/plugin-host'
import { editorBridge } from '../services/editor-bridge'
import { setCiteKeyResolver } from '@nekowite/editor-core'
import { editorSessionManager } from '../features/editor'

export interface DesktopRuntime {
  /** The currently-open vault root (null before the first folder is picked). */
  vaultPath: Ref<string | null>
  /** Window size/position persistence, shared with the lifecycle module. */
  windowTracking: WindowTracking
  /** Switch the app to a new vault: reconcile the tabs whose first read has not
   *  landed (their typing moves to a tab of its own), flush the dirty tabs, and
   *  authorize the root with the backend before any path-confined command.
   *  Registration failure (missing/permission) does not switch; the switch stays
   *  on the current vault. `remember: false` serves the root without making it
   *  the vault the next launch opens on — for a root a launch adopted around a
   *  file the OS handed it. */
  applyVault(path: string, options?: VaultSwitchOptions): Promise<void>
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
 *
 * What a vault SWITCH does lives in `vault-switch.ts` and what a vault keeps
 * running lives in `vault-background.ts`; this file decides who gets which
 * collaborators and in what order. Splitting the switch out is what puts this
 * file back under §13.1's 300-line planning line — it was 436 → 486 across the
 * changeset that added the launch path, carrying window geometry, vault
 * switching, index/plugin/refs wiring and the recovery GC in one scope.
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
  let disposed = false

  const background = createVaultBackground({
    fs: fsPort,
    tabs,
    refs,
    vaultSession,
    currentVault: () => vaultPath.value,
    isDisposed: () => disposed,
  })
  const vaultSwitch = createVaultSwitch({
    tabs,
    fs: fsPort,
    vaultPath,
    isDisposed: () => disposed,
    background,
  })

  // The file the OS asked us to open (`nekowite notes.md`, a double-clicked
  // `.md`). It rides on the vault switch above rather than beside it — see
  // `open-file.ts`.
  const openFiles = createOpenFileHandler({
    vaultPath,
    applyVault: vaultSwitch.apply,
    openTab: (path) => tabs.openTab(path),
    notifyError,
    takePendingOpen,
    onOpenFileRequest,
  })
  let started = false

  function applyVault(path: string, options?: VaultSwitchOptions): Promise<void> {
    return vaultSwitch.apply(path, options)
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
    // takes the request, and the slot is empty for the other. The doorbell it
    // rings waits for `markReady` below, so the second trigger cannot act
    // before the first one has finished — see `open-file.ts`.
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
      // The baseline is in place — or startup failed, which is also an answer.
      // A doorbell that rang while the sequence was running has been parked on
      // this since `start()`, and only now may it act: a second `applyVault`
      // racing the one above is what silently dropped the restored session.
      openFiles.markReady()
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
    // Abort any in-flight switch and stop the vault-scoped work (index, plugins,
    // `.tmp` recovery, reference watching).
    vaultSwitch.teardown()
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
