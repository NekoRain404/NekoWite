import { useTabsStore } from '../stores/tabs'
import { useAppearanceStore } from '../stores/appearance'
import type { WindowTracking } from './windowState'
import { t } from '../i18n'

export interface AppLifecycleHandle {
  /** Register OS-theme, window-blur and before-unload listeners. */
  mount(): void
  /** Flush session/window state and detach every listener. Idempotent. */
  unmount(): void
}

/**
 * App-level window lifecycle: system-theme tracking, autosave-on-blur, and the
 * before-unload / close save. The load path lives in appBootstrap; this module
 * is only about the browser/window listeners and the closure save that must
 * never drop unsaved work.
 *
 * `beforeClose` (the `beforeunload` handler) is idempotent and only prompts
 * when there is actually unsaved work. A failed background flush never blocks
 * the close in a way that silently discards newer edits — the crash-recovery
 * history path still preserves the last autosaved snapshot on reopen.
 */
export function createAppLifecycle(deps: { windowTracking: WindowTracking }): AppLifecycleHandle {
  const tabs = useTabsStore()
  const appearance = useAppearanceStore()
  let unlistenMedia: (() => void) | null = null
  let blurSaving = false
  let mounted = false

  // Save on window blur when enabled, but only for tabs with unsaved work so a
  // mere focus change never produces a no-op write or a spurious history entry.
  function onWindowBlur(): void {
    if (!appearance.autosaveOnBlur) return
    const tab = tabs.activeTab
    if (!tab?.dirty || blurSaving) return
    blurSaving = true
    void tabs.saveActive().finally(() => {
      blurSaving = false
    })
  }

  // With autosave on, a dirty tab's pending timer may never fire if the window
  // is closed first. Rather than silently losing those edits, prompt the user
  // (the webview surfaces the native "leave?" confirm); the crash-recovery
  // history path still preserves the last autosaved snapshot on reopen.
  function onBeforeUnload(e?: BeforeUnloadEvent): void {
    if (tabs.hasUnsavedWork()) {
      e?.preventDefault()
      if (e) e.returnValue = t('tabs.unsavedWorkPrompt')
    }
    tabs.captureSession()
    deps.windowTracking.flush()
  }

  function mount(): void {
    if (mounted) return
    mounted = true
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
  }

  function unmount(): void {
    // Flush once even if mount() never ran, so a hot teardown of an unstubbed
    // shell still captures the session and window geometry.
    onBeforeUnload()
    unlistenMedia?.()
    unlistenMedia = null
    window.removeEventListener('blur', onWindowBlur)
    window.removeEventListener('beforeunload', onBeforeUnload)
    deps.windowTracking.dispose()
    mounted = false
  }

  return { mount, unmount }
}
