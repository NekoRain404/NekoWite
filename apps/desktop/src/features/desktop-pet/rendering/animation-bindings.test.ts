import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  browserClock,
  DEFAULT_ANIMATION_CONFIG,
  DEFAULT_IDLE_INTERVAL_MS,
  IdlePlaylist,
  normalizeAnimationConfig,
  resolveAnimation,
  type AnimationConfig,
} from './animation-bindings'

const defaults = DEFAULT_ANIMATION_CONFIG

describe('resolveAnimation', () => {
  it('maps the upstream states to their rows and frame rates', () => {
    // 0 Idle, 1 RunRight, 2 RunLeft, 3 Waving, 4 Jumping, 5 Failed, 6 Waiting, 7 Running
    expect(resolveAnimation('idle', defaults)).toEqual({ row: 0, fps: 3 })
    expect(resolveAnimation('registered', defaults)).toEqual({ row: 0, fps: 3 })
    expect(resolveAnimation('working', defaults)).toEqual({ row: 7, fps: 8 })
    expect(resolveAnimation('waiting', defaults)).toEqual({ row: 6, fps: 4 })
    expect(resolveAnimation('done', defaults)).toEqual({ row: 3, fps: 3 })
    expect(resolveAnimation('celebrate', defaults)).toEqual({ row: 4, fps: 8 })
  })

  it('falls back to the first row at 3 fps for a state it has no mapping for', () => {
    expect(resolveAnimation('something-new', defaults)).toEqual({ row: 0, fps: 3 })
  })

  it('does not read an inherited object key as a mapping', () => {
    // `stateRows['constructor']` on a plain object is a function, not a row. Upstream
    // indexed with its own state names so it could not hit this; here the state comes from
    // an agent event and the map from settings.
    expect(resolveAnimation('constructor', defaults)).toEqual({ row: 0, fps: 3 })
    expect(resolveAnimation('toString', defaults)).toEqual({ row: 0, fps: 3 })
  })

  it('lets the user binding win over the default mapping', () => {
    const bound = normalizeAnimationConfig({ bindings: { working: 1 } })
    expect(resolveAnimation('working', bound)).toEqual({ row: 1, fps: 8 })
  })

  it('honours a binding to row 0', () => {
    const bound = normalizeAnimationConfig({ bindings: { working: 0 } })
    expect(resolveAnimation('working', bound).row).toBe(0)
  })

  it('ignores a binding that does not name a row', () => {
    const bound = normalizeAnimationConfig({ bindings: { working: -1 } })
    expect(resolveAnimation('working', bound).row).toBe(7)
  })
})

describe('normalizeAnimationConfig', () => {
  it('keeps the upstream defaults for everything left out', () => {
    expect(normalizeAnimationConfig({})).toEqual(DEFAULT_ANIMATION_CONFIG)
  })

  it('drops rows that are not whole, non-negative and finite', () => {
    const config = normalizeAnimationConfig({
      stateRows: { idle: 1.5, working: Number.NaN, waiting: -2, done: 3 },
    })
    expect(config.stateRows).toEqual({ done: 3 })
  })

  it('drops frame rates that are not positive and finite', () => {
    const config = normalizeAnimationConfig({
      stateFps: { idle: 0, working: -4, waiting: Number.NaN, done: 2 },
    })
    expect(config.stateFps).toEqual({ done: 2 })
  })

  it('replaces a corrupted map with the base instead of emptying every mapping', () => {
    // One bad value from an older or hand-edited config must not strip every state.
    const config = normalizeAnimationConfig({
      stateRows: ['nope'] as unknown as Record<string, number>,
      idleClips: 'nope' as unknown as number[],
    })
    expect(config.stateRows).toEqual(defaults.stateRows)
    expect(config.idleClips).toEqual(defaults.idleClips)
  })

  it('applies the same rules to the idle clip list', () => {
    const config = normalizeAnimationConfig({ idleClips: [0, 1.5, -1, Number.NaN, 4] })
    expect(config.idleClips).toEqual([0, 4])
  })

  it('keeps the idle interval at or above one second, and the five second default below it', () => {
    expect(normalizeAnimationConfig({ idleIntervalMs: 2500 }).idleIntervalMs).toBe(2500)
    // Upstream rejected an entry below one second (line 59).
    expect(normalizeAnimationConfig({ idleIntervalMs: 20 }).idleIntervalMs).toBe(
      DEFAULT_IDLE_INTERVAL_MS,
    )
    expect(normalizeAnimationConfig({ idleIntervalMs: Number.NaN }).idleIntervalMs).toBe(
      DEFAULT_IDLE_INTERVAL_MS,
    )
  })

  it('rejects an idle mode it does not know', () => {
    expect(normalizeAnimationConfig({ idleMode: 'random' }).idleMode).toBe('random')
    expect(normalizeAnimationConfig({ idleMode: 'sequential' }).idleMode).toBe('sequential')
    expect(normalizeAnimationConfig({ idleMode: 'loop' as 'random' }).idleMode).toBe('random')
  })

  it('falls back to the base for an unusable fallback row or rate', () => {
    const config = normalizeAnimationConfig({ fallbackRow: -1, fallbackFps: 0 })
    expect(config.fallbackRow).toBe(defaults.fallbackRow)
    expect(config.fallbackFps).toBe(defaults.fallbackFps)
  })

  it('merges over the current config, not over the defaults', () => {
    const current = normalizeAnimationConfig({ idleIntervalMs: 7000 })
    const next = normalizeAnimationConfig({ idleMode: 'sequential' }, current)
    expect(next.idleIntervalMs).toBe(7000)
    expect(next.idleMode).toBe('sequential')
  })
})

