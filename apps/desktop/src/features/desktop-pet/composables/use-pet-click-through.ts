/**
 * Whether this window takes the pointer's clicks (§7.2's 鼠标穿透).
 *
 * §7.2 asks for two things at once — 「透明区和角色可点区、菜单打开/关闭」 — and this window cannot have
 * both, because the layer below it offers one switch rather than a shape. tao's
 * `set_ignore_cursor_events` sets the whole toplevel's input region to a single pixel or clears it
 * again (`WindowRequest::CursorIgnoreEvents`, tao 0.35 `platform_impl/linux/event_loop.rs`), and
 * Tauri passes that straight through, so the window either takes every click over its rectangle or
 * none of them. A rule that decided per pixel would have to know where the pointer is, and this
 * platform will not say: tao's `cursor_position()` answers `(0, 0)` on Wayland without asking
 * anybody (`platform_impl/linux/util.rs`), and a window whose input region is empty is sent no
 * pointer events at all — so the moment a pixel-by-pixel rule made the window click-through, it
 * would lose the only instrument that could tell it to stop being one. That is the one-way trap
 * §7.2 refuses by name (「不宣称像素命中检测等于系统穿透」), and it is why this file does not ask where
 * the pointer is.
 *
 * What is left is the rule this platform can carry out: **the window takes the pointer exactly
 * while it has something for the pointer to act on**, and is click-through the rest of the time.
 * That is §7.2's fallback column measured in time instead of in pixels — 「无支持则使用紧凑交互窗口」,
 * a window that takes the clicks it covers, made small by taking them only where it has a use for
 * them.
 *
 * Three properties are acceptance clauses rather than taste:
 *
 * - **Interactive is the direction every failure falls back to.** A window nobody has told anything
 *   is a window that takes clicks, which is the compositor's own default and the initial value
 *   here, and a request the host refused leaves the last state in place so the next change asks
 *   again instead of assuming it landed. A pet that cannot be clicked has no workaround, while a
 *   pet that takes a click it did not need is the defect this file is here to make smaller rather
 *   than larger. Nothing is restored on teardown, and that is deliberate rather than forgotten: a
 *   character window is created on demand and torn down by the host (§7.1), and the window that
 *   replaces it is a new surface with the compositor's own default input region — so the state
 *   dies with the window, and a request made on the way out would be one no one is left to read.
 * - **One request per change, not per frame** (§7.3's budget). The host is asked only when the
 *   answer differs from the one it already has, and requests are serialised so a burst of changes
 *   collapses into the state the window ends up in.
 * - **It is not the renderer's hit test.** `sprite-hit-test.ts` answers "is this point on the
 *   character"; this answers "does the compositor hand this window the click at all". §7.2 forbids
 *   presenting one as the other, and nothing here reads a pixel.
 */
import { getCurrentScope, onScopeDispose, shallowRef, watch, type ShallowRef } from 'vue'

export interface PetClickThroughOptions {
  /**
   * The host's own operation on the window that is asking.
   *
   * A parameter rather than an import, like every other host call in this feature (§10.2): the
   * compositor is what a test cannot have, and the policy is the part with rules in it.
   */
  setClickThrough?: (ignore: boolean) => Promise<void>
  /**
   * Whether the window has something on screen for the pointer to act on.
   *
   * A getter, and the only input: the rule is a function of what the window is showing, never of
   * where the pointer is (see this file's header).
   */
  needsInput: () => boolean
}

export interface PetClickThrough {
  /** Whether the host was last told to let clicks through. False is what a fresh window is. */
  readonly passthrough: ShallowRef<boolean>
  /** The host's own words when a request was refused; `null` once one lands. */
  readonly error: ShallowRef<string | null>
  /** Ask, when the answer differs from the one the host already has. Safe to call at any time. */
  sync: () => Promise<void>
  dispose: () => void
}

export function usePetClickThrough(options: PetClickThroughOptions): PetClickThrough {
  const passthrough = shallowRef(false)
  const error = shallowRef<string | null>(null)
  let disposed = false
  /**
   * Requests run one at a time, in the order they were asked for.
   *
   * Each one re-reads `needsInput` when it runs rather than when it was queued, so a burst costs
   * one request and settles on the window's current state — and two overlapping calls can never
   * land in the order that leaves the compositor holding the state the window has left.
   */
  let chain: Promise<void> = Promise.resolve()

  async function step(): Promise<void> {
    if (disposed) return
    const want = !options.needsInput()
    if (want === passthrough.value) return
    if (!options.setClickThrough) return
    try {
      await options.setClickThrough(want)
      if (disposed) return
      // A resolved call is the state the compositor now holds: the command it reaches is
      // identity-checked at the host, so there is no window it could have applied to other than
      // this one.
      passthrough.value = want
      error.value = null
    } catch (cause) {
      if (disposed) return
      // Stated rather than swallowed, and *not* recorded as applied: a refusal leaves the window
      // in the state it was in, which is the safe direction and the one the next change retries
      // from.
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  function sync(): Promise<void> {
    chain = chain.then(step)
    return chain
  }

  const stop =
    getCurrentScope() !== undefined
      ? watch(options.needsInput, () => void sync())
      : undefined

  function dispose(): void {
    if (disposed) return
    disposed = true
    stop?.()
  }

  // A composable that is dropped without disposing is a watcher that outlives its window's state;
  // registered only inside a scope, so this stays usable from a plain test.
  if (getCurrentScope()) onScopeDispose(dispose)

  return { passthrough, error, sync, dispose }
}
