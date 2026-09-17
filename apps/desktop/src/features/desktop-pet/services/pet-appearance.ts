/**
 * The host's appearance read, as the props a sprite draws from (§5.1's 角色与动画).
 *
 * The pet window's half of the join the host made: `desktop_pet_appearance` answers which
 * character is chosen, where its sheet is, and the `character` domain's values as the store read
 * them — and this turns that into the four things `PetSprite` takes, or into the sentence a window
 * shows instead. Three fields ride every arm and none of them is the character's: `general.motion`,
 * `message.opacity` and `general.ballSize`, each read through its own field's rule below. Pure, and
 * deliberately so: no read, no subscription and no cache, because the window's own composable owns
 * when to ask and what to do when the answer changes.
 *
 * The field rules are *not* restated here, and there are none to restate: the host's store
 * validated the `character` domain when it read it (§5.3's 「界面和后端使用同一规则」), so what
 * arrives is a size inside its rule and a mapping whose rows are whole numbers. A window that
 * re-checked them would be the second rule; the only judgement made below is about *what to say*
 * when the host has nothing to draw.
 */
import {
  PET_NUMBER_RULES,
  PET_SETTINGS_DEFAULTS,
  petMotionOf,
  readPetNumber,
} from '../../../platform/gateways/pet-contracts'
import type { PetAppearance, PetBubbleDot, PetMotion } from '../../../platform/gateways/pet-contracts'
import type { AnimationConfig } from '../rendering/animation-bindings'
import type { PetBubbleTheme } from './pet-bubble-theme'
import { petBubbleThemeOf } from './pet-bubble-theme'
import type { PetBubbleLayoutInput } from './pet-bubble-layout'

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
  /**
   * The bubble's background alpha (`message.opacity`, §5.2's 气泡与消息).
   *
   * On every arm for the same reason `motion` is: the bubble is drawn by the window whether or not
   * a character is chosen — `DesktopPetRoot.vue` shows it above the notice — and a value that only
   * arrived with `Ready` would leave a fresh install's bubble at whatever this build's constant
   * said. Already inside its rule: the host's store validated the domain it came from (§5.3).
   */
  bubbleOpacity: number
  /**
   * The floating ball's diameter in CSS pixels (`general.ballSize`, §5.1's 悬浮球).
   *
   * On every arm for the reason the two above are: the ball is a window whether or not a character
   * is chosen, and upstream's plain orb is still an orb of some size. It is the one stored number
   * behind two drawn things — the orb this window paints and the window the host puts around it
   * (`ball.rs`'s `orb + 2 * BALL_MARGIN`) — so a window that drew it at anything else would be the
   * second answer §9 forbids. Already inside its rule: {@link petBallSizeOf} read it through the
   * schema's `general.ballSize` rule, which is the one the settings control and the store use
   * (§5.3), so no reader of this value has to judge it again.
   */
  ballSize: number
  /**
   * What the bubble shows and how (§5.2's 气泡与消息), from the `message` domain.
   *
   * On every arm for the reason {@link PetAppearanceView.bubbleOpacity} is: the bubble is drawn
   * above the notice and above a sprite alike, so a payload that only arrived with a chosen
   * character would leave a fresh install drawing the built-in layout for a user who chose another.
   */
  bubble: PetBubbleView
  /** What to say instead of drawing, or null when there is something to draw. */
  notice: string | null
}

/**
 * The bubble's content model, as `PetBubble` takes it: the layout, and the lines the user wrote.
 *
 * `layout` is `PetBubble`'s own prop, passed straight through — that component runs it through
 * `resolvePetBubbleLayout`, which is the one place a value is judged. The lines are **not** that
 * component's `phrases` prop: `phrases` is `PetMessagePhrases`, a line pool per agent and per state,
 * and `message` has no field of that shape. `message.quickBubbles` is one flat list of the user's
 * own lines, which is the pool `PetBubble`'s `line` prop is drawn from — see `usePetWindow` for
 * which one it picks.
 */
