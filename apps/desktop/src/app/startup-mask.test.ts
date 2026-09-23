import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStartupMaskController } from './startup-mask'

afterEach(() => vi.useRealTimers())

describe('startup mask', () => {
  it('waits at least one second after a fast startup', () => {
    vi.useFakeTimers()
    const hide = vi.fn()
    const mask = createStartupMaskController(hide)

    mask.start()
    mask.markReady()
    vi.advanceTimersByTime(999)
    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hide).toHaveBeenCalledOnce()
  })

  it('reveals the app after three seconds when startup stalls', () => {
    vi.useFakeTimers()
    const hide = vi.fn()
    const mask = createStartupMaskController(hide)

    mask.start()
    vi.advanceTimersByTime(2999)
    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hide).toHaveBeenCalledOnce()
  })
})
