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
 * The two fields that ride the same read for the same reason are pinned below it, each in the
 * shape of its own rule: `message.opacity` (§5.2's 气泡与消息) and `general.ballSize` (§5.1's
 * 悬浮球), both read through `PET_NUMBER_RULES` rather than through a bound written here.
 *
 * The end of the chain is asserted where it is visible: `pet-ball-window.test.ts` mounts the ball
 * against a host whose policy changes and looks at the orb's own class, and
 * `tests/desktop_pet_settings_test/motion.rs` asserts the same field out of a real store.
 */
import { describe, expect, it } from 'vitest'
import {
  petAppearanceView,
  petBallSizeOf,
  petBubbleOpacityOf,
  petBubbleViewOf,
} from './pet-appearance'
import {
  PET_MOTION_DEFAULT,
  PET_NUMBER_RULES,
  PET_SETTINGS_DEFAULTS,
  petMotionOf,
} from '../../../platform/gateways/pet-contracts'
import type { PetAppearance } from '../../../platform/gateways/pet-contracts'

/**
 * One arm of the read, with the facts that ride it given or left off entirely.
 *
 * Left off means *absent*, not `undefined`: a field the answer carries no member for is the arm
 * these readers exist for, and a helper that always set one would never produce it.
 */
function read(
  status: 'unset' | 'missing' | 'ready',
  carried: {
    motion?: 'system' | 'reduced'
    bubbleOpacity?: number
    ballSize?: number
    bubble?: Record<string, unknown>
  } = {},
): PetAppearance {
  const policy = {
    ...(carried.motion === undefined ? {} : { motion: carried.motion }),
    ...(carried.bubbleOpacity === undefined ? {} : { bubbleOpacity: carried.bubbleOpacity }),
    ...(carried.ballSize === undefined ? {} : { ballSize: carried.ballSize }),
    ...(carried.bubble === undefined ? {} : { bubble: carried.bubble }),
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
      expect(petAppearanceView(read(status, { motion: 'reduced' })).motion, status).toBe('reduced')
      expect(petAppearanceView(read(status, { motion: 'system' })).motion, status).toBe('system')
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
      expect(petAppearanceView(read(status, { bubbleOpacity: 0.7 })).bubbleOpacity, status).toBe(0.7)
      expect(petAppearanceView(read(status, { bubbleOpacity: 1 })).bubbleOpacity, status).toBe(1)
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

/**
 * The floating ball's diameter, read the same way and for the same reason (§5.1's 悬浮球).
 *
 * It is the one stored number behind two drawn things: the orb this window paints, and the window
 * the host puts around it (`ball.rs`'s `orb + 2 * BALL_MARGIN`, and the page's own
 * `props.size + BALL_MARGIN * 2`). What is pinned here is that it arrives on every arm — a plain
 * orb is still an orb of some size — and that a value the rule refuses takes the schema's default
 * rather than being drawn anyway, because a window that drew an out-of-rule orb would be drawing a
 * window the host did not size for it.
 */
describe('the ball size a window is handed', () => {
  it('is the stored diameter on every arm, including the two that draw no character', () => {
    for (const status of ['unset', 'missing', 'ready'] as const) {
      expect(petAppearanceView(read(status, { ballSize: 96 })).ballSize, status).toBe(96)
      // Both ends of the rule, which are inside it: a rule is a range, not an advisory.
      expect(
        petAppearanceView(read(status, { ballSize: PET_NUMBER_RULES['general.ballSize'].min }))
          .ballSize,
        status,
      ).toBe(PET_NUMBER_RULES['general.ballSize'].min)
    }
  })

  it('reads an absent diameter, and one outside the rule, as the schema default', () => {
    // The rule is the schema's own, so this test cannot drift from what the store enforces.
    const rule = PET_NUMBER_RULES['general.ballSize']
    expect(rule.fallback).toBe(PET_SETTINGS_DEFAULTS.general.ballSize)

    // Absent: an answer that did not come from this host — a double, or a build from before the
    // field existed — is the size this build's ball was drawn at before the field existed.
    expect(petBallSizeOf({})).toBe(rule.fallback)
    expect(petAppearanceView(read('unset')).ballSize).toBe(rule.fallback)

    // Outside the rule: a diameter outside the range is one the settings control cannot produce,
    // and the ceiling is what the window can grow to before it stops being a launcher in a corner.
    expect(petBallSizeOf({ ballSize: rule.min - 1 })).toBe(rule.fallback)
    expect(petBallSizeOf({ ballSize: rule.max + 1 })).toBe(rule.fallback)
    // The rule is integral: an orb half a pixel wide is a measurement, not a size.
    expect(petBallSizeOf({ ballSize: rule.min + 0.5 })).toBe(rule.fallback)
    expect(petBallSizeOf({ ballSize: '96' })).toBe(rule.fallback)
    // The ends themselves are inside it.
    expect(petBallSizeOf({ ballSize: rule.min })).toBe(rule.min)
    expect(petBallSizeOf({ ballSize: rule.max })).toBe(rule.max)
  })
})

describe('the bubble’s content model and layout, which the host reads for this window', () => {
  /**
   * **The defect this closes, as an assertion.** Every field below was stored by
   * 气泡与消息 and read by nothing that draws: `PetBubble` had taken a `layout` prop since it was
   * written, no product code passed one, and the page drew a paragraph saying so. The chain that
   * carries them is `desktop_pet_appearance`'s `message` payload →
   * {@link petBubbleViewOf} → `usePetWindow` → `DesktopPetRoot.vue` → `PetBubble.vue`, and this
   * case is the first hop of it.
   */
  it('hands the wire’s fields to the layout, unread', () => {
    // Unread on purpose: `PetBubble` runs the payload through `resolvePetBubbleLayout`, which is
    // the one place a value is judged, so the names cross unchanged and an unusable one is that
    // function's to replace. A second reading here would be a second answer to "which mode is
    // this".
    const view = petBubbleViewOf({
      bubble: {
        mode: 'compact',
        maxTasks: 3,
        grouping: 'flat',
        filter: 'attention',
        separator: 'arrow',
        tokens: [{ token: 'dot', visible: true }],
        phrases: ['先喝口水', '整理一下引用'],
        idle: false,
      },
    })
    expect(view.layout).toEqual({
      mode: 'compact',
      maxTasks: 3,
      grouping: 'flat',
      filter: 'attention',
      separator: 'arrow',
      tokens: [{ token: 'dot', visible: true }],
    })
    expect(view.lines).toEqual(['先喝口水', '整理一下引用'])
    expect(view.idle).toBe(false)
  })

  it('is the renderer’s own default where the answer carries none', () => {
    // Absent is a real answer and not a wiring error: a double, or a host from before this payload
    // existed. The bubble draws this build's own layout then — the one it drew before the field
    // existed — rather than nothing.
    const view = petBubbleViewOf({})
    expect(view.layout).toEqual({})
    expect(view.lines).toEqual([])
    // And the idle switch is *on*, which is the schema's own default (`message.idle` is `true`):
    // only an explicit `false` turns it off, so a payload that dropped the field cannot silently
    // stop the pet talking.
    expect(view.idle).toBe(true)
  })

  it('keeps only the lines that are lines, and nothing else from the wire', () => {
    // A member that is not a string is not a sentence the pet can say, and one bad member must not
    // take the list with it — the same field-by-field rule §5.3 gives a migrated record.
    const view = petBubbleViewOf({ bubble: { phrases: ['好', 7, null, '好的'] } })
    expect(view.lines).toEqual(['好', '好的'])
    // And a key the wire does not carry a layout field for is not one this reader invents: the
    // layout object holds the fields it knows and nothing else.
    expect(Object.keys(petBubbleViewOf({ bubble: { nonsense: 1 } }).layout)).toEqual([])
  })
})
