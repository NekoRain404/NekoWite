/**
 * The pet window's wiring: what it draws, what it says about a task, and where a click goes.
 *
 * `usePetLifecycle` (D3) owns the *lifetime* — the subscription, the holds, the two scopes — and
 * this owns the two things a lifetime cannot: the character the window draws (read from the host,
 * and re-read when another window changes it) and the aggregate the sprite plays. Keeping them
 * apart is what lets each be tested on its own: a lifecycle test never needs a spritesheet, and a
 * mood test never needs a subscription.
 *
 * Three decisions are the acceptance clauses rather than taste:
 *
 * - **The appearance is *read*, never polled.** The host publishes an applied settings write on
 *   `pet-settings-changed`, and this listens: a character chosen in the main window's settings
 *   reaches a window that is already open, without a timer asking a file whether it changed. A
 *   domain this window does not draw from is ignored, so a write to `care` costs one comparison.
 * - **A read that failed is stated, not hidden.** The three arms of `PetAppearance` are states, and
 *   a rejected read is a fourth — "the host could not answer" — which the window says in the
 *   host's own words. Drawing nothing is also a state, and the difference between them is what
 *   tells a user whether their character is missing or their backend is.
 * - **The mood is derived, never stored.** `buildPetTaskView` is a function of the tasks and a
 *   clock (§9's 快照到展示), so a task list that changed while the window was hidden produces the
 *   right pose the moment it is shown again — there is no state to have gone stale.
 *
 * The clock is this file's, and it is a *hold*: §7.1 stops the drawing when the pet is hidden, and
 * a timer that kept recomputing a mood for a window nobody is looking at would be the same class
 * of work as animating it. The caller that hides the pet releases the drawing scope, which stops
 * this with it.
 */
import { computed, onScopeDispose, shallowRef, type ComputedRef, type ShallowRef } from 'vue'
import { isPetAppearance } from '../../../platform/gateways/pet-contracts'
import type {
  PetSettingsChange,
  PetTaskProjection,
  PetWindowGateway,
} from '../../../platform/gateways/pet-contracts'
import type { SpriteClock } from '../rendering/animation-bindings'
import { buildPetTaskView, type PetTaskMood } from '../services/pet-task-view'
import { petAppearanceView, type PetAppearanceView } from '../services/pet-appearance'
import type { PetHold } from './use-pet-lifecycle'

export interface PetWindowOptions {
  connection: PetWindowGateway
  /** The tasks the lifecycle holds. A getter, because the lifecycle replaces the array. */
  tasks: () => readonly PetTaskProjection[]
  /** How often the mood and the rows are recomputed while the pet is drawing. */
  tickMs?: number
  /** Register something the window holds (§7.1's drawing scope), so hiding releases it. */
  hold?: (hold: PetHold) => () => void
  /** The timer host, injected for tests (§10.2). */
  clock?: Pick<SpriteClock, 'setTimeout' | 'clearTimeout'>
}

export interface PetWindow {
  /** What to draw, or why nothing is drawn. `null` until the host has answered. */
  readonly appearance: ShallowRef<PetAppearanceView | null>
  /** The host's own words when the appearance could not be read. */
  readonly appearanceError: ShallowRef<string | null>
  /** The host's clock, in epoch ms, recomputed while the window draws. */
  readonly now: ShallowRef<number>
  /** §6.3's aggregate, as the row the sprite plays. */
  readonly mood: ComputedRef<PetTaskMood>
  /** Read the appearance, and start listening for another window's change to it. */
  start: () => Promise<void>
  /** A click on a row: back to the session it belongs to (§6.2's 点击返回任务). */
  select: (task: PetTaskProjection) => Promise<void>
  /** Release the settings subscription and the timer. */
  dispose: () => Promise<void>
}

/** Upstream's repaint cadence, and the same one `TaskHistory`'s coalescing window assumes. */
export const PET_TICK_MS = 500

