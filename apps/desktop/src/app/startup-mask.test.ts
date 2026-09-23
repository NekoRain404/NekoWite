import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStartupMaskController } from './startup-mask'

afterEach(() => vi.useRealTimers())

describe('startup mask', () => {
  it('keeps a short first-paint buffer after a fast startup', () => {
    vi.useFakeTimers()
    const hide = vi.fn()
    const mask = createStartupMaskController(hide, undefined, 450, 2500)

    mask.start()
    mask.markReady()
    vi.advanceTimersByTime(449)
    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hide).toHaveBeenCalledOnce()
  })

  it('reveals the app after three seconds when startup stalls', () => {
    vi.useFakeTimers()
    const hide = vi.fn()
    const mask = createStartupMaskController(hide, undefined, 450, 2500)

    mask.start()
    vi.advanceTimersByTime(2499)
    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hide).toHaveBeenCalledOnce()
  })
})
