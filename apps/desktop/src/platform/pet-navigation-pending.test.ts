import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: bridge.listen }))

import { onPetSettingsRequest } from './pet-settings-request'
import { onPetTaskRequest } from './pet-task-request'
import { onPetNavigation } from './pet-navigation-listener'

const key = {
  agentId: 'agent', profileId: 'profile', runtimeEpoch: 'epoch',
  vaultId: 'vault', sessionId: 'session', runId: 'run',
}

beforeEach(() => {
  vi.resetAllMocks()
  bridge.listen.mockResolvedValue(vi.fn())
})

describe('pet navigation before the main window mounts', () => {
  it('recovers settings after installing the listener', async () => {
    bridge.invoke.mockImplementation(async () => {
      expect(bridge.listen).toHaveBeenCalled()
      return [{ page: 'character' }]
    })
    const seen: string[] = []
    await onPetSettingsRequest((page) => seen.push(page))
    expect(seen).toEqual(['character'])
    expect(bridge.invoke).toHaveBeenCalledWith('desktop_pet_take_settings_requests')
  })

  it('recovers a task when the original event had no listener', async () => {
    bridge.invoke.mockResolvedValue([key])
    const seen: unknown[] = []
    await onPetTaskRequest((task) => seen.push(task))
    expect(seen).toEqual([key])
    expect(bridge.invoke).toHaveBeenCalledWith('desktop_pet_take_task_requests')
  })

  it('serializes a wakeup during initial consumption without replaying its event payload', async () => {
    let finish!: (value: unknown[]) => void
    bridge.invoke.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
      .mockResolvedValueOnce([{ page: 'care' }]).mockResolvedValue([])
    const seen: string[] = []
    const starting = onPetSettingsRequest((page) => seen.push(page))
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalledTimes(1))
    const wake = bridge.listen.mock.calls[0]?.[1] as (event: unknown) => void
    wake({ payload: { page: 'character' } })
    expect(bridge.invoke).toHaveBeenCalledTimes(1)
    finish([{ page: 'character' }])
    const stop = await starting
    await vi.waitFor(() => expect(seen).toEqual(['character', 'care']))
    wake({ payload: { page: 'care' } })
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalledTimes(3))
    expect(seen).toEqual(['character', 'care'])
    stop()
  })

  it('releases its listener and ignores queued wakeups after disposal', async () => {
    bridge.invoke.mockResolvedValue([])
    const release = vi.fn()
    bridge.listen.mockResolvedValue(release)
    const seen = vi.fn()
    const stop = await onPetNavigation('channel', 'take', seen)
    const wake = bridge.listen.mock.calls[0]?.[1] as () => void
    wake()
    stop()
    await Promise.resolve()
    expect(release).toHaveBeenCalledOnce()
    expect(bridge.invoke).toHaveBeenCalledTimes(1)
    expect(seen).not.toHaveBeenCalled()
  })

  it('reports failed consumption and accepts a later wakeup', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    bridge.invoke.mockRejectedValueOnce(new Error('temporarily unavailable'))
      .mockResolvedValueOnce([{ page: 'care' }])
    const seen: string[] = []
    const stop = await onPetSettingsRequest((page) => seen.push(page))
    expect(error).toHaveBeenCalledOnce()
    const wake = bridge.listen.mock.calls[0]?.[1] as () => void
    wake()
    await vi.waitFor(() => expect(seen).toEqual(['care']))
    stop()
    error.mockRestore()
  })
})
