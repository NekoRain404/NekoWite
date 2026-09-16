/**
 * Which animation a pet state plays, and the clock that plays it.
 *
 * Ported from `references/desktop-pet/windows/src/pet.ts` at commit
 * `be171a01273a1ed92a27bcdf72f8a58768bac421`:
 *   - `STATE_ROW` (14-21) and `STATE_FPS` (24-31), as the defaults below
 *   - `readIdleClips` / `readIdleIntervalMs` (44-62), surviving as validation rules
 *   - `setState`'s row and frame-rate resolution (200-210)
 *   - `startIdleCycling` / `advanceIdleClip` / `stopIdleCycling` (212-246), as IdlePlaylist
 *
 * The clock abstraction lives here rather than next to the frame loop because this module
 * owns the *timing policy* - the frame rate per state and the idle interval - and the
 * player is a consumer of it. One clock type, one import direction, no cycle.
 *
 * Two upstream behaviours are deliberately not carried over:
 *   - Upstream reads `localStorage` per call (`ap_idle_clips`, `ap_idle_mode`,
 *     `ap_idle_interval`, `ap_bind_<state>`). Plan §3.1.4 requires one persistence
 *     authority and forbids the rendering layer growing a second one, so configuration
 *     arrives as an already-validated object. Upstream's *rules* survive, in
 *     `normalizeAnimationConfig`.
 *   - Upstream drove the idle playlist with `window.setInterval` and picked clips with
 *     `Math.random`. Both are injected (plan §3), which is what lets a test run five
 *     minutes of idle cycling in a few statements.
 */

/** Frame scheduling, shared by the player's frame loop and the idle playlist. */
export interface SpriteClock {
  setTimeout: (handler: () => void, ms: number) => number
  clearTimeout: (handle: number) => void
}

/**
 * The browser clock. `globalThis.setTimeout` is read at call time rather than captured at
 * module load, so faking the global timers in a test fakes this clock too.
 */
export const browserClock: SpriteClock = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
}

/** Upstream `DEFAULT_IDLE_INTERVAL_S = 5` (line 42). */
export const DEFAULT_IDLE_INTERVAL_MS = 5000
/** Upstream rejected an idle interval below one second (line 59). */
export const MIN_IDLE_INTERVAL_MS = 1000

export interface AnimationConfig {
  /** Row per host state (upstream `STATE_ROW`). */
  stateRows: Record<string, number>
  /** Frames per second per host state (upstream `STATE_FPS`). */
  stateFps: Record<string, number>
  /** The user's row binding per state (upstream `ap_bind_<state>`). Wins over `stateRows`. */
  bindings: Record<string, number>
  /** Rows the idle mood cycles through; empty disables the playlist (upstream `ap_idle_clips`). */
  idleClips: number[]
  /** `random` picks any clip, `sequential` walks the list (upstream `ap_idle_mode`). */
  idleMode: 'random' | 'sequential'
  /** How long one idle clip stays on screen (upstream `ap_idle_interval`, entered in seconds). */
  idleIntervalMs: number
  /** Row for a state with no mapping (upstream `STATE_ROW[state] ?? 0`, line 205). */
  fallbackRow: number
  /** Frame rate for a state with no mapping (upstream `STATE_FPS[state] ?? 3`, line 201). */
  fallbackFps: number
}

/**
 * Upstream's defaults, kept verbatim. The rows are the macOS app's spritesheet layout:
 * 0 Idle, 1 RunRight, 2 RunLeft, 3 Waving, 4 Jumping, 5 Failed, 6 Waiting, 7 Running,
 * 8 Review; `done` waves goodbye and `celebrate` jumps.
 */
export const DEFAULT_ANIMATION_CONFIG: AnimationConfig = {
  stateRows: {
    idle: 0,
    registered: 0,
    working: 7,
    waiting: 6,
    done: 3,
    celebrate: 4,
  },
  stateFps: {
    working: 8,
    celebrate: 8,
    waiting: 4,
    done: 3,
    idle: 3,
    registered: 3,
  },
  bindings: {},
  idleClips: [],
  idleMode: 'random',
  idleIntervalMs: DEFAULT_IDLE_INTERVAL_MS,
  fallbackRow: 0,
  fallbackFps: 3,
}

