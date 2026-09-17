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
import { petAppearanceView, petBubbleOpacityOf } from './pet-appearance'
import {
  PET_MOTION_DEFAULT,
  PET_NUMBER_RULES,
  PET_SETTINGS_DEFAULTS,
  petMotionOf,
} from '../../../platform/gateways/pet-contracts'
import type { PetAppearance } from '../../../platform/gateways/pet-contracts'

/** One arm of the read, with the policy and the bubble's alpha given or left off entirely. */
function read(
  status: 'unset' | 'missing' | 'ready',
  motion?: 'system' | 'reduced',
  bubbleOpacity?: number,
): PetAppearance {
  const policy = {
    ...(motion === undefined ? {} : { motion }),
    ...(bubbleOpacity === undefined ? {} : { bubbleOpacity }),
  }
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

/**
 * The bubble's background alpha, read the same way and for the same reason (§5.2's 气泡与消息).
 *
 * It is the value the settings page's slider writes, and before this read carried it the control
 * stored a number nothing acted on. What is pinned here is that it arrives on every arm — a window
 * with no character still draws the bubble — and that a value the rule refuses takes the schema's
 * default rather than being drawn anyway.
 */
describe('the bubble alpha a window is handed', () => {
  it('is the stored alpha on every arm, including the two that draw no character', () => {
    for (const status of ['unset', 'missing', 'ready'] as const) {
      expect(petAppearanceView(read(status, 'system', 0.7)).bubbleOpacity, status).toBe(0.7)
      expect(petAppearanceView(read(status, 'system', 1)).bubbleOpacity, status).toBe(1)
    }
  })

  it('reads an absent alpha, and one outside the rule, as the schema default', () => {
    // The rule is the schema's own, so this test cannot drift from what the store enforces.
    const rule = PET_NUMBER_RULES['message.opacity']
    expect(rule.fallback).toBe(PET_SETTINGS_DEFAULTS.message.opacity)

    // Absent: an answer that did not come from this host — a double, or a build from before the
    // field existed — is the value the bubble was drawn with before the field existed.
    expect(petBubbleOpacityOf({})).toBe(rule.fallback)
    expect(petAppearanceView(read('unset')).bubbleOpacity).toBe(rule.fallback)

    // Outside the rule: the floor exists so a stored value cannot leave a bubble whose text
    // cannot be read, and a window is not the place to make an exception to it.
    expect(petBubbleOpacityOf({ bubbleOpacity: rule.min - 0.01 })).toBe(rule.fallback)
    expect(petBubbleOpacityOf({ bubbleOpacity: rule.max + 0.01 })).toBe(rule.fallback)
    expect(petBubbleOpacityOf({ bubbleOpacity: '0.8' })).toBe(rule.fallback)
    // The ends themselves are inside it — a rule is a range, not an advisory.
    expect(petBubbleOpacityOf({ bubbleOpacity: rule.min })).toBe(rule.min)
    expect(petBubbleOpacityOf({ bubbleOpacity: rule.max })).toBe(rule.max)
  })
})
