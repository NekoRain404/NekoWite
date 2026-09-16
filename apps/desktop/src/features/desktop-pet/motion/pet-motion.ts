/**
 * The roaming engine: the tick, what it prioritises, and when the pet dozes off.
 *
 * Ported from `references/desktop-pet/windows/src/roam/engine.ts` and the config it read
 * from `roam/types.ts`, at commit `be171a01273a1ed92a27bcdf72f8a58768bac421`:
 *
 *   - the resting tick and its reason (`engine.ts:29-35`), the loop (`:158-164`) and the
 *     lifecycle (`:166-180`)
 *   - the tick's priority order (`:77-115`), the step and its 0.5 px dead zone (`:117-133`),
 *     the stationary and doze rules (`:135-143`), the drag/release handoff (`:84-93`,
 *     `:145-156`, `:182-192`)
 *   - `setMood` and the two moods that hold the pet still (`:44-57`, `:49`), `wake`/`enterSleep`
 *     (`:59-71`)
 *   - the roam settings (`types.ts:101-115`), the doze deadline and sleep row (`types.ts:59-63`)
 *
 * The four concerns upstream spread across `roam/` are five files here, because the platform
 * adaptation and the capability gate are the parts §3 and §7.2 ask for and neither exists
 * upstream: `pet-platform.ts` is the window and screen, `pet-modes.ts` is the walking,
 * `pet-mode-gate.ts` is what may run, `pet-motion-types.ts` is the vocabulary, and this file is
 * the engine that drives them.
 *
 * What the port changed, and why (plan §3, §3.1, §7.2, §7.3):
 *   - The tick says how long to wait instead of sleeping itself, and the clock, the random
 *     source and the platform are injected, so the scheduler belongs to the caller and
 *     §7.1 can destroy it with the window.
 *   - Settings come from the contract's domains rather than `localStorage`
 *     (`types.ts:101-124`); there is no config cache and no `storage` listener here,
 *     because a caller-supplied value is not a read that needs caching (§5.3).
 *   - The mood vocabulary is closed and the mode it gates is decided by `gateRoamMode`, so
 *     a mode whose capability is missing is *stated* rather than attempted (§7.2).
 *   - A refused window move ends the step instead of being logged and forgotten
 *     (`engine.ts:130-131`); the reason is on that branch.
 */
import type { PetCapabilityReport, PetRoamMode } from '../../../platform/gateways/pet-contracts'
import {
  DragTrace,
  THROW_MIN_SPEED,
  TICK_MS,
  applyFall,
  applyThrow,
  type PetMotionFrame,
  type PhysicsDeps,
  type ThrowSession,
  type Velocity,
} from './pet-physics'
import { gateRoamMode, type RoamModeGate } from './pet-mode-gate'
import { createRoamModeState, runMode, type RoamModeState } from './pet-modes'
import {
  createEnvironmentReader,
  logicalWindow,
  pointerReader,
  type PetMotionPlatform,
} from './pet-platform'
import {
  clampToBounds,
  motionSpeed,
  systemClock,
  type MotionClock,
  type MotionTick,
  type MotionTimerHandle,
  type PetMotionMood,
  type PetMotionSettings,
  type PetRoamBehaviour,
} from './pet-motion-types'

/** The resting tick. Upstream `engine.ts:35`: 200 ms while nothing moves, 30 ms while it does. */
export const IDLE_TICK_MS = 200
/** Doze off after this long without movement. Upstream `types.ts:60`. */
export const SLEEP_AFTER_MS = 30_000
/** The sleep pose's sheet row, when the caller binds no other. Upstream `types.ts:63`. */
export const SLEEP_ROW_DEFAULT = 5

export interface PetMotionDeps {
  platform: PetMotionPlatform
  /** What this machine was verified to do (§7.2). Read whenever a mode is chosen. */
  capabilities: () => readonly PetCapabilityReport[]
  /** The user's roaming settings, re-read every tick the way upstream re-read them. */
  settings: () => PetMotionSettings
  /** Sprite rows while walking, throwing or asleep; null when nothing is drawn. */
  frame?: PetMotionFrame | null
  /** Tick scheduling. Defaults to `setTimeout`/`clearTimeout`. */
  clock?: MotionClock
  /** Wall clock for the rest and doze deadlines. Defaults to `Date.now`. */
  now?: () => number
  /** 0 <= r < 1. Defaults to `Math.random`. */
  random?: () => number
  /** The sleep pose's sheet row. Upstream's `ap_bind_sleep` (`engine.ts:68`). */
  sleepRow?: number
  /** A platform call failed. Upstream logged these (`engine.ts:131`); a caller may surface them. */
  onPlatformError?: (error: unknown) => void
}