/** A row index names a row only if it is a whole, non-negative, finite number. */
function isRow(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * These values arrive from persisted settings, so they are checked as data rather than
 * trusted as types: a config saved by an older build (or hand-edited) can hold anything
 * in any field, and a non-object where a map is expected would otherwise throw inside
 * `Object.entries` at the first frame.
 */
function isRecord(value: unknown): value is Record<string, number> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Keeps the entries that name a row and drops the rest, rather than repairing them.
 * Upstream's binding check was `Number.isFinite(bound) && bound >= 0` (line 205), which
 * admits `1.5`: `clips[1.5]` is `undefined`, so the pet silently fell back to the fixed
 * grid. §5.3 requires numeric settings to be validated for finiteness, range *and*
 * integer-ness, so a fractional row is now treated as unset and the default map applies.
 */
function validRows(source: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isRecord(source)) return out
  for (const [key, value] of Object.entries(source)) if (isRow(value)) out[key] = value
  return out
}

function validRates(source: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isRecord(source)) return out
  for (const [key, value] of Object.entries(source)) if (isRate(value)) out[key] = value
  return out
}

/** Upstream's `readIdleClips` filter (`isFinite(x) && x >= 0`, line 50), plus integrality. */
function validClips(source: unknown): number[] {
  return Array.isArray(source) ? source.filter((value) => isRow(value)) : []
}

/** Upstream's `readIdleIntervalMs` floor of one second (line 59) and five-second default. */
function validInterval(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= MIN_IDLE_INTERVAL_MS ? Math.round(value) : fallback
}

/** A key as an own property only: `state = "constructor"` must not find `Object`'s. */
function ownValue(map: Record<string, number>, key: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined
}

function pick<K extends keyof AnimationConfig>(
  base: AnimationConfig,
  partial: Partial<AnimationConfig>,
  key: K,
): AnimationConfig[K] {
  const value = partial[key]
  return value === undefined ? base[key] : value
}

function rowMap(value: unknown, base: Record<string, number>): Record<string, number> {
  return isRecord(value) ? validRows(value) : base
}

function rateMap(value: unknown, base: Record<string, number>): Record<string, number> {
  return isRecord(value) ? validRates(value) : base
}

function clipList(value: unknown, base: number[]): number[] {
  return Array.isArray(value) ? validClips(value) : base
}

function mode(value: unknown, base: AnimationConfig['idleMode']): AnimationConfig['idleMode'] {
  return value === 'sequential' || value === 'random' ? value : base
}

/**
 * Validates a partial animation config over a base (by default the upstream defaults).
 * A field the caller leaves out keeps the base's value, and so does a field of the wrong
 * *kind* - a corrupted map is replaced by the base rather than emptied, so one bad value
 * cannot strip every state's mapping. Within a map, entries that do not name a row are
 * dropped. Records are replaced as a whole, not merged key by key: a caller that saves an
 * animation mapping sends that mapping.
 */
export function normalizeAnimationConfig(
  partial: Partial<AnimationConfig> = {},
  base: AnimationConfig = DEFAULT_ANIMATION_CONFIG,
): AnimationConfig {
  return {
    stateRows: rowMap(pick(base, partial, 'stateRows'), base.stateRows),
    stateFps: rateMap(pick(base, partial, 'stateFps'), base.stateFps),
    bindings: rowMap(pick(base, partial, 'bindings'), base.bindings),
    idleClips: clipList(pick(base, partial, 'idleClips'), base.idleClips),
    idleMode: mode(pick(base, partial, 'idleMode'), base.idleMode),
    idleIntervalMs: validInterval(
      pick(base, partial, 'idleIntervalMs'),
      base.idleIntervalMs,
    ),
    fallbackRow: isRow(pick(base, partial, 'fallbackRow'))
      ? pick(base, partial, 'fallbackRow')
      : base.fallbackRow,
    fallbackFps: isRate(pick(base, partial, 'fallbackFps'))
      ? pick(base, partial, 'fallbackFps')
      : base.fallbackFps,
  }
}

