/**
 * What a vault keeps running while it is open.
 *
 * The second half of a vault switch. `vault-switch.ts` owns the first — flush
 * the outgoing vault's unsaved work, register the root, commit — and this
 * module owns everything the committed vault needs from that moment: its index,
 * its plugins, its `.tmp` crash-litter pass and its reference library. The two
 * halves are split because they fail differently: the first can refuse and
 * leave the app where it was, and this one never can. Nothing here decides
 * anything; it is all fire-and-forget work that the switch's `isStale` guards,
 * so a superseded switch's late completion can never write into the vault that
 * replaced it.
 *
 * One vault at a time, and `arm` is what says so: it disposes the outgoing
 * vault's resources before starting the incoming vault's, which is why a stale
 * `arm` arriving late cannot resurrect anything.
 */

import type { FsGateway } from '../platform/gateways/contracts'
// The three stores are imported for their TYPES (`ReturnType<typeof useTabsStore>`
// is the store's own instance type, so a dependency written here cannot drift
// from the store). The composition root calls them and passes the instances in.
import { useRefsStore } from '../stores/refs'
import { useTabsStore } from '../stores/tabs'
import { useVaultSessionStore } from '../stores/vault-session'
import { refreshCiteChips } from '@nekowite/editor-core'
import { notifyRecovery } from '../services/errors'
import { deactivateVaultPlugins, loadVaultPlugins } from '../services/plugins'
import { detectFormat } from '../services/refs'
import { scanTmpReferences } from '../services/tmp-references'
import { vaultFileIndex } from '../services/vault-files'
import { createTmpRecovery } from './recovery-closed-loop'

/** What the switch hands over for one committed vault. */
export interface VaultArmContext {
  /** Aborted when a newer switch supersedes this one, so a subscription or a
   *  reference load can be released rather than left running. */
  signal: AbortSignal
  /** True once this arm's switch has been superseded, or the runtime is gone. */
  isStale: () => boolean
}

export interface VaultBackgroundDeps {
  /** `FsGateway` and not `FsPort`: this module listens for fs-change events,
   *  and the listener lives on the legacy combined shape the composition root
   *  passes (`AppGateways.fs` = fs ops + dialogs + `onFsChange`). */
  fs: FsGateway
  tabs: ReturnType<typeof useTabsStore>
  refs: ReturnType<typeof useRefsStore>
  vaultSession: ReturnType<typeof useVaultSessionStore>
  /** The vault the runtime has open RIGHT NOW — read live, because the one
   *  question below is asked after an await, when it may have moved on. */
  currentVault: () => string | null
  /** True once the runtime is torn down, so teardown sticks. */
  isDisposed: () => boolean
}

export interface VaultBackground {
  /** Give the committed vault its long-running work, and stop the outgoing
   *  vault's. Called once per committed switch. */
  arm(vault: string, ctx: VaultArmContext): void
  /** Release everything this module owns. Idempotent, and safe before any arm. */
  stop(): void
}

export function createVaultBackground(deps: VaultBackgroundDeps): VaultBackground {
  const { fs, tabs, refs, vaultSession, currentVault, isDisposed } = deps
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
        read: (v, p) => fs.read(v, p),
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

  function makeTmpRecovery(vault: string, isStale: () => boolean) {
    return createTmpRecovery({
      fs,
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
    void fs
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

  function arm(vault: string, ctx: VaultArmContext): void {
    const { signal, isStale } = ctx
    // Dispose the previous vault's resources now that the new vault is
    // committed: its active plugin instances/hooks, its index coordinator
    // (which detaches the fs watcher subscription and cancels in-flight index +
    // search-index tasks), and its `.tmp` recovery controller (cancelled before
    // a fresh one is armed so a stale scan can never write results into the new
    // vault).
    deactivateVaultPlugins()
    vaultSession.detachVault()
    tmpRecovery?.cancel()
    tmpRecovery = null

    // Crash-litter reconciliation (recovery closed-loop). GC first (sweeps only
    // old, confirmed-orphaned `.tmp` files), then scan surfaces a "recoverable
    // versions" notice for the fresh orphans left by an interrupted session.
    // Fire-and-forget (never blocks vault open) and cancellable.
    const recovery = makeTmpRecovery(vault, isStale)
    tmpRecovery = recovery
    void (async () => {
      // Reclaim first, THEN look for what is left. Running them concurrently (as
      // this did) meant scan listed the directory before gc deleted from it, so
      // the prompt advertised files that were already gone by the time it
      // appeared: the user clicked "restore" on an entry whose rename failed
      // silently, and nothing happened at all.
      await recovery.gc(vault)
      if (isStale()) return
      await recovery.scan(vault)
    })()
    // Index the new vault: `indexVault` is internally latest-wins (the new
    // coordinator detaches the stale one before subscribing). Plugins and refs
    // are fire-and-forget and guarded below so a superseded switch's late
    // result can never land in the newer vault.
    void vaultSession.indexVault(vault)
    void loadVaultPlugins(vault).then(() => {
      // A superseded vault's plugin load can settle after a newer switch claimed
      // the vault. Fully discard the stale plugin set, then re-run for the
      // current vault so its plugins stay active — an old vault never leaves its
      // components/commands/hooks registered in the new one.
      if (isStale()) {
        deactivateVaultPlugins()
        // After dispose we must never re-launch plugins — teardown sticks.
        if (!isDisposed()) {
          const current = currentVault()
          if (current) void loadVaultPlugins(current)
        }
      }
    })
    watchRefs(vault, signal, isStale)
    void refs
      .loadVault(vault, { signal })
      .then(() => refreshCiteChips())
      .catch(() => {
        // A stale vault path (deleted/renamed folder) must not crash startup;
        // the tree shows the failure and the user can pick another folder.
      })
  }

  function stop(): void {
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
  }

  return { arm, stop }
}