export interface PetBubbleView {
  /** `PetBubble`'s own `layout` prop, field for field. */
  layout: PetBubbleLayoutInput
  /**
   * The lines the user wrote (`message.quickBubbles`), in their own order.
   *
   * Named `lines` rather than `phrases` on purpose: `PetBubble`/`PetTaskList` already take a
   * `phrases` prop, that prop is `PetMessagePhrases` — a pool per agent and per state — and this
   * build's schema has no field of that shape. Two different things under one word is how a later
   * reader wires the wrong one.
   */
  lines: readonly string[]
  /** Whether the pet says anything at all when there is no task to speak of (`message.idle`). */
  idle: boolean
  /**
   * The bubble's own text size in px (`message.fontSize`).
   *
   * Already inside its rule, for the reason {@link PetAppearanceView.bubbleOpacity} is: it is read
   * through `PET_NUMBER_RULES['message.fontSize']`, which is the same rule the settings control is
   * bounded by and the store validates a write against (§5.3), so a window cannot draw text at a
   * size the store would have refused. The rows inside the bubble follow it, because upstream's
   * `--bubble-font-size` is set on the document root and everything under it inherits
   * (`references/desktop-pet/windows/src/main.ts:104`).
   */
  fontSize: number
  /**
   * Which style a row's state dot is drawn in (`message.dot`): upstream's `plain` disc or its
   * `claude` asterisk.
   *
   * The *member* and not a drawing: which glyph a row paints is `PetTaskRow.vue`'s, and the colours
   * it paints it in are the state tokens' — the setting chooses between two shapes and never
   * between two colours, which is what keeps a state from being readable only by its tint.
   */
  dot: PetBubbleDot
  /**
   * Which palette the bubble is drawn from (`message.theme`).
   *
   * On this model rather than on the window's own state because it is one of the domain's fields
   * and travels with the rest of them; the *page* is what acts on it (`usePetPageTheme`), because
   * a theme is a page-level choice — see `pet-bubble-theme.ts` for why there is no other way to
   * spell it.
   */
  theme: PetBubbleTheme
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
  // The other fact that is not the character's, read once for every arm: the bubble is drawn in all
  // of them, and `petBubbleOpacityOf` is where an answer that carries none becomes the schema's
  // default — the value this build's bubble was drawn with before the field existed.
  const bubbleOpacity = petBubbleOpacityOf(read)
  // And the bubble's content model, read once for every arm for the same reason: what the bubble
  // shows is not a property of the character either, and the surface is drawn in all three arms.
  const bubble = petBubbleViewOf(read)
  // And the ball's diameter, read once for the same reason: the orb is drawn in all three arms —
  // upstream's plain one where there is no character — so a size that only arrived with `ready`
  // would leave a fresh install's orb at whatever this build's constant said.
  const ballSize = petBallSizeOf(read)
  if (read.status === 'unset') {
    return {
      imageUrl: null,
      ...box(PET_SETTINGS_DEFAULTS.character.size),
      animation: {},
      motion,
      bubbleOpacity,
      bubble,
      ballSize,
      notice: 'No character is selected.',
    }
  }
  if (read.status === 'missing') {
    return {
      imageUrl: null,
      ...box(PET_SETTINGS_DEFAULTS.character.size),
      animation: {},
      motion,
      bubbleOpacity,
      bubble,
      ballSize,
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
    bubbleOpacity,
    bubble,
    ballSize,
    notice: null,
  }
}

/**
 * The bubble's background alpha a read carries, or the schema's default where it carries none.
 *
 * Through the schema's own rule and not a bound picked here (§5.3's 「界面和后端使用同一规则」): the
 * same `PET_NUMBER_RULES['message.opacity']` the store validates a write against, so a window
 * cannot draw an alpha the store would have refused. An absent field — a host from before this
 * read carried one, or a double — takes the rule's fallback, which is the value the bubble was
 * drawn with before the field existed; anything else the rule refuses is read the same way, which
 * is why the floor holds here too.
 *
 * Resolved beside the props it becomes rather than inside the contract, the way
 * `pet-bubble-layout.ts` resolves the bubble's other `message` fields: `pet-contracts/appearance.ts`
 * carries the wire shape, and what a value the wire does not carry *means* is the drawing side's.
 */
export function petBubbleOpacityOf(read: { bubbleOpacity?: unknown }): number {
  return readPetNumber(read.bubbleOpacity, PET_NUMBER_RULES['message.opacity'])
}

/**
 * The bubble's own text size a read carries, or the schema's default where it carries none.
 *
 * `petBubbleOpacityOf`'s arrangement one field over, and for its reason: the rule is
 * `PET_NUMBER_RULES['message.fontSize']` — upstream's three buttons are 10/12/14 and the rule keeps
 * that span — so the value a window draws text at is one the store would accept. An absent field
 * (a double, or a build from before the field existed) and a value outside the rule both take the
 * rule's fallback, which is the size the bubble was drawn at before the field existed.
 */
export function petBubbleFontSizeOf(read: { fontSize?: unknown } | Record<string, unknown>): number {
  return readPetNumber(read.fontSize, PET_NUMBER_RULES['message.fontSize'])
}

/**
 * The state-dot style a read carries, or the schema's default where it carries none.
 *
 * A member name and nothing else, for the reason {@link petBubbleThemeOf} gives one field over: the
 * members are the schema's, and a value that is not one of them is a word this build cannot draw —
 * which is the schema's default rather than a shape invented from a string nothing recognises.
 */
export function petBubbleDotOf(read: { dot?: unknown } | Record<string, unknown>): PetBubbleDot {
  return read.dot === 'claude' ? 'claude' : PET_SETTINGS_DEFAULTS.message.dot
}

/**
 * The bubble's content model a read carries, or the renderer's own defaults where it carries none.
 *
 * The layout is handed over **unread** — `PetBubble` is where `resolvePetBubbleLayout` runs, and it
 * is the one place each field is judged — so this function's whole job is the two fields that are
 * not layout, and the shape's default. That split is deliberate: a second reading here would be a
 * second answer to "which mode is this", and the two would only disagree about the values nobody
 * tests.
 *
 * An absent `bubble` is a real answer and not a wiring error: a double, or a host from before this
 * payload existed, carries none — and the renderer's own defaults are what this build's bubble was
 * drawn with until the field existed, which is the same arm `petBubbleOpacityOf` takes.
 */
export function petBubbleViewOf(read: { bubble?: unknown }): PetBubbleView {
  const wire = read.bubble
  if (typeof wire !== 'object' || wire === null) return PET_BUBBLE_VIEW_DEFAULTS
  const fields = wire as { phrases?: unknown; idle?: unknown } & Record<string, unknown>
  return {
    // Every layout field, whatever the wire spelled, and nothing else: `resolvePetBubbleLayout`
    // reads each through its own rule, so an extra key here is a key it ignores.
    layout: PET_BUBBLE_LAYOUT_FIELDS.reduce<PetBubbleLayoutInput>((layout, field) => {
      if (field in fields) layout[field] = fields[field]
      return layout
    }, {}),
    // The pool, and only strings: a member that is not a line is not a line the pet can say, and
    // one bad member must not take the list with it.
    lines: Array.isArray(fields.phrases)
      ? fields.phrases.filter((line): line is string => typeof line === 'string')
      : PET_BUBBLE_VIEW_DEFAULTS.lines,
    // A switch, so anything that is not `false` is on — the same reading the schema's default
    // takes, where `idle` is `true` and only an explicit `false` turns it off.
    idle: fields.idle !== false,
    fontSize: petBubbleFontSizeOf(fields),
    dot: petBubbleDotOf(fields),
    theme: petBubbleThemeOf(fields),
  }
}

/**
 * The layout's field names, as the wire spells them.
 *
 * One list, read off `PetBubbleLayoutInput`'s own keys by construction: the copy below is the
 * mapping from the wire to that type, and a field added to one without the other is what
 * `pet-appearance.test.ts` fails on.
 */
const PET_BUBBLE_LAYOUT_FIELDS = [
  'mode',
  'maxTasks',
  'grouping',
  'filter',
  'separator',
  'tokens',
] as const satisfies readonly (keyof PetBubbleLayoutInput)[]

/**
 * The model a window has before the host has answered, and the one an answer without it takes.
 *
 * Exported because `DesktopPetRoot` needs it too: a window with no host connection draws a bubble
 * (`v-if="drawing"` is false there, but the same component is mounted by tests with a gateway and
 * no connection), and a second literal in the root would be a second answer to what "no layout yet"
 * means.
 */
export const PET_BUBBLE_VIEW_DEFAULTS: PetBubbleView = {
  layout: {},
  lines: [],
  idle: true,
  fontSize: PET_SETTINGS_DEFAULTS.message.fontSize,
  dot: PET_SETTINGS_DEFAULTS.message.dot,
  theme: 'system',
}

/**
 * The floating ball's diameter a read carries, or the schema's default where it carries none.
 *
 * `petBubbleOpacityOf`'s arrangement one field over, and for its reason: the rule is
 * `PET_NUMBER_RULES['general.ballSize']` — the one the settings control is bounded by and the
 * store validates a write against — so a window cannot draw an orb the user could not have asked
 * for. An absent field (a double, or a build from before the field existed) and a value outside
 * the rule both take that rule's fallback, which is the diameter this build's ball was drawn at
 * before the field existed.
 *
 * The host reads the same stored number for the *window* around the orb (`ball.rs`), and the page
 * adds the same margin to it (`PetFloatingBall.vue`'s `props.size + BALL_MARGIN * 2`): this is the
 * one place the value is judged, so both readers judge it the same way.
 */
export function petBallSizeOf(read: { ballSize?: unknown }): number {
  return readPetNumber(read.ballSize, PET_NUMBER_RULES['general.ballSize'])
}

/** The sprite box for a size in CSS pixels, at the sheet's aspect. */
function box(size: number): { width: number; height: number } {
  return {
    width: size,
    height: Math.round((size * BASE_HEIGHT) / BASE_WIDTH),
  }
}
