import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  configureImageResolver,
  isSelfDisplayableSrc,
  resolveImageSrc,
} from './resolver'

afterEach(() => {
  configureImageResolver(null)
})

describe('isSelfDisplayableSrc', () => {
  it('treats http(s), data, asset, blob and absolute paths as displayable', () => {
    expect(isSelfDisplayableSrc('https://x.dev/a.png')).toBe(true)
    expect(isSelfDisplayableSrc('http://x.dev/a.png')).toBe(true)
    expect(isSelfDisplayableSrc('data:image/png;base64,AAA')).toBe(true)
    expect(isSelfDisplayableSrc('asset://localhost/x.png')).toBe(true)
    expect(isSelfDisplayableSrc('blob:abc')).toBe(true)
    expect(isSelfDisplayableSrc('/root/img.png')).toBe(true)
  })

  it('treats relative vault/note paths as needing resolution', () => {
    expect(isSelfDisplayableSrc('attachments/2026-09/a.png')).toBe(false)
    expect(isSelfDisplayableSrc('../attachments/2026-09/a.png')).toBe(false)
    expect(isSelfDisplayableSrc('img.png')).toBe(false)
  })
})

describe('resolveImageSrc', () => {
  it('passes the src through untouched when no resolver is configured', async () => {
    await expect(resolveImageSrc('attachments/a.png')).resolves.toBe('attachments/a.png')
  })

  it('skips the resolver for already-displayable srcs', async () => {
    const resolve = vi.fn(async (src: string) => `resolved:${src}`)
    configureImageResolver(resolve)
    await expect(resolveImageSrc('https://x.dev/a.png')).resolves.toBe('https://x.dev/a.png')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('resolves relative srcs through the configured resolver', async () => {
    configureImageResolver(async (src) => `data:image/png;base64,${src}`)
    await expect(resolveImageSrc('attachments/a.png')).resolves.toBe(
      'data:image/png;base64,attachments/a.png',
    )
  })

  it('memoizes repeated srcs into one resolver call', async () => {
    const resolve = vi.fn(async (src: string) => `resolved:${src}`)
    configureImageResolver(resolve)
    const [a, b] = await Promise.all([
      resolveImageSrc('attachments/a.png'),
      resolveImageSrc('attachments/a.png'),
    ])
    expect(a).toBe('resolved:attachments/a.png')
    expect(b).toBe('resolved:attachments/a.png')
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('falls back to the raw src when the resolver rejects', async () => {
    configureImageResolver(async () => {
      throw new Error('boom')
    })
    await expect(resolveImageSrc('attachments/a.png')).resolves.toBe('attachments/a.png')
  })

  it('drops the cache when re-configured', async () => {
    const first = vi.fn(async (src: string) => `one:${src}`)
    configureImageResolver(first)
    await resolveImageSrc('attachments/a.png')
    const second = vi.fn(async (src: string) => `two:${src}`)
    configureImageResolver(second)
    await expect(resolveImageSrc('attachments/a.png')).resolves.toBe('two:attachments/a.png')
    expect(second).toHaveBeenCalledTimes(1)
  })
})
