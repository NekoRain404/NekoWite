import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureImageResolver,
  invalidateImageResolution,
  onImageResolutionInvalidated,
  resolveImageSrc,
} from './resolver'

afterEach(() => {
  configureImageResolver(null)
})

describe('resolveImageSrc caching', () => {
  it('memoises a successful resolution', async () => {
    const resolve = vi.fn(async () => 'data:image/png;base64,OK')
    configureImageResolver(resolve)
    await resolveImageSrc('a.png')
    await resolveImageSrc('a.png')
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('does NOT memoise a failure, so a later attempt can succeed', async () => {
    // A transient failure (the vault is not authorized yet, the file is still
    // being written) used to be cached, which made the first failure permanent
    // — the "images fail on open, Retry fixes it" report.
    let attempt = 0
    configureImageResolver(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('vault not ready')
      return 'data:image/png;base64,OK'
    })

    // The caller falls back to the raw src, which is not loadable.
    await expect(resolveImageSrc('a.png')).resolves.toBe('a.png')
    // The retry actually re-runs.
    await expect(resolveImageSrc('a.png')).resolves.toBe('data:image/png;base64,OK')
    expect(attempt).toBe(2)
  })

  it('resolves once a resolver is installed, after a resolver-less pass-through', async () => {
    // The panel can ask for a src before the app has wired a resolver at all.
    // That answer must not stick: installing the resolver has to take effect.
    await expect(resolveImageSrc('a.png')).resolves.toBe('a.png')
    configureImageResolver(async () => 'data:image/png;base64,OK')
    await expect(resolveImageSrc('a.png')).resolves.toBe('data:image/png;base64,OK')
  })

  it('refresh re-runs even a memoised success', async () => {
    const resolve = vi.fn(async () => 'data:image/png;base64,OK')
    configureImageResolver(resolve)
    await resolveImageSrc('a.png')
    await resolveImageSrc('a.png', { refresh: true })
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('never consults the resolver for a displayable src', async () => {
    const resolve = vi.fn(async () => 'x')
    configureImageResolver(resolve)
    await expect(resolveImageSrc('https://example.test/a.png')).resolves.toBe(
      'https://example.test/a.png',
    )
    await expect(resolveImageSrc('data:image/png;base64,AA')).resolves.toBe('data:image/png;base64,AA')
    expect(resolve).not.toHaveBeenCalled()
  })
})

describe('invalidateImageResolution', () => {
  it('drops the cache so the next call resolves again', async () => {
    const resolve = vi.fn(async () => 'data:image/png;base64,OK')
    configureImageResolver(resolve)
    await resolveImageSrc('a.png')
    invalidateImageResolution()
    await resolveImageSrc('a.png')
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('notifies subscribers so a mounted node view can re-resolve', () => {
    const listener = vi.fn()
    const off = onImageResolutionInvalidated(listener)
    invalidateImageResolution()
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    invalidateImageResolution()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps notifying the others when one subscriber throws', () => {
    const healthy = vi.fn()
    const offBad = onImageResolutionInvalidated(() => {
      throw new Error('torn down')
    })
    const offGood = onImageResolutionInvalidated(healthy)
    expect(() => invalidateImageResolution()).not.toThrow()
    expect(healthy).toHaveBeenCalledTimes(1)
    offBad()
    offGood()
  })

  it('is what re-configuring uses, so a vault switch cannot serve stale URLs', async () => {
    configureImageResolver(async () => 'data:image/png;base64,OLD')
    await resolveImageSrc('a.png')
    configureImageResolver(async () => 'data:image/png;base64,NEW')
    await expect(resolveImageSrc('a.png')).resolves.toBe('data:image/png;base64,NEW')
  })
})
