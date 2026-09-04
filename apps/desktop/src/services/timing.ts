/**
 * Timing utilities for coalescing the editor's high-frequency work.
 *
 * The change pipeline fires per keystroke. Two expensive operations ride on
 * it: full-document Markdown serialization (`editor.save()`) and the
 * find/spell overlay recompute. Debouncing/rAF-throttling collapses a burst of
 * keystrokes into one execution without changing WHAT runs — only WHETHER it
 * runs on the extra intermediate frames.
 *
 * Both helpers return a handle with `run` (invoke with the latest args), and
 * `cancel`/`flush` to drop or force a pending execution. Pure: no DOM or store
 * dependency, so they are unit-testable in isolation.
 */

export interface TimingHandle<Args extends unknown[]> {
  /** Coalesce a burst of calls into a single future execution. */
  run: (...args: Args) => void
  /** Drop a pending (not-yet-executed) invocation. */
  cancel: () => void
  /** Execute a pending invocation immediately, if any. */
  flush: () => void
}

/**
 * Trailing debounce: run `fn` once, `ms` after the LAST call, passing the
 * latest arguments. Use for work that should only run once input settles — the
 * classic way to stop re-serializing a whole document on every keystroke.
 */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  ms: number,
): TimingHandle<Args> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastArgs: Args | null = null

  const run = (...args: Args): void => {
    lastArgs = args
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const argsSnapshot = lastArgs
      lastArgs = null
      if (argsSnapshot) fn(...argsSnapshot)
    }, ms)
  }

  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    lastArgs = null
  }

  const flush = (): void => {
    if (lastArgs === null) return
    if (timer !== null) clearTimeout(timer)
    timer = null
    const argsSnapshot = lastArgs
    lastArgs = null
    fn(...argsSnapshot)
  }

  return { run, cancel, flush }
}

/**
 * Animation-frame throttle: run `fn` at most once per frame, coalescing calls
 * made within a frame into a single execution on the next frame. Use for work
 * that should stay visually in sync with the browser but not run in a tight
 * loop (e.g. overlay refresh).
 */
export function rafThrottle<Args extends unknown[]>(
  fn: (...args: Args) => void,
): TimingHandle<Args> {
  let rafId = 0
  let lastArgs: Args | null = null

  const run = (...args: Args): void => {
    lastArgs = args
    if (rafId !== 0) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      const argsSnapshot = lastArgs
      lastArgs = null
      if (argsSnapshot) fn(...argsSnapshot)
    })
  }

  const cancel = (): void => {
    if (rafId !== 0) cancelAnimationFrame(rafId)
    rafId = 0
    lastArgs = null
  }

  const flush = (): void => {
    if (rafId !== 0) cancelAnimationFrame(rafId)
    rafId = 0
    const argsSnapshot = lastArgs
    lastArgs = null
    if (argsSnapshot) fn(...argsSnapshot)
  }

  return { run, cancel, flush }
}
