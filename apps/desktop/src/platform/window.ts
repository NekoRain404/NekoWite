/**
 * Window-control adapter.
 *
 * The ONLY module (besides `platform/**`, `app/`) that touches the Tauri window
 * API. UI code calls these narrow controls instead of importing
 * `@tauri-apps/api/window` directly, so the business/feature layers stay free
 * of the Tauri bridge (docs/dev.md §5.3). In a plain browser these calls are
 * never made (callers guard on `__TAURI_INTERNALS__`), but the module still
 * resolves at build time so the demo bundle includes them lazily.
 */

import { getCurrentWindow } from '@tauri-apps/api/window'

export interface WindowControls {
  isMaximized(): Promise<boolean>
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  onResized(cb: () => void): Promise<() => void>
}

export function getWindowControls(): WindowControls {
  const win = getCurrentWindow()
  return {
    isMaximized: () => win.isMaximized(),
    minimize: () => win.minimize(),
    toggleMaximize: () => win.toggleMaximize(),
    close: () => win.close(),
    onResized: (cb) => win.onResized(cb),
  }
}