export function usePetWindow(options: PetWindowOptions): PetWindow {
  const clock = options.clock ?? {
    setTimeout: (handler: () => void, ms: number) => globalThis.setTimeout(handler, ms),
    clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => globalThis.clearTimeout(handle),
  }
  const appearance = shallowRef<PetAppearanceView | null>(null)
  const appearanceError = shallowRef<string | null>(null)
  const now = shallowRef(Date.now())
  let unsubscribe: (() => void) | null = null
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null
  let disposed = false

  /**
   * Whether a settings write matters to this window.
   *
   * Two domains, and they are the two the appearance read carries: `character` decides what the
   * sprite draws, and `message` carries the bubble's background alpha (§5.2's 气泡与消息), which is
   * drawn by the bubble in this window. A comparison rather than a re-read of everything, and the
   * *only* reason this listener exists is that a write in another window is otherwise invisible
   * here — which is what would have made a poll necessary.
   *
   * **`general` is deliberately not here**, and the reason is a fact about this surface rather
   * than about the setting: the read carries `general.motion` too (see `pet-appearance.ts`), and
   * this window has no CSS motion for it to change — upstream's kill list turns off `#pet.bob`
   * (`references/desktop-pet/windows/src/styles.css:1280-1287`), a bob this port never carried,
   * and the sprite's own frames are the drawing rather than an animation beside it. The ball
   * window is the surface that moves, and `PetBallWindow.vue` is where the policy is applied.
   * Re-reading here would be a call per motion change that changes nothing on this surface.
   */
  function onSettingsChanged(change: PetSettingsChange): void {
    if (change.domain !== 'character' && change.domain !== 'message') return
    void readAppearance()
  }

  async function readAppearance(): Promise<void> {
    try {
      const read = await options.connection.appearance()
      if (disposed) return
      if (!isPetAppearance(read)) {
        // An answer that is not an appearance is not an appearance: a browser build answers every
        // command its stub does not know with `undefined`, and reading that for a `status` threw
        // while the window rendered — the same defect that reached the settings side through the
        // capability report. Stated rather than substituted, and stated *without* pretending to be
        // an answer: "nothing is chosen" would be a claim this window cannot make.
        appearanceError.value = 'the host answered something that is not a character to draw'
        return
      }
      appearance.value = petAppearanceView(read)
      appearanceError.value = null
    } catch (cause) {
      if (disposed) return
      // The host's own sentence, kept apart from `appearance.value`: the window says which of the
      // two it is holding, and a window that folded them would show "no character is selected" for
      // a backend that could not answer.
      appearanceError.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  async function start(): Promise<void> {
    if (disposed) return
    // The read first, then the subscription: a change that lands in between is delivered twice
    // rather than lost, and the read is complete every time — the same ordering `subscribe` uses
    // for tasks, for the same reason.
    await readAppearance()
    try {
      const off = await options.connection.subscribeSettings(onSettingsChanged)
      if (disposed) off()
      else unsubscribe = off
    } catch (cause) {
      // A host that cannot deliver the channel still has a working `appearance` read: the window
      // keeps drawing what it has and does not turn a listener failure into a state, because the
      // next write is not this window's to know about.
      appearanceError.value ??= cause instanceof Error ? cause.message : String(cause)
    }
    arm()
  }

  function tick(): void {
    if (disposed) return
    now.value = Date.now()
    arm()
  }

  function arm(): void {
    if (disposed || timer !== null) return
    timer = clock.setTimeout(tick, options.tickMs ?? PET_TICK_MS)
  }

  function release(): void {
    if (timer !== null) {
      clock.clearTimeout(timer)
      timer = null
    }
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    release()
    unsubscribe?.()
    unsubscribe = null
  }

  const view = computed(() =>
    buildPetTaskView({ tasks: options.tasks(), now: now.value }),
  )

  // §7.1's drawing scope: hiding the pet stops the drawing, and this timer is drawing. Registered
  // with the lifecycle rather than beside it, so there is one place that knows what a hold is.
  options.hold?.({ scope: 'drawing', release })

  // A window that unmounts without disposing is the leak D3's composable exists to prevent; this
  // one registers its own teardown for the same reason, and `dispose` is idempotent.
  onScopeDispose(() => void dispose())

  return {
    appearance,
    appearanceError,
    now,
    mood: computed(() => view.value.mood),
    start,
    select: async (task) => {
      // The key and nothing else: which window or session that becomes is the main window's
      // decision, and §6.3's limited-target rule is what keeps a click from naming one itself.
      await options.connection.openTask(task.key)
    },
    dispose,
  }
}
