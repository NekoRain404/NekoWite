/**
 * The receiving half of §6.2's 点击返回任务: one channel, one key, one release — and one refusal.
 *
 * Four things are worth asserting and no more. The channel name is the one `tauri-pet.ts` declares,
 * because a second spelling is a click that raises a window and focuses nothing, and it is the kind
 * of pair only a test can hold together. What reaches the caller is the *key*, not the envelope the
 * host serialized. A payload that is not a key never reaches the caller at all — the consumer
 * focuses a session by it and the store accepts any string, so a half-key would quietly address a
 * session that does not exist and mark the one on screen unread behind it. And an unmount has
 * something to call: outside Tauri there is no listener to register, and the caller still gets a
 * release rather than a `null` it has to remember to guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listenMock = vi.hoisted(() => vi.fn())
const invokeMock = vi.hoisted(() => vi.fn().mockResolvedValue([]))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { onPetTaskRequest } from './pet-task-request'
import { PET_TASK_OPEN_CHANNEL } from './gateways/tauri-pet'
import type { PetTaskKey } from './gateways/pet-contracts'

/** The key the host mints for one run: `desktop_pet_open_task`'s payload, field for field. */
const KEY: PetTaskKey = {
  agentId: 'opencode',
  profileId: 'default',
  runtimeEpoch: 'epoch-1',
  vaultId: 'vault-a',
  sessionId: 'ses-1',
  runId: 'run-0',
}

/**
 * The listener the module registered, in a list rather than a `let` — a variable assigned inside
 * the mock's callback and read here is one control-flow analysis still sees as its initial value.
 */
function registered(): { delivered: Array<(event: { payload: unknown }) => void>; release: ReturnType<typeof vi.fn> } {
  const delivered: Array<(event: { payload: unknown }) => void> = []
  const release = vi.fn()
  listenMock.mockImplementation(async (_event: string, cb: (event: unknown) => void) => {
    delivered.push(cb)
    return release
  })
  return { delivered, release }
}

beforeEach(() => { invokeMock.mockResolvedValue([]) })

afterEach(() => {
  listenMock.mockReset()
  invokeMock.mockReset().mockResolvedValue([])
  vi.restoreAllMocks()
})

describe('the pet’s task request', () => {
  it('listens on the pet’s channel and hands over the key it carried', async () => {
    const { delivered, release } = registered()
    const seen: PetTaskKey[] = []

    const stop = await onPetTaskRequest((key) => seen.push(key))
    expect(listenMock.mock.calls[0]?.[0]).toBe(PET_TASK_OPEN_CHANNEL)
    expect(PET_TASK_OPEN_CHANNEL).toBe('pet-open-task')

    // The payload the host emits is D1's `PetTaskKey` and nothing else — no URL, no path, no
    // command (`commands/desktop_pet.rs`'s own doc) — so the caller is handed the key itself.
    invokeMock.mockResolvedValueOnce([KEY])
    delivered[0]?.({ payload: { ...KEY } })
    await vi.waitFor(() => expect(seen).toEqual([KEY]))

    stop()
    expect(release).toHaveBeenCalledOnce()
  })

  it('refuses a payload that is not a key, and focuses nothing with it', async () => {
    const { delivered } = registered()
    const refused = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: PetTaskKey[] = []

    await onPetTaskRequest((key) => seen.push(key))

    // A missing field, an empty one, a null and a bare string: each would stringify into a key no
    // session answers to, and the consumer's `focus` takes any string.
    // `delete` rather than rest-destructuring: this config keeps `no-unused-vars` at its default,
    // without `ignoreRestSiblings`, so the discarded binding is an error rather than an idiom.
    const withoutRun: Partial<PetTaskKey> = { ...KEY }
    delete withoutRun.runId
    for (const payload of [withoutRun, { ...KEY, sessionId: '' }, null, 'pet-open-task', 42]) {
      invokeMock.mockResolvedValueOnce([payload])
      delivered[0]?.({ payload })
    }

    expect(seen).toEqual([])
    await vi.waitFor(() => expect(refused).toHaveBeenCalledTimes(5))
    // Stated rather than swallowed: the host is the only producer of this channel, so a payload
    // that is not a key is a wire that drifted and not a user doing something odd.
    expect(String(refused.mock.calls[0]?.[0])).toContain(PET_TASK_OPEN_CHANNEL)
  })

  it('answers a window with no such channel with a release that does nothing', async () => {
    listenMock.mockImplementation(async () => {
      throw new Error('__TAURI_INTERNALS__ is not defined')
    })

    const stop = await onPetTaskRequest(() => {
      throw new Error('nothing can be delivered outside Tauri')
    })

    expect(() => stop()).not.toThrow()
  })
})
