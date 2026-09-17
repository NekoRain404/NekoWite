/**
 * The host's appearance read, as the props a sprite draws from (§5.1's 角色与动画).
 *
 * The pet window's half of the join the host made: `desktop_pet_appearance` answers which
 * character is chosen, where its sheet is, and the `character` domain's values as the store read
 * them — and this turns that into the four things `PetSprite` takes, or into the sentence a window
 * shows instead. Pure, and deliberately so: no read, no subscription and no cache, because the
 * window's own composable owns when to ask and what to do when the answer changes.
 *
 * The field rules are *not* restated here, and there are none to restate: the host's store
 * validated the `character` domain when it read it (§5.3's 「界面和后端使用同一规则」), so what
 * arrives is a size inside its rule and a mapping whose rows are whole numbers. A window that
 * re-checked them would be the second rule; the only judgement made below is about *what to say*
 * when the host has nothing to draw.
 */
import { PET_SETTINGS_DEFAULTS, petMotionOf } from '../../../platform/gateways/pet-contracts'
import type { PetAppearance, PetMotion } from '../../../platform/gateways/pet-contracts'
import type { AnimationConfig } from '../rendering/animation-bindings'

/**
 * What the window draws, or why it draws nothing.
 *
 * `notice` and `imageUrl` are not exclusive: a window that has a sheet still says nothing, and a
 * window with no sheet has nothing to say beyond the sentence. What is never true is one of them
 * being absent while the other is meaningless — every arm below sets exactly one of the two, and
 * the tests pin that.
 */
export interface PetAppearanceView {
  /** The spritesheet to draw, or null. The host's own URL: an `asset://` one from the adapter. */
  imageUrl: string | null
  /** Sprite box in CSS pixels, from `character.size`. */
  width: number
  height: number
  /** The animation mapping from settings, validated. */
  animation: Partial<AnimationConfig>
  /**
   * How far this window may move (`general.motion`, §5.2's 「跟随系统/应用设置」).
   *
   * On every arm, including the two that draw nothing: the ball is a window whether or not a
   * character is chosen, and it is the surface here that moves. What a window does with it is the
   * window's — the ball stops its own transitions and lets its CSS answer the system's own
   * preference — and the value is the stored policy rather than a decision, so a window that also
   * asks its engine keeps the two from being confused for one another.
   */
  motion: PetMotion
  /** What to say instead of drawing, or null when there is something to draw. */
  notice: string | null
}

/**
 * Upstream's sprite box at 100% (`PetSettingsPreview.vue`'s own figure): the size setting is the
 * width, and the height follows the sheet's aspect so a character never stretches.
 */
const BASE_WIDTH = 160
const BASE_HEIGHT = 180

/**
 * The host's read, as the sprite's props.
 *
 * Every arm is a state the window can draw, and none of them is a guess: `unset` is a sentence,
 * `missing` repeats the *host's* reason (the host knows whether the character was removed, whether
 * its files moved and whether they are not what the manifest recorded, and the window does not),
 * and a `ready` read whose stored values are unreadable falls back to the schema's defaults rather
 * than to nothing — a character with a corrupt size is still a character.
 */
export function petAppearanceView(read: PetAppearance): PetAppearanceView {
  // Read once for every arm: the policy is the window's, and a window that draws nothing still
  // moves (the ball's `unset` is a fresh install). `petMotionOf` is where an answer that carries
  // none becomes the schema's default, which is the reading of a value this build cannot act on.
  const motion = petMotionOf(read)
  if (read.status === 'unset') {
    return {
      imageUrl: null,
      ...box(PET_SETTINGS_DEFAULTS.character.size),
      animation: {},
      motion,
      notice: 'No character is selected.',
    }
  }
  if (read.status === 'missing') {
    return {
      imageUrl: null,
      ...box(PET_SETTINGS_DEFAULTS.character.size),
      animation: {},
      motion,
      notice: `The character "${read.characterId}" cannot be drawn: ${read.detail}.`,
    }
  }
  return {
    imageUrl: read.sheetPath,
    ...box(read.size),
    animation: {
      bindings: { ...read.bindings },
      idleClips: [...read.idleClips],
      idleMode: read.idleMode,
      idleIntervalMs: read.idleIntervalMs,
    },
    motion,
    notice: null,
  }
}

/** The sprite box for a size in CSS pixels, at the sheet's aspect. */
function box(size: number): { width: number; height: number } {
  return {
    width: size,
    height: Math.round((size * BASE_HEIGHT) / BASE_WIDTH),
  }
}
