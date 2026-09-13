/**
 * Keep `@milkdown/ctx`'s leaked timer callback from failing the run.
 *
 * `Timer.start()` schedules `setTimeout(this.type.timeout)` (3000 ms by default)
 * and never keeps the handle, so the callback CANNOT be cancelled; when it fires
 * it calls the global `removeEventListener` unconditionally, even for a timer
 * that already resolved. Every editor a test creates therefore leaves a callback
 * that runs ~3 s later. If that lands after vitest has torn the happy-dom
 * environment down, the global no longer exists and vitest records
 *
 *     ReferenceError: removeEventListener is not defined
 *
 * as an uncaught error. That fails the editor-core suite (observed 0, 2, 8 and
 * 10 errors across runs of the same commit), and because `pnpm -r test` stops at
 * the first failing package, it also stops plugin-host and desktop from running
 * at all.
 *
 * The editor is not at fault — `NekoEditor.destroy()` does destroy the Milkdown
 * editor, and the library's own timer is simply uncancellable. The app never
 * sees this because its globals outlive every editor.
 *
 * So this wraps the timer callback instead of the global: the wrapper lives in
 * the timer queue rather than in a global that teardown removes, and it
 * re-throws anything that is not that one known error, so a genuine failure
 * inside a timer is still reported.
 */
const originalSetTimeout = globalThis.setTimeout.bind(globalThis)

const isLeakedMilkdownTimerError = (err: unknown): boolean =>
  err instanceof ReferenceError && err.message.includes('removeEventListener')

globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
  if (typeof handler !== 'function') {
    return originalSetTimeout(handler, timeout)
  }
  const wrapped = (...callArgs: unknown[]): void => {
    try {
      ;(handler as (...a: unknown[]) => void)(...callArgs)
    } catch (err) {
      if (isLeakedMilkdownTimerError(err)) return
      throw err
    }
  }
  return originalSetTimeout(wrapped, timeout, ...args)
}) as typeof globalThis.setTimeout
