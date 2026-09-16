/**
 * The receiving half of §5.1's 设置定位: one channel, one page, one release.
 *
 * Three things are worth asserting and no more. The channel name is the one `tauri-pet.ts`
 * declares — a second spelling here would be a right-click that raises a window and opens
 * nothing, and it is the kind of pair that only a test can hold together. What reaches the caller
 * is the *page*, not the envelope the host serialized. And an unmount has something to call:
 * outside Tauri there is no listener to register, and the caller still gets a release rather than
 * a `null` it has to remember to guard.
 */
import { describe, expect, it, vi } from 'vitest'

const listenMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { onPetSettingsRequest } from './pet-settings-request'
import { PET_SETTINGS_CHANNEL } from './gateways/tauri-pet'

describe('the pet’s settings request', () => {
  it('listens on the pet’s channel and hands over the page it named', async () => {
    let delivered: ((event: { payload: { page: string } }) => void) | null = null
    const release = vi.fn()
    listenMock.mockImplementation(async (_event: string, cb: (e: unknown) => void) => {
      delivered = cb as typeof delivered
      return release
    })
    const seen: string[] = []

    const stop = await onPetSettingsRequest((page) => seen.push(page))
    expect(listenMock.mock.calls[0]?.[0]).toBe(PET_SETTINGS_CHANNEL)
    expect(PET_SETTINGS_CHANNEL).toBe('pet-open-settings')

    // The payload the host emits is `{ page }` and nothing else (`commands/desktop_pet.rs`
    // validates the page against its own list before emitting), so the caller is handed the page
    // rather than the envelope.
    delivered?.({ payload: { page: 'care' } })
    expect(seen).toEqual(['care'])

    expect(stop).toBe(release)
  })

  it('answers a window with no such channel with a release that does nothing', async () => {
    listenMock.mockImplementation(async () => {
      throw new Error('__TAURI_INTERNALS__ is not defined')
    })

    const stop = await onPetSettingsRequest(() => {
      throw new Error('nothing can be delivered outside Tauri')
    })

    // The caller is a component that unmounts; the contract it needs is "you always got an
    // unsubscribe", which is the shape `onOpenFileRequest` settled.
    expect(() => stop()).not.toThrow()
  })
})
