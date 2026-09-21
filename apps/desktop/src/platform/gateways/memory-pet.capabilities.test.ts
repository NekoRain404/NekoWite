import { describe, expect, it } from 'vitest'
import { PET_CAPABILITIES } from './pet-contracts'
import { createMemoryPetGateway } from './memory-pet'

describe('the capabilities §7.2 requires to be stated rather than faked', () => {
  it('reports nothing as available on a host that has measured nothing', async () => {
    const pet = createMemoryPetGateway()
    const reports = await pet.capabilities()
    expect(reports.map((report) => report.capability).sort()).toEqual([...PET_CAPABILITIES].sort())
    for (const report of reports) {
      // §12 leaves the matrix to a later task, and "unverified" is not a synonym for
      // "unsupported": both would be a claim nobody has earned yet.
      expect(report.finding.status).toBe('unverified')
      if (report.finding.status === 'available') throw new Error('unreachable')
      expect(report.finding.fallback).not.toBe('none')
      expect(report.finding.detail.length).toBeGreaterThan(0)
    }
  })

  it('states what happens instead when a capability cannot be used', async () => {
    const pet = createMemoryPetGateway({
      capabilities: {
        'pointer-passthrough': {
          status: 'unavailable',
          fallback: 'compact-window',
          detail: 'this compositor does not support click-through',
        },
      },
    })
    const reports = await pet.capabilities()
    const passthrough = reports.find((report) => report.capability === 'pointer-passthrough')
    expect(passthrough?.finding).toEqual({
      status: 'unavailable',
      fallback: 'compact-window',
      detail: 'this compositor does not support click-through',
    })
    // The capability that needs the window list upstream implements for Windows only
    // (`sys_windows.rs:128-129`) is offered nowhere: §7.2 says not to copy Win32 and not
    // to pretend the feature works.
    const climb = reports.find((report) => report.capability === 'window-climb')
    expect(climb?.finding).toMatchObject({ fallback: 'not-offered' })
  })
})
