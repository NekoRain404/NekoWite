import { recordPluginEvent } from './audit-log'

/* ------------------------------------------------------------------------- *
 * Containing a plugin callback's failure.
 *
 * A toolbar button or a registered command runs from a CLICK, which is after
 * the activation's try/catch has returned and outside `emitLifecycle`'s
 * isolation, so the wrapper that contains the failure is a concern of its own
 * rather than a clause of `activatePlugin`.
 *
 * The isolator is built once per activation (`createCallbackIsolator`) because
 * the record it keeps is what makes the notice once-per-callback: it belongs to
 * the run whose callbacks were wrapped, so a plugin re-activated later starts
 * with a clean slate. It is imported by `./runtime`, which is the entry point
 * `@nekowite/plugin-host` and direct importers have always used.
 *
 * The reporter arrives as a PARAMETER rather than an import, and that is about
 * the module graph rather than about testing: `reportPluginCallbackError` lives
 * in `./lifecycle`, which already imports `markPluginUnstable` from `./runtime`,
 * so importing it here would close `lifecycle -> runtime -> callback-isolation
 * -> lifecycle`. The moved body still calls it under the same name; only where
 * that name is obtained changed.
 * ------------------------------------------------------------------------- */

/** What a contained failure is handed to: `./lifecycle`'s
 *  `reportPluginCallbackError`. */
type PluginCallbackReporter = (
  pluginId: string,
  origin: `toolbar:${string}` | `command:${string}`,
  err: unknown,
) => void

/** The isolator one activation's callbacks are wrapped in: it takes the
 *  callback, its label and its origin, and answers the callback the host
 *  registers in its place. */
type CallbackIsolator = (
  label: string,
  origin: `toolbar:${string}` | `command:${string}`,
  run: () => void,
) => () => void

/**
 * Wrap a callback the plugin handed us so its failure cannot escape into the
 * host's UI. These run from a click (a toolbar button, a command in the
 * palette), OUTSIDE the activation try/catch and outside `emitLifecycle`'s
 * isolation, so before this a throwing plugin callback propagated out of the
 * DOM event handler: the app logged an unhandled error, the user got no
 * message and no plugin name, and the palette's own bookkeeping (a running
 * flag, a spinner) was left stuck.
 *
 * The notice is raised once per callback per session - a broken button that
 * is clicked repeatedly must not turn into a wall of identical toasts - while
 * every failure is still logged.
 *
 * `id` is the plugin every report is filed against: the callback does not carry
 * it, and the origin does not name the plugin.
 */
export function createCallbackIsolator(
  id: string,
  reportPluginCallbackError: PluginCallbackReporter,
): CallbackIsolator {
  const reportedCallbacks = new Set<string>()
  return function isolate(
    label: string,
    origin: `toolbar:${string}` | `command:${string}`,
    run: () => void,
  ): () => void {
    const report = (err: unknown): void => {
      if (reportedCallbacks.has(label)) {
        console.error(`[NekoWite:plugin-host] callback failed again plugin="${id}" origin="${origin}"`, err)
        return
      }
      reportedCallbacks.add(label)
      recordPluginEvent(id, 'crash', `callback "${label}" threw: ${err instanceof Error ? err.message : String(err)}`)
      reportPluginCallbackError(id, origin, err)
    }
    return () => {
      try {
        const returned = run() as unknown
        // A callback may be async — `() => Promise<void>` is assignable to a
        // void-returning type — and then its failure does NOT arrive at the
        // catch below: it becomes an unhandled rejection in the host with no
        // plugin name on it, which is the failure this wrapper exists to
        // prevent. Contain the thenable as well as the synchronous throw.
        if (returned && typeof (returned as { then?: unknown }).then === 'function') {
          Promise.resolve(returned).catch(report)
        }
      } catch (err) {
        report(err)
      }
    }
  }
}
