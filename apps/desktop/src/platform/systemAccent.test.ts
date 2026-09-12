import { beforeEach, describe, expect, it, vi } from 'vitest'

// The adapter's whole job is to turn "the backend has no answer" into `null`
// rather than an exception, so the IPC call is mocked here and every failure
// shape is exercised on any machine instead of only where a registry exists.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

import { invoke } from '@tauri-apps/api/core'
import { readSystemAccentColor } from './systemAccent'

const mockedInvoke = vi.mocked(invoke)

describe('readSystemAccentColor', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('passes the colour the backend reported through unchanged', async () => {
    mockedInvoke.mockResolvedValue({ r: 0, g: 120, b: 212, source: 'explorer-accent-menu' } as never)
    await expect(readSystemAccentColor()).resolves.toEqual({
      r: 0,
      g: 120,
      b: 212,
      source: 'explorer-accent-menu',
    })
    expect(mockedInvoke).toHaveBeenCalledWith('system_accent_color')
  })

  it('answers null when the platform has no accent colour', async () => {
    mockedInvoke.mockResolvedValue(null as never)
    await expect(readSystemAccentColor()).resolves.toBeNull()
  })

  it('answers null when the command is missing or the read failed', async () => {
    // A browser build, a backend predating the command, and a registry the app
    // may not read all arrive here as a rejected invoke.
    mockedInvoke.mockRejectedValue(new Error('command not found') as never)
    await expect(readSystemAccentColor()).resolves.toBeNull()
  })

  it('refuses a payload that is not a colour', async () => {
    // Values outside 0..255 are not channels; mapping one would apply an accent
    // nobody asked for, so the read counts as unavailable instead.
    mockedInvoke.mockResolvedValue({ r: 300, g: -4, b: 12.5, source: 'x' } as never)
    await expect(readSystemAccentColor()).resolves.toBeNull()
  })
})
