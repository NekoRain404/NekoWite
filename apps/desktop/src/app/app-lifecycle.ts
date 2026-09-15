import { getCurrentWindow, type CloseRequestedEvent } from '@tauri-apps/api/window'
import { useTabsStore } from '../stores/tabs'
import { useAppearanceStore } from '../stores/appearance'
import { createUnflushableRescue } from '../stores/unflushable-rescue'
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
 *     real save: when dirty tabs exist it PREVENTS the close, reconciles the
 *     tabs whose first read has not landed (their typing moves to a tab of its
 *     own, which the save-as prompt then covers — `reconcilePlaceholders` in
 *     `tab-close.ts`), `flushDirty()`s the rest (and routes unnamed dirty tabs
 *     through the existing save-as prompt path), and only then closes. If a save
 *     fails the window stays open so the work is not lost — and when it failed
 *     because the file refuses the write, the user is offered the one route out
 *     that does not need that file (a copy under another name,
 *     `stores/unflushable-rescue.ts` — the same route "Close all" takes),
 *     because "some files could not be saved" on its own leaves them with an X
 *     that never works.
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

  /**
   * The way out of a close that a refused save would otherwise block forever:
   * the copy route, one loop for both controls that need it
   * (`stores/unflushable-rescue.ts` — "Close all" asks the same question through
   * the store, and a second copy of the loop is how the two came to disagree).
   *
   * Wired to THIS store's own ports, and called at the same point it always was:
   * `reconcilePlaceholders` → `flushDirty` → this rescue → the untitled prompt.
   */
  const rescueUnflushableTabs = createUnflushableRescue({
    listTabs: () => tabs.tabs,
    t,
    notifyRecovery,
    saveTab: (id, opts) => tabs.saveTab(id, opts),
    saveUntilSettled: (id) => tabs.saveUntilSettled(id),
  })

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
      // A tab whose first read has not landed is a placeholder — an EMPTY
      // document wearing the note's path — and nothing can write it, so the
      // `flushDirty()` below answers false for it forever, and the copy prompt
      // below cannot deliver either (its save is refused for the same reason).
      // The X therefore did nothing, on every press: a user could not close the
      // application. What the user typed into that tab is not the note's text
      // and must not go to the note's file, so it moves to a tab of its own
      // first — the SAME step, in the same place (before the flush and before
      // the untitled prompt), that `closeAll` runs. One function, both routes.
      await tabs.reconcilePlaceholders()
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
      // discarding) before the window closes. The wording is the close-all one:
      // the default names a vault switch, which is not what this user is doing.
      const untitled = tabs.untitledDirtyTabs()
      if (untitled.length > 0) {
        const choice = await requestUntitledVaultSwitch({
          count: untitled.length,
          notify: notifyRecovery,
          messageKey: 'tabs.untitledCloseAllMsg',
        })
        if (choice === 'save') {
          for (const tab of untitled) {
            // The gate, not `saveTab`: an untitled tab is saved here by the
            // Save-As write, and that write's `true` says only that the text it
            // captured landed. This IS the close — the timer a keystroke armed
            // is cancelled by it — so nothing else can carry the newer text, and
            // a keystroke during the write would be destroyed rather than
            // deferred (see `tab-settle.ts`). The gate retries through
            // `saveTab(id)`, by which time the tab has the picked path, so the
            // dialog opens once.
            if (!(await tabs.saveUntilSettled(tab.id))) {
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
