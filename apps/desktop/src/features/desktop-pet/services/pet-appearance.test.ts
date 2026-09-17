/**
 * The motion policy as a window reads it (§5.2's 「跟随系统/应用设置」).
 *
 * The policy rides the appearance read because a pet window may not read a settings domain for
 * itself (`capabilities/desktop-pet.json` holds no `desktop_pet_read_settings`), so what this file
 * pins is the *reading* of that field on all three arms — and the two values it must never invent:
 * a policy that is absent, and one nothing recognises, are both this build's default rather than
 * `reduced`. Reading either as `reduced` would invent a restriction the user never asked for,
 * which is the one direction §5.2 forbids (the pet may reduce further than the system, never lift
 * a restriction — and an invented one is a change nobody chose).
 *
 * The end of the chain is asserted where it is visible: `pet-ball-window.test.ts` mounts the ball
 * against a host whose policy changes and looks at the orb's own class, and
 * `tests/desktop_pet_settings_test/motion.rs` asserts the same field out of a real store.
 */
import { describe, expect, it } from 'vitest'
import { petAppearanceView } from './pet-appearance'
import { PET_MOTION_DEFAULT, petMotionOf } from '../../../platform/gateways/pet-contracts'
import type { PetAppearance } from '../../../platform/gateways/pet-contracts'

/** One arm of the read, with the policy given or left off entirely. */
function read(status: 'unset' | 'missing' | 'ready', motion?: 'system' | 'reduced'): PetAppearance {
  const policy = motion === undefined ? {} : { motion }
  if (status === 'unset') return { status, ...policy }
  if (status === 'missing') return { status, characterId: 'torn', detail: 'its files are gone', ...policy }
  return {
    status,
    characterId: 'kitty',
    name: 'Kitty',
    sheetPath: 'asset://localhost/sheet.png',
    sheet: { columns: 8, rows: 9 },
    size: 160,
    bindings: {},
    idleClips: [],
    idleMode: 'random',
    idleIntervalMs: 5000,
    ...policy,
  }
}

describe('the motion policy a window is handed', () => {
  it('is the stored policy on every arm, including the two that draw no character', () => {
    // `unset` is a fresh install and the ball still draws there — the orb is the surface this
    // build has that moves, so a policy that only arrived with `ready` would leave a new user's
    // ball following nothing.
    for (const status of ['unset', 'missing', 'ready'] as const) {
      expect(petAppearanceView(read(status, 'reduced')).motion, status).toBe('reduced')
      expect(petAppearanceView(read(status, 'system')).motion, status).toBe('system')
    }
  })

  it('reads an absent policy and an unrecognised one as the schema default', () => {
    expect(PET_MOTION_DEFAULT).toBe('system')
    // Absent: the host always sends one (Rust's `Motion` is on every arm), so this is an answer
    // that did not come from this host — a double, or a build from before the field existed.
    expect(petMotionOf({})).toBe('system')
    expect(petAppearanceView(read('unset')).motion).toBe('system')
    // Unrecognised: the store normalizes members on the way out of the file, so a value no member
    // matches is one nothing wrote. It is not `reduced` — that is the reading that would invent a
    // restriction, and the one this case exists for.
    expect(petMotionOf({ motion: 'less' as 'system' })).toBe('system')
  })
})
