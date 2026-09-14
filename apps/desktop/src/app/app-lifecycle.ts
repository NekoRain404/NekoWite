import { getCurrentWindow, type CloseRequestedEvent } from '@tauri-apps/api/window'
import { useTabsStore } from '../stores/tabs'
import { useAppearanceStore } from '../stores/appearance'
import type { WindowTracking } from './window-state'
import { notifyError, notifyRecovery } from '../services/errors'
import { requestUntitledVaultSwitch } from './recovery-closed-loop'
import { t } from '../i18n'

export interface AppLifecycleHandle {
  /** Register OS-theme, window-blur, before-unload and (in Tauri) the native
   *  close-requested listener. */
  mount(): void
  /** Flush session/window state, dispose the runtime and detach every listener.
   *  Idempotent. This is the single app teardown entry point: it owns BOTH the
   *  runtime disposal (vault switch / recovery / index / plugins / editor session
   *  / window tracking) and this module's own listeners. */
  unmount(): void
}

function isTauriRuntime(): boolean {
  return typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'
}

/**
 * App-level window lifecycle: system-theme tracking, autosave-on-blur, and the
 * close-save that must never drop unsaved work. The load path lives in
 * appBootstrap; this module is only about the browser/window listeners and the
 * closure save.
 *
 * Close is handled two ways:
 *   - In the packaged Tauri app, the window `close-requested` listener runs the
 *     real save: when dirty tabs exist it PREVENTS the close, `flushDirty()`s
 *     them (and routes unnamed dirty tabs through the existing save-as prompt
 *     path), and only then closes. If a save fails the window stays open so the
 *     work is not lost — and when it failed because the file refuses the write,
 *     the user is offered the one route out that does not need that file (a copy
 *     under another name, `rescueUnflushableTabs`), because "some files could
 *     not be saved" on its own leaves them with an X that never works.
 *   - In the browser Demo (no Tauri runtime, no `close-requested`), the
 *     `beforeunload` fallback just prompts, because an async flush cannot be
 *     reliably awaited during an unload.
 *
 * `onBeforeUnload` stays idempotent and always captures the session + window
 * geometry so a hot teardown still persists layout. `onCloseRequested` is
 * re-entrancy-guarded (`closing`) so the `win.close()` it issues to finish the
 * native close is allowed through a second time.
 */
