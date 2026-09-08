import { createPluginError } from './types'

/**
 * Bounded wait for a promise so a slow/hung plugin never stalls the host.
 *
 * Real isolation (a worker/process that can be killed) is out of scope; the
 * best we can do on the current in-window host is to STOP WAITING for a plugin's
 * pending work and surface a structured error. Once the budget elapses we:
 *   - reject with PLUGIN_HOOK_TIMEOUT (or PLUGIN_ABORTED if the signal fired),
 *   - detach from the underlying promise so the host is never blocked,
 *   - still release the timer and listener on every path so nothing leaks.
 * The caller decides what "marking the plugin failed" means (usually rollback +
 * deactivate). A *synchronous* hook that spins the event loop cannot be
 * pre-empted here — only a background/async (thenable) hook can be timed out.
 *
 * This is a mechanism, not a sandbox: it bounds one promise, it does not isolate
 * a plugin's memory, globals, or synchronous CPU.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  opts?: { signal?: AbortSignal },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const signal = opts?.signal
    const onAbort = (): void => {
      reject(
        createPluginError('PLUGIN_ABORTED', {
          pluginId: '',
          message: 'Plugin activation was cancelled.',
          recovery: 'Retry activation, or disable the plugin.',
        }),
      )
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      reject(
        createPluginError('PLUGIN_HOOK_TIMEOUT', {
          pluginId: '',
          message: 'A lifecycle hook of the plugin exceeded its time budget and was cancelled.',
          recovery: 'Disable the plugin or check its logs.',
        }),
      )
    }, ms)
    // Detach from the original promise: once we time out or abort, the plugin's
    // eventual resolution/rejection is ignored and must not surface as an
    // unhandled rejection.
    promise.then(
      (value) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}
