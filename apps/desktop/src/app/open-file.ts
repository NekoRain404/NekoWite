/**
 * Opening the file the OS handed the app.
 *
 * The backend has already decided which vault the file belongs to and has
 * vouched for it (`open_file.rs`); this module carries that decision out, and
 * the only ruling left to it is the one the backend cannot make: what happens to
 * the vault the user is currently in.
 *
 * Two cases, and they are not written twice. A file already inside the current
 * vault opens a tab and nothing else moves. A file outside it moves the vault —
 * through the SAME switch every other vault change uses (`applyVault` in
 * `app-bootstrap`), which is what flushes the outgoing vault's dirty tabs first,
 * cancels the old index and watchers, and arms the new ones. A second switch
 * implementation beside that one is the bug this module exists to avoid; the
 * cost of reusing it is one comparison, below.
 *
 * The one refusal this module produces is a refusal it was handed: when the
 * switch cannot complete because a dirty tab will not save, `applyVault` has
 * already said so in the user's words and the file does not open — because
 * opening it now would open it under the vault we are still on, where its path
 * is outside the root. There is no second message here for that; inventing one
 * would only say the same thing twice.
 */

import type { Ref } from 'vue'
import type { OpenFileRequest } from '../platform/open-request'

export interface OpenFileDeps {
  /** The vault the app has open right now, as the runtime records it. */
  vaultPath: Ref<string | null>
  /** Commit to a vault root: flushes dirty tabs, registers the root, disposes the
   *  old vault's resources. Leaves `vaultPath` untouched when it does not commit. */
  applyVault(path: string): Promise<void>
  /** Open a document by absolute path, in the current vault. */
  openTab(path: string): Promise<void>
  /** Show a message the user must read. */
  notifyError(message: string): void
  /** Take the request the backend is holding, if any. */
  takePendingOpen(): Promise<OpenFileRequest | null>
  /** Subscribe to "the backend has a request waiting". Resolves to the
   *  unsubscribe. */
  onOpenFileRequest(cb: () => void): Promise<() => void>
}

export interface OpenFileHandler {
  /** Carry out one request. Resolves true when the file is open (or was already
   *  the file the tab showed); false when nothing was opened, with the reason
   *  already on screen. */
  handle(request: OpenFileRequest): Promise<boolean>
  /** Collect and carry out whatever the backend is holding. Resolves true when a
   *  file was opened. */
  drain(): Promise<boolean>
  /** Listen for a second launch, for the life of the app. */
  subscribe(): void
  /** Release the listener. Idempotent. */
  dispose(): void
}

export function createOpenFileHandler(deps: OpenFileDeps): OpenFileHandler {
  let unwatch: (() => void) | null = null
  /**
   * Bumped by every subscribe and every dispose. The registration settles after
   * an await, and a teardown can overtake it; the registration that lands then
   * belongs to a cycle that is over, and only the continuation holding it can
   * release it (the shape `app-lifecycle` uses for its close listener).
   */
  let subscriptionSeq = 0
  let disposed = false

  async function handle(request: OpenFileRequest): Promise<boolean> {
    if (request.kind === 'refused') {
      // The backend is the only party that can explain this one — it is the
      // party that looked at the path and refused to vouch for it.
      deps.notifyError(request.message)
      return false
    }
    // `same_vault` is the backend's answer, and it is about the session it can
    // see. The guard beside it is about the session the WINDOW is in: startup
    // restores the remembered vault, and a request that lands before that has
    // happened would otherwise be opened into no vault at all.
    if (!request.same_vault || !deps.vaultPath.value) {
      await deps.applyVault(request.root)
      // `applyVault` assigns exactly the string it was given, and only on commit
      // (its refusal paths return before that line), so this IS the question
      // "did the switch happen?" — no spelling or symlink can make two different
      // answers look equal. A switch that did not commit has already reported
      // why, and opening the file under the outgoing vault would fail there
      // anyway, with a message about a path outside the vault instead.
      if (deps.vaultPath.value !== request.root) return false
    }
    await deps.openTab(request.path)
    return true
  }

  async function drain(): Promise<boolean> {
    const request = await deps.takePendingOpen()
    // Nothing waiting is the ordinary launch, and a teardown in progress must
    // not start opening a file into a session that is going away.
    if (!request || disposed) return false
    return handle(request)
  }

  function subscribe(): void {
    subscriptionSeq += 1
    const registration = subscriptionSeq
    void deps
      .onOpenFileRequest(() => {
        // The event carries no payload on purpose: the request it announces is
        // collected here, so a nudge that arrives before the window is ready
        // costs nothing and a nudge that arrives twice cannot open a file twice.
        void drain()
      })
      .then((off) => {
        if (registration !== subscriptionSeq || disposed) off()
        else unwatch = off
      })
  }

  function dispose(): void {
    disposed = true
    // Any subscription still in flight is now superseded and will release
    // itself when it lands.
    subscriptionSeq += 1
    unwatch?.()
    unwatch = null
  }

  return { handle, drain, subscribe, dispose }
}
