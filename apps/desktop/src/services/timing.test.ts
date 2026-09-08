import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { debounce, rafThrottle } from './timing'

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces a burst into a single trailing call with the latest args', () => {
    const fn = vi.fn()
    const h = debounce<[number]>(fn, 100)

    h.run(1)
    h.run(2)
    h.run(3)
    expect(fn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(99)
    expect(fn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(3)
  })

  it('re-arms instead of firing after a gap shorter than the delay', () => {
    const fn = vi.fn()
    const h = debounce<[number]>(fn, 100)

    h.run(1)
    vi.advanceTimersByTime(80)
    h.run(2)
    vi.advanceTimersByTime(80)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(2)
  })

  it('cancel drops a pending invocation', () => {
    const fn = vi.fn()
    const h = debounce<[number]>(fn, 100)

    h.run(1)
    h.cancel()
    vi.advanceTimersByTime(200)
    expect(fn).not.toHaveBeenCalled()
  })

  it('flush executes a pending invocation immediately', () => {
    const fn = vi.fn()
    const h = debounce<[number]>(fn, 100)

    h.run(42)
    h.flush()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(42)

    // Flushed work must not fire again on the original timer.
    vi.advanceTimersByTime(200)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('rafThrottle', () => {
  let frameCb: (() => void) | null = null

  beforeEach(() => {
    frameCb = null
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      frameCb = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
      frameCb = null
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('coalesces multiple calls within a frame into one execution', () => {
    const fn = vi.fn()
    const h = rafThrottle<[number]>(fn)

    h.run(1)
    h.run(2)
    h.run(3)
    expect(fn).not.toHaveBeenCalled()
    expect(frameCb).toBeTruthy()

    frameCb!()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(3)
  })

  it('schedules again on the next frame after an execution', () => {
    const fn = vi.fn()
    const h = rafThrottle<[number]>(fn)

    h.run(1)
    frameCb!()
    expect(fn).toHaveBeenCalledTimes(1)

    frameCb = null
    h.run(2)
    expect(frameCb).toBeTruthy()
  })

  it('flush runs a pending call without waiting for the frame', () => {
    const fn = vi.fn()
    const h = rafThrottle<[number]>(fn)

    h.run('x' as unknown as number)
    h.flush()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('x')

    // The cancelled frame must not execute a second time.
    const pending = frameCb
    frameCb = null
    pending?.()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
