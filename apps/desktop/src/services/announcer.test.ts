import { afterEach, describe, expect, it } from 'vitest'
import { announce, resetAnnouncer } from './announcer'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function liveRegion(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.nw-aria-live')
}

afterEach(() => {
  resetAnnouncer()
  document.body.innerHTML = ''
})

describe('announcer (aria-live)', () => {
  it('creates a hidden role=status live region on first announce', async () => {
    announce('Saved')
    await flush()
    const el = liveRegion()
    expect(el).toBeTruthy()
    expect(el?.getAttribute('role')).toBe('status')
    expect(el?.getAttribute('aria-live')).toBe('polite')
    expect(el?.getAttribute('aria-atomic')).toBe('true')
  })

  it('publishes the message text to the live region', async () => {
    announce('Saved')
    await flush()
    expect(liveRegion()?.textContent).toBe('Saved')
  })

  it('re-announces an identical message (reset + set on a later tick)', async () => {
    announce('Saved')
    await flush()
    // The clear happens synchronously, the re-set on the next macrotask.
    announce('Saved')
    expect(liveRegion()?.textContent).toBe('')
    await flush()
    expect(liveRegion()?.textContent).toBe('Saved')
  })

  it('honors the assertive option for urgent status', async () => {
    announce('Something went wrong', { assertive: true })
    await flush()
    expect(liveRegion()?.getAttribute('aria-live')).toBe('assertive')
  })

  it('switches to polite after an assertive message', async () => {
    announce('Error', { assertive: true })
    await flush()
    announce('Saved')
    await flush()
    expect(liveRegion()?.getAttribute('aria-live')).toBe('polite')
  })

  it('is a no-op without a message and survives reset', async () => {
    announce('')
    await flush()
    expect(liveRegion()).toBeNull()

    announce('First')
    await flush()
    announce('Second')
    await flush()
    expect(liveRegion()?.textContent).toBe('Second')

    resetAnnouncer()
    expect(liveRegion()).toBeNull()
  })
})
