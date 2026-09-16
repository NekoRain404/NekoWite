import { describe, expect, it, vi } from 'vitest'
import type { PetCapabilityReport, PetFallback, PetRoamMode } from '../../../platform/gateways/pet-contracts'
import { gateRoamMode } from './pet-mode-gate'
import { ROAM_BEHAVIOUR_BY_MODE } from './pet-motion-types'
import type { PetMotionPlatform } from './pet-platform'

/** A desktop that can do nothing unusual: no pointer, no window enumeration. */
function platform(overrides: Partial<PetMotionPlatform> = {}): PetMotionPlatform {
  return {
    async scaleFactor() {
      return 1
    },
    async readWindowPosition() {
      return { x: 0, y: 0 }
    },
    async moveWindow() {},
    async readWorkArea() {
      return { x: 0, y: 0, width: 1920, height: 1080 }
    },
    ...overrides,
  }
}

const pointer = { async readPointer() { return { x: 0, y: 0 } } }
const windows = { async readWindowRects() { return [] } }

function report(
  capability: 'pointer-follow' | 'window-climb',
  finding: PetCapabilityReport['finding'],
): PetCapabilityReport {
  return { capability, finding }
}

function unavailable(fallback: PetFallback, status: 'unavailable' | 'unverified' | 'degraded' = 'unavailable') {
  return { status, fallback, detail: 'this desktop does not provide it' } as const
}

/** The detail of a finding that had to state one — the arm §7.2 requires to be reachable. */
function statedDetail(finding: PetCapabilityReport['finding'] | null): string {
  if (!finding || finding.status === 'available') throw new Error('expected a stated fallback')
  return finding.detail
}

describe('gateRoamMode', () => {
  it('runs stay without asking any capability', () => {
    const gate = gateRoamMode('stay', [], platform())
    expect(gate).toEqual({ requested: 'stay', behaviour: 'stay', capability: null, finding: null })
  })

  it('says roaming is off for off', () => {
    const gate = gateRoamMode('off', [], platform())
    expect(gate).toEqual({ requested: 'off', behaviour: null, capability: null, finding: null })
  })

  it('reads a stored mode it does not know as roaming off', () => {
    // A corrupt settings record is D6's to refuse (§5.3); a value that got past it must not
    // crash the tick that reads it every 30 ms.
    const gate = gateRoamMode('sideways' as PetRoamMode, [], platform())
    expect(gate.behaviour).toBeNull()
  })

  it('has no stored mode that reaches wander', () => {
    // Upstream's default mode (`types.ts:108`), and the only one needing nothing from the
    // desktop. `PetRoamMode` has no value for it (`pet-contracts/config.ts:39`), so the ported
    // wander strategy cannot be selected by any setting: that is D1's gap to close, and this
    // test is the one that should fail first when it does.
    expect(Object.values(ROAM_BEHAVIOUR_BY_MODE)).not.toContain('wander')
  })

  it('runs follow-pointer where the capability was verified and the platform can do it', () => {
    const verified = report('pointer-follow', { status: 'available' })
    const gate = gateRoamMode('follow-pointer', [verified], platform(pointer))
    expect(gate.behaviour).toBe('follow-pointer')
    expect(gate.capability).toBe('pointer-follow')
    // The finding is passed through, not reworded.
    expect(gate.finding).toBe(verified.finding)
  })

  it('keeps stay and passes the finding on where the pointer cannot be followed', () => {
    const declared = report('pointer-follow', unavailable('stay-only'))
    const gate = gateRoamMode('follow-pointer', [declared], platform(pointer))
    expect(gate.behaviour).toBe('stay')
    expect(gate.finding).toBe(declared.finding)
  })

  it('keeps stay for climb, which Linux has no implementation for at all', () => {
    const declared = report('window-climb', unavailable('not-offered'))
    const gate = gateRoamMode('climb', [declared], platform(windows))
    expect(gate.behaviour).toBe('stay')
    expect(gate.finding?.fallback).toBe('not-offered')
  })

  it('keeps stay when a capability is only unverified', () => {
    // Nothing on a machine that has never been measured is available (§7.2, §12).
    const declared = report('pointer-follow', unavailable('stay-only', 'unverified'))
    expect(gateRoamMode('follow-pointer', [declared], platform(pointer)).behaviour).toBe('stay')
  })

  it('keeps stay when a capability is degraded', () => {
    const declared = report('pointer-follow', unavailable('stay-only', 'degraded'))
    expect(gateRoamMode('follow-pointer', [declared], platform(pointer)).behaviour).toBe('stay')
  })

  it('keeps stay when nothing was reported at all', () => {
    const gate = gateRoamMode('follow-pointer', [], platform(pointer))
    expect(gate.behaviour).toBe('stay')
    expect(gate.finding).toMatchObject({ status: 'unverified', fallback: 'stay-only' })
    expect(statedDetail(gate.finding)).toContain('pointer-follow')
  })

  it('keeps stay when the capability is claimed but nothing implements it', () => {
    // The report says what was verified; the platform says what exists. A host that claims one
    // it has nothing behind does not get to move the pet (§7.2 「不伪装已支持」).
    const gate = gateRoamMode('follow-pointer', [report('pointer-follow', { status: 'available' })], platform())
    expect(gate.behaviour).toBe('stay')
    expect(gate.finding).toMatchObject({ status: 'unavailable', fallback: 'stay-only' })
    expect(statedDetail(gate.finding)).toContain('no implementation')
  })

  it('keeps stay for climb claimed without an implementation', () => {
    const gate = gateRoamMode('climb', [report('window-climb', { status: 'available' })], platform())
    expect(gate.behaviour).toBe('stay')
    expect(gate.finding).toMatchObject({ status: 'unavailable', fallback: 'not-offered' })
  })

  it('never reaches for a capability the mode did not ask for', () => {
    const readPointer = vi.fn(async () => ({ x: 0, y: 0 }))
    const readWindowRects = vi.fn(async () => [])
    // `stay` consults nothing, and `wander` is not gated: both would be refused a pet that
    // could walk if a missing pointer stopped them.
    gateRoamMode('stay', [], platform({ readPointer, readWindowRects }))
    expect(readPointer).not.toHaveBeenCalled()
    expect(readWindowRects).not.toHaveBeenCalled()
  })
})
