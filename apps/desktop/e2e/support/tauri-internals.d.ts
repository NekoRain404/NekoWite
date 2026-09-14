/**
 * `window.__TAURI_INTERNALS__`, as the e2e stubs install it.
 *
 * Every spec replaces this object before the app boots so the browser build
 * sees a backend, but nothing declared it: `src/**` never touches the global
 * uncast (`window as { __TAURI_INTERNALS__?: unknown }` at each site), so the
 * specs' own assignments had no type to check against until `e2e/**` joined the
 * typecheck. Declaring the stub surface once, here, keeps twenty assignment
 * sites honest instead of casting at each of them.
 *
 * Members beyond `invoke` are optional because each spec installs only the
 * commands its document needs. `__TAURI_EVENT_PLUGIN_INTERNALS__` is declared
 * by `@tauri-apps/api/event`, which the app imports; only this one needs a home.
 */
declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke(cmd: string, args?: Record<string, unknown>): unknown
      transformCallback?(cb: unknown, once?: boolean): number
      unregisterCallback?(id: number): void
      convertFileSrc?(filePath: string): string
      [member: string]: unknown
    }
  }
}

export {}