export function createAppLifecycle(deps: {
  windowTracking: WindowTracking
  /** Called from `unmount()` to tear down the application runtime (vault switch /
   *  recovery / index / plugins / editor session / window tracking). Wired by the
   *  composition root (`App.vue`) so the runtime and lifecyle cleanup paths meet. */
  disposeRuntime?: () => void
}): AppLifecycleHandle {
  const tabs = useTabsStore()
  const appearance = useAppearanceStore()
  let unlistenMedia: (() => void) | null = null
  let unlistenCloseRequested: (() => void) | null = null
  /**
   * Bumped by every mount and every unmount. `onCloseRequested` resolves after
   * an await, and a teardown — or a later mount — can overtake it; the
   * registration that lands then belongs to a cycle that is over, and only the
   * continuation holding it can release it (unmount() sees whatever the
   * variable holds, which is nothing or a newer one).
   */
  let closeRegistrationSeq = 0
  let blurSaving = false
  let closing = false
  let mounted = false

  // Save on window blur when enabled, but only for tabs with unsaved work so a
  // mere focus change never produces a no-op write or a spurious history entry.
  function onWindowBlur(): void {
    if (!appearance.autosaveOnBlur) return
    const tab = tabs.activeTab
    if (!tab?.dirty || blurSaving) return
    blurSaving = true
    // `saveTab` rather than `saveActive`: losing focus is not the user asking
    // for anything, and a save that answers a refusal with a file dialog would
    // throw a picker into whatever window they just switched to.
    void tabs.saveTab(tab.id).finally(() => {
      blurSaving = false
    })
  }

  /** The user's answer to the close-blocked question below. */
  function requestSaveCopies(count: number): Promise<boolean> {
    return new Promise((resolve) => {
      notifyRecovery({
        message: t('tabs.unsavedWorkRescue', { count }),
        onRestore: () => resolve(true),
        onDismiss: () => resolve(false),
      })
    })
  }

  /**
   * The way out of a close that a refused save would otherwise block forever.
   *
   * `flushDirty()` cannot put every dirty tab on disk when one of them is
   * read-only: the backend refuses that write deliberately, and no retry of it
   * can ever land. The window then will not close — correctly, since the text is
   * unsaved — but a user who typed into a protected note (a note restored from
   * the trash carries the bit, so they need never have set it) had no move left
   * at all: Ctrl+S refused, the X refused, and the only ways out were to lose
   * the edits or to leave the app and `chmod` the file. Offer the one route that
   * needs neither the protected file nor a retry, and let the close go ahead
   * once the text is somewhere the user chose.
   */
  async function rescueUnflushableTabs(): Promise<boolean> {
    const stuck = tabs.tabs.filter((tab) => tab.dirty && tab.path)
    if (stuck.length === 0) return false
    if (!(await requestSaveCopies(stuck.length))) return false
    for (const tab of stuck) {
      // Resolves true only once that tab's text is on disk — under the copy's
      // name. A cancelled dialog, or a copy that was refused in turn, leaves
      // this false and the window open, with the text still in the editor.
      if (!(await tabs.saveTab(tab.id, { offerCopy: true }))) return false
    }
    return true
  }

  // With autosave on, a dirty tab's pending timer may never fire if the window
  // is closed first. Rather than silently losing those edits, prompt the user
  // (the webview surfaces the native "leave?" confirm); the crash-recovery
  // history path still preserves the last autosaved snapshot on reopen. Kept as
  // the browser-Demo fallback where an async flush cannot be awaited.
  function onBeforeUnload(e?: BeforeUnloadEvent): void {
    if (tabs.hasUnsavedWork()) {
      e?.preventDefault()
      if (e) e.returnValue = t('tabs.unsavedWorkPrompt')
    }
    tabs.captureSession()
    deps.windowTracking.flush()
  }

  // Native close (Tauri). `close-requested` CAN await an async save, so this is
  // where dirty work is really flushed — not merely prompted.
  async function onCloseRequested(e: CloseRequestedEvent): Promise<void> {
    // The `win.close()` we issue to finish a prevented close re-fires this event;
    // let that second request through without preventing it again.
    if (closing) return
    if (!tabs.hasUnsavedWork()) {
      // Nothing to save: capture session/geometry and allow the native close.
      tabs.captureSession()
      deps.windowTracking.flush()
      return
    }
    // There IS unsaved work: prevent the close and flush it first.
    e.preventDefault()
    closing = true
    try {
      const flushed = await tabs.flushDirty()
      if (!flushed && !(await rescueUnflushableTabs())) {
        // A path'd save failed, and the user did not (or could not) route the
        // text elsewhere — keep the window open so the work is not lost. The
        // wording is this path's own: the shared sentence describes a vault
        // switch, which is not what the user just tried to do.
        notifyError(t('tabs.unsavedWorkBlockerClose'))
        return
      }
      // Unnamed dirty docs need a Save-As dialog a background flush must not open,
      // so route them through the existing keep-or-discard prompt, saving each (or
      // discarding) before the window closes.
      const untitled = tabs.untitledDirtyTabs()
      if (untitled.length > 0) {
        const choice = await requestUntitledVaultSwitch({ count: untitled.length, notify: notifyRecovery })
        if (choice === 'save') {
          for (const tab of untitled) {
            const saved = await tabs.saveTab(tab.id)
            if (!saved) {
              notifyError(t('tabs.unsavedWorkBlockerClose'))
              return
            }
          }
        } else {
          for (const tab of untitled) tabs.removeTab(tab.id)
        }
      }
      // All work is on disk (or explicitly discarded): capture + flush, then close.
      tabs.captureSession()
      deps.windowTracking.flush()
      // With `closing` still true, the re-fired close-requested falls through and
      // allows the native close.
      await getCurrentWindow().close()
    } catch {
      // Never let an unexpected save/flush error swallow the user's X. Try the
      // native close; if even that fails, fall back to destroy so the process
      // cannot become unclosable. Data protection is still best-effort above.
      notifyError(t('tabs.unsavedWorkBlockerClose'))
      await getCurrentWindow().close().catch(async () => {
        await getCurrentWindow().destroy().catch(() => undefined)
      })
    } finally {
      closing = false
    }
  }

  function mount(): void {
    if (mounted) return
    mounted = true
    closeRegistrationSeq += 1
    const registration = closeRegistrationSeq
    if (typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const onChange = (): void => {
        appearance.touchSystem()
      }
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', onChange)
        unlistenMedia = (): void => mq.removeEventListener('change', onChange)
      }
    }
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('beforeunload', onBeforeUnload)
    if (isTauriRuntime()) {
      void (async () => {
        try {
          const win = getCurrentWindow()
          const off = await win.onCloseRequested(onCloseRequested)
          // The registration settles after an await: a teardown that already
          // ran must release it here, because nothing else holds its
          // unsubscriber (the `disposed` shape `useNoteGraph` uses).
          if (registration !== closeRegistrationSeq) {
            off()
            return
          }
          unlistenCloseRequested = off
        } catch {
          // A missing/broken Tauri bridge must not break the app; the browser
          // `beforeunload` confirm remains the fallback. Only clear what this
          // cycle owns — a newer one may have registered meanwhile.
          if (registration === closeRegistrationSeq) unlistenCloseRequested = null
        }
      })()
    }
  }

  function unmount(): void {
    // Flush once even if mount() never ran, so a hot teardown of an unstubbed
    // shell still captures the session and window geometry. This must run BEFORE
    // runtime disposal (which releases window tracking), so the freshest layout is
    // persisted.
    onBeforeUnload()
    // Dispose the runtime: cancel in-flight vault switches / recovery, detach the
    // index coordinator (unsubscribes the fs watcher), deactivate plugins, destroy
    // editor sessions and release window tracking. Idempotent.
    deps.disposeRuntime?.()
    unlistenMedia?.()
    unlistenMedia = null
    // Any close registration still in flight is now superseded, and will
    // release itself when it lands.
    closeRegistrationSeq += 1
    unlistenCloseRequested?.()
    unlistenCloseRequested = null
    window.removeEventListener('blur', onWindowBlur)
    window.removeEventListener('beforeunload', onBeforeUnload)
    deps.windowTracking.dispose()
    mounted = false
  }

  return { mount, unmount }
}