export interface PetMotionEngine {
  /** One step, resolving with the delay before the next. */
  tick(): Promise<MotionTick>
  /** Begin ticking. Upstream `initEngine` (`engine.ts:166-174`). */
  start(): void
  /** Stop for good: no timer, no motion in flight, no row override (§7.1). */
  stop(): void
  /** A drag began or ended. Upstream `setDragging` (`engine.ts:182-192`). */
  setDragging(dragging: boolean): void
  setMood(mood: PetMotionMood): void
  mood(): PetMotionMood
  /** What is running now, and the finding where the requested mode cannot (§7.2). */
  gate(): RoamModeGate
}

/** One engine per character. Upstream's module-level state, one instance at a time. */
export function createPetMotion(deps: PetMotionDeps): PetMotionEngine {
  const clock = deps.clock ?? systemClock
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const frame = deps.frame ?? null
  const window = logicalWindow(deps.platform)
  const environment = createEnvironmentReader(deps.platform, now)
  const readPointer = pointerReader(deps.platform)
  const trace = new DragTrace()
  const session: ThrowSession = { running: false }
  const state: RoamModeState = createRoamModeState()

  let dragging = false
  let releasePending = false
  let stopped = false
  let scheduling = false
  let mood: PetMotionMood = 'idle'
  let lastMoveTs = now()
  let sleeping = false

  // The sleep in flight, so `stop()` can end it rather than leave a timer to fire into a dead
  // engine: §7.1 asks a destroyed pet to leave no timer behind, and a parked loop is one.
  let pendingSleep: (() => void) | null = null
  // The clock's own handle, not `number`: under the DOM lib a timer answers a number, under
  // Node's globals a `Timeout` object, and `MotionClock` names whichever one is in force.
  let pendingTimer: MotionTimerHandle | null = null

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      pendingSleep = resolve
      pendingTimer = clock.setTimeout(() => {
        pendingSleep = null
        pendingTimer = null
        resolve()
      }, ms)
    })

  function releaseSleep(): void {
    if (pendingTimer !== null) {
      clock.clearTimeout(pendingTimer)
      pendingTimer = null
    }
    const resolve = pendingSleep
    pendingSleep = null
    resolve?.()
  }

  const physics = (): PhysicsDeps => ({
    window,
    sleep,
    frame,
    onPlatformError: deps.onPlatformError,
    stopped: () => stopped,
  })

  function readSettings(): { roam: PetRoamMode; speed: number; reduced: boolean } {
    const raw = deps.settings()
    return { roam: raw.roam, speed: motionSpeed(raw.speed), reduced: raw.motion === 'reduced' }
  }

  function currentGate(roam: PetRoamMode): RoamModeGate {
    return gateRoamMode(roam, deps.capabilities(), deps.platform)
  }

  function wake(): void {
    if (!sleeping) return
    sleeping = false
    frame?.clearRow()
  }

  function enterSleep(): void {
    if (sleeping) return
    sleeping = true
    // Upstream read `ap_bind_sleep` and accepted any finite row that was not negative
    // (`engine.ts:68-70`); a caller that passed nothing gets the row upstream defaulted to.
    const row = deps.sleepRow
    frame?.setRow(typeof row === 'number' && Number.isInteger(row) && row >= 0 ? row : SLEEP_ROW_DEFAULT)
  }

  /** Cancel a throw or a fall in flight (`engine.ts:176-180`): the next gesture takes over from here. */
  function cancelThrow(): void {
    session.running = false
  }

  /** Stationary, and maybe dozing. Upstream `handleStationary` (`engine.ts:135-143`). */
  function handleStationary(): void {
    if (mood === 'idle' && now() - lastMoveTs > SLEEP_AFTER_MS) enterSleep()
    else {
      wake()
      frame?.clearRow()
    }
  }

  async function stepMode(behaviour: PetRoamBehaviour, speed: number): Promise<boolean> {
    const env = await environment.read()
    if (!env) return false
    const pos = await window.currentPosition()
    if (!pos) return false

    // Upstream dropped a wandering pet's target whenever the mode was not wander
    // (`modes.ts:80`); the destination belongs to the mode that chose it.
    if (behaviour !== 'wander') {
      state.target = null
      state.restUntil = 0
    }

    const candidate = await runMode(
      behaviour,
      { env, pos, frame, speed, random, now, pointer: readPointer },
      state,
    )
    const clamped = clampToBounds(candidate, env.workArea)
    if (Math.abs(clamped.x - pos.x) < 0.5 && Math.abs(clamped.y - pos.y) < 0.5) return false

    lastMoveTs = now()
    try {
      await window.moveTo(clamped)
    } catch (error) {
      // Upstream swallowed this and still reported the pet as moving (`engine.ts:130-131`).
      // Where a desktop refuses to position a window — a Wayland toplevel is not the
      // client's to place — that answer would hold the 30 ms tick open forever while
      // nothing moved. A refused move means the pet is not moving, and it is reported: a pet
      // that never walks is a §7.2 finding, not a mystery.
      deps.onPlatformError?.(error)
      return false
    }
    return true
  }

  async function handleDragRelease(velocity: Velocity, roam: PetRoamMode): Promise<void> {
    const env = await environment.read()
    if (!env) return
    // A climbing pet falls (Shimeji-style) so it lands on a window rather than flying
    // through it; every other mode throws. Upstream `engine.ts:145-156`, where the test was
    // that the window list was not empty.
    if (currentGate(roam).behaviour === 'climb' && env.surfaces.length > 0) {
      await applyFall(physics(), session, velocity.vx, env.workArea, env.surfaces)
    } else {
      await applyThrow(physics(), session, velocity, env.workArea)
    }
  }

  /**
   * One step. Priority: throw > drag > reduced motion > release > alert > mode
   * (`engine.ts:77-115`).
   *
   * The order is the behaviour: a drag beats the mode stepping that would fight it, a
   * motion in flight finishes or is cancelled before anything else decides where the pet
   * is, and an interrupted gesture continues from the current position rather than
   * restarting (§7.3 「从当前状态反向运行，不排队」).
   */
  async function tick(): Promise<MotionTick> {
    const settings = readSettings()

    if (session.running) {
      // §7.3: a setting that removes motion acts on the motion that is happening, so asking
      // for reduced motion mid-throw stops it instead of queueing behind it.
      if (settings.reduced) cancelThrow()
      return { active: true, delayMs: TICK_MS }
    }

    if (dragging) {
      const pos = await window.currentPosition()
      if (pos) trace.record(pos, now())
      return { active: true, delayMs: TICK_MS }
    }

    if (settings.reduced) {
      // §7.3 keeps static state, text and unread, and forbids roaming and bouncing: the pet
      // is left exactly where it is. Dragging still works, because that is the user moving
      // it rather than the pet moving itself. Alerts are not this module's to suppress —
      // the mood below is still whatever the caller last set, and the bubble is D5's.
      releasePending = false
      trace.clear()
      wake()
      frame?.clearRow()
      return { active: false, delayMs: IDLE_TICK_MS }
    }

    if (releasePending) {
      releasePending = false
      const velocity = trace.releaseVelocity()
      trace.clear()
      if (velocity && Math.hypot(velocity.vx, velocity.vy) > THROW_MIN_SPEED) {
        wake()
        await handleDragRelease(velocity, settings.roam)
        return { active: true, delayMs: TICK_MS }
      }
    }

    // Keep still while the user needs to read the bubble or see a burst finish.
    if (mood === 'alert') {
      wake()
      frame?.clearRow()
      return { active: false, delayMs: IDLE_TICK_MS }
    }

    const gate = currentGate(settings.roam)
    if (gate.behaviour === null || gate.behaviour === 'stay') {
      handleStationary()
      return { active: false, delayMs: IDLE_TICK_MS }
    }

    wake()
    const moved = await stepMode(gate.behaviour, settings.speed)
    if (!moved && mood === 'idle' && now() - lastMoveTs > SLEEP_AFTER_MS) enterSleep()
    return { active: moved, delayMs: moved ? TICK_MS : IDLE_TICK_MS }
  }

  async function loop(): Promise<void> {
    while (scheduling) {
      const step = await tick()
      if (!scheduling) break
      await sleep(step.delayMs)
    }
    frame?.clearRow()
  }

  return {
    tick,

    start(): void {
      if (scheduling) return
      scheduling = true
      stopped = false
      lastMoveTs = now()
      sleeping = false
      void loop()
    },

    stop(): void {
      scheduling = false
      stopped = true
      cancelThrow()
      releasePending = false
      trace.clear()
      releaseSleep()
      frame?.clearRow()
    },

    setDragging(next: boolean): void {
      dragging = next
      if (next) {
        // A drag ends whatever motion is in flight, from wherever it had got to.
        cancelThrow()
        trace.clear()
        wake()
        releasePending = false
      } else {
        releasePending = true
      }
    },

    setMood(next: PetMotionMood): void {
      mood = next
      if (next !== 'idle') wake()
    },

    mood(): PetMotionMood {
      return mood
    },

    gate(): RoamModeGate {
      return currentGate(readSettings().roam)
    },
  }
}
