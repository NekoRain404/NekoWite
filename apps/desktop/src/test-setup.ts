import { beforeAll, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// The leaked-timer guard. `packages/editor-core/vitest.setup.ts` is the same
// guard for the editor package, and holds the longer version of this note.
//
// `@milkdown/ctx`'s `Timer.start()` schedules `setTimeout(this.type.timeout)` and
// keeps no handle (`@milkdown/ctx/src/timer/timer.ts:76-78`), so that callback can
// never be cancelled; when it fires it calls the global `removeEventListener`
// unconditionally, even for a timer that already resolved — `timer.ts:48-51`
// reaches `#removeListener` at `timer.ts:72` either way. Every editor a test
// creates starts ten of them (ConfigReady, InitReady, SchemaReady, …), so ten 3 s
// callbacks outlive every editor; 260 of them were measured across the three
// EditorPane files alone.
//
// In the app that is harmless — the webview's globals outlive every editor, so
// the late `removeEventListener` is a no-op — and here it is fatal, because two
// things hold at once:
//   * `globalThis.setTimeout` is NODE's timer, not happy-dom's (vitest's
//     `getWindowKeys` keeps a global that already exists), so happy-dom's
//     `happyDOM.abort()` cannot clear it — it only clears timers it registered;
//   * the environment teardown DELETES the happy-dom globals
//     (`keys.forEach((key) => delete global[key])`), and nothing puts them back
//     until the next file's environment is up.
// The callback then fires into a scope with no `removeEventListener` in it, and
// vitest records `ReferenceError: removeEventListener is not defined` as an
// uncaught error, attributed to whichever file the worker happened to be on. The
// window needs the worker to be alive with its globals already gone, which is why
// it is ten errors on one run and none on the next, why a single-file run never
// shows it (that worker is torn down first), and why it tracks the machine's load
// rather than the code.
//
// The wrapper goes around the CALLBACK rather than around the global, so it lives
// in the timer queue instead of in a global that teardown removes, and it
// re-throws everything that is not that one known error: a genuine failure inside
// a timer is still reported, and still turns the run red.
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

class MemoryStorage implements Storage {
  private store = new Map<string, string>()

  get length(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
}

// vitest's happy-dom environment does not surface window.localStorage in this
// setup; provide an in-memory Storage so tests (and the settings store's
// persistence) behave as they do inside the Tauri webview.
let storage = new MemoryStorage()

beforeAll(() => {
  storage = new MemoryStorage()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: storage,
  })
})

afterEach(() => {
  storage.clear()
})