describe('IdlePlaylist', () => {
  const base: AnimationConfig = normalizeAnimationConfig({
    idleClips: [1, 3],
    idleMode: 'sequential',
    idleIntervalMs: 1000,
  })

  function playlist(
    overrides: Partial<AnimationConfig> = base,
    random: () => number = () => 0,
  ): IdlePlaylist {
    return new IdlePlaylist({ clock: browserClock, random, config: normalizeAnimationConfig(overrides, base) })
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is off until the mood is idle, and off again when it leaves', () => {
    const idle = playlist()
    expect(idle.row).toBeNull()
    vi.advanceTimersByTime(5000)
    expect(idle.row).toBeNull()

    idle.setActive(true)
    expect(idle.row).toBe(1)
    // Upstream showed the first clip as soon as cycling started (line 223).
    idle.setActive(false)
    expect(idle.row).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('walks the clips in order and wraps in sequential mode', () => {
    const idle = playlist()
    idle.setActive(true)
    expect(idle.row).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(idle.row).toBe(3)
    vi.advanceTimersByTime(1000)
    expect(idle.row).toBe(1)
  })

  it('picks a clip from the injected random source', () => {
    const low = playlist({ ...base, idleMode: 'random' }, () => 0)
    low.setActive(true)
    vi.advanceTimersByTime(1000)
    expect(low.row).toBe(1)

    const high = playlist({ ...base, idleMode: 'random' }, () => 0.99)
    high.setActive(true)
    vi.advanceTimersByTime(1000)
    expect(high.row).toBe(3)
  })

  it('clamps a random value that Math.random could not return', () => {
    // An injected source is not bound by `0 <= r < 1`, so 1 and NaN must not index past
    // the end of the clip list.
    const atOne = playlist({ ...base, idleMode: 'random' }, () => 1)
    atOne.setActive(true)
    vi.advanceTimersByTime(1000)
    expect(atOne.row).toBe(3)

    const notANumber = playlist({ ...base, idleMode: 'random' }, () => Number.NaN)
    notANumber.setActive(true)
    vi.advanceTimersByTime(1000)
    expect(notANumber.row).toBe(1)
  })

  it('does not restart when the same clips arrive as a new array', () => {
    // `setState("idle")` runs on a poll, so a restart on every call would pin the pet to
    // the first clip (upstream's guard, line 218).
    const idle = playlist()
    idle.setActive(true)
    vi.advanceTimersByTime(1000)
    expect(idle.row).toBe(3)
    const generation = idle.generation

    idle.setConfig(normalizeAnimationConfig({ idleClips: [1, 3] }, base))
    expect(idle.generation).toBe(generation)
    expect(idle.row).toBe(3)
  })

  it('restarts on the first clip when the playlist inputs change', () => {
    const idle = playlist()
    idle.setActive(true)
    vi.advanceTimersByTime(1000)
    idle.setConfig(normalizeAnimationConfig({ idleIntervalMs: 2000 }, base))
    expect(idle.row).toBe(1)
    // The new interval is what the next advance waits for.
    vi.advanceTimersByTime(1999)
    expect(idle.row).toBe(1)
    vi.advanceTimersByTime(1)
    expect(idle.row).toBe(3)
  })

  it('takes a mode change without restarting', () => {
    const idle = playlist()
    idle.setActive(true)
    idle.setConfig(normalizeAnimationConfig({ idleMode: 'random' }, base))
    expect(idle.row).toBe(1)
    // The mode is read when a clip advances, so it applies to the next one.
    vi.advanceTimersByTime(1000)
    expect(idle.row).toBe(1)
  })

  it('stays off with no clips configured, even while the mood is idle', () => {
    const idle = playlist({ ...base, idleClips: [] })
    idle.setActive(true)
    expect(idle.row).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops cycling and releases its timer', () => {
    const idle = playlist()
    idle.setActive(true)
    vi.advanceTimersByTime(1000)
    idle.stop()
    expect(idle.row).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(idle.row).toBeNull()
  })
})