export interface AnimationBinding {
  row: number
  fps: number
}

/**
 * The row and frame rate a host state maps to (upstream `setState`, 200-210). The user's
 * binding wins over the default mapping, exactly as upstream's `ap_bind_<state>` did.
 */
export function resolveAnimation(state: string, config: AnimationConfig): AnimationBinding {
  return {
    row: ownValue(config.bindings, state) ?? ownValue(config.stateRows, state) ?? config.fallbackRow,
    fps: ownValue(config.stateFps, state) ?? config.fallbackFps,
  }
}

export interface IdlePlaylistDeps {
  clock: SpriteClock
  /** 0 <= r < 1 for the random mode's pick (upstream used `Math.random`, line 232). */
  random: () => number
  config: AnimationConfig
}

/**
 * The idle mood's playlist: cycles through the user's chosen clips instead of looping one
 * action forever (upstream 35-39, 212-246).
 *
 * The playlist only says *which row* is current; the frame counter and the drawing stay
 * with the player, so a clip change is just another row change to it.
 */
export class IdlePlaylist {
  private config: AnimationConfig
  private timer: number | null = null
  private index = 0
  private active = false
  private currentRow: number | null = null
  private restartCount = 0

  constructor(private readonly deps: IdlePlaylistDeps) {
    this.config = deps.config
  }

  /** The row the idle mood is showing, or null when the playlist is off. */
  get row(): number | null {
    return this.currentRow
  }

  /**
   * Bumped on every restart. Upstream reset its frame counter whenever the playlist
   * started (`this.frame = 0`, line 224), and a restart can land on the row it was
   * already showing - the count is how the player sees that and restarts the clip.
   */
  get generation(): number {
    return this.restartCount
  }

  /**
   * The mood became idle (cycle) or left idle (stop) - upstream's
   * `if (state === "idle") startIdleCycling() else stopIdleCycling()` (208-209).
   */
  setActive(active: boolean): void {
    if (active === this.active) return
    this.active = active
    if (active) this.restart()
    else this.stop()
  }

  /**
   * A new animation config arrived. The playlist is restarted only when its own inputs
   * changed, because `setState("idle")` is called on a poll while the pet is idle and a
   * restart on every call would pin the pet to the first clip (upstream's guard, 218).
   * The rest of the config is always stored: the mode is read when a clip advances, so a
   * mode change takes effect without restarting.
   */
  setConfig(config: AnimationConfig): void {
    const changed =
      !sameClips(this.config.idleClips, config.idleClips) ||
      this.config.idleIntervalMs !== config.idleIntervalMs
    this.config = config
    if (this.active && changed) this.restart()
  }

  /** Releases the timer; the player calls this from `destroy()`. */
  stop(): void {
    this.clearTimer()
    this.index = 0
    this.currentRow = null
  }

  private restart(): void {
    this.clearTimer()
    this.restartCount++
    this.index = 0
    const clips = this.config.idleClips
    // No clips configured: the playlist is off even while the mood is idle (upstream 215).
    this.currentRow = clips.length ? clips[0] : null
    if (clips.length) this.arm()
  }

  private arm(): void {
    // Upstream used setInterval; a self-rearming timeout is the same schedule with one
    // primitive, and the drift is irrelevant at a five-second cadence.
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = null
      this.advance()
    }, this.config.idleIntervalMs)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.deps.clock.clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** The next clip, or the first one after the end (upstream 228-238). */
  private advance(): void {
    const clips = this.config.idleClips
    if (!clips.length) return
    if (this.config.idleMode === 'random') {
      const value = this.deps.random()
      // The injected source is not bound by `Math.random`'s contract: clamp to [0, 1]
      // before scaling, or a stray 1 or NaN indexes past the end of the list.
      const unit = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0
      this.index = Math.min(clips.length - 1, Math.floor(unit * clips.length))
    } else {
      this.index = (this.index + 1) % clips.length
    }
    this.currentRow = clips[this.index]
    this.arm()
  }
}

function sameClips(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}
