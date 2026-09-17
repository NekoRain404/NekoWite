/**
 * The character: what the library holds, and what the pet window draws from it.
 *
 * A part of `../pet-contracts` because it moves for its own reason: the tasks, the settings and
 * the capabilities are unchanged by a new way of installing a character, and this is the only
 * module that changes when the library grows one. It is one of the parts §9's tree divides
 * already — `resources.rs` and its siblings on the Rust side, `pet-library-policy.ts` on this
 * side — so what is here is the *wire* between them and not a second policy: the shapes a command
 * answers with, field for field.
 *
 * Nothing here is a second source of truth about a character. `readPetLibrary`
 * (`features/desktop-pet/services/pet-library-policy.ts`) is what turns these into rows, names,
 * selections and notices; this file only says what the host sends.
 */

/**
 * One installed character, as `desktop_pet_library` answers it.
 *
 * The library's own facts and nothing about the user's choice: which character is *selected* is a
 * settings value (`character.characterId`), and reporting it here as well would be two answers to
 * one question.
 */
export interface PetCharacterEntry {
  characterId: string
  /** The pack's own name, or the id when the directory carries no manifest the host wrote. */
  packName: string
  /**
   * How it came to be here. `remote` is a catalogue download, through §8's transfer rules —
   * recorded because a character that arrived over a network is the one the deferred licence
   * question is about, and a build that filed it as `created` could not answer it.
   */
  kind: 'imported' | 'created' | 'remote'
  /**
   * Whether the character can be drawn. `damaged` is not "not installed": the character is the
   * user's and is listed, and what a page says about it is a page's business.
   */
  files: 'intact' | 'damaged'
  /** The host's clock, in epoch ms. Used for the order a page shows them in, and nothing else. */
  installedAtMs: number
}

/**
 * How far the pet's windows may move, from `general.motion`.
 *
 * §5.2's reduce-motion rule: 「跟随系统/应用设置；桌宠可更保守，不能反向解除全局限制」 — the pet
 * follows the app's setting and the system's, may reduce further than either, and may never lift
 * one. There is no third member for the same reason the setting has none: an option that turned
 * motion *up* past the system's own preference is a setting that cancels an accessibility choice.
 *
 * The *stored policy* and not a decision. The system's own `prefers-reduced-motion` is a question
 * each window asks its own engine — the ball already answers it in CSS — so what a host reports
 * here is only what the user chose in the app. `reduced` therefore means "at least this much less
 * motion", never "exactly this much".
 */
export type PetMotion = 'system' | 'reduced'

/**
 * What a read that carries no policy means: the schema's own default for `general.motion`
 * (`PET_SETTINGS_DEFAULTS.general`), which is the value the windows were built with.
 */
export const PET_MOTION_DEFAULT: PetMotion = 'system'

/**
 * The policy a read carries, or the schema's default where it carries none.
 *
 * A reader rather than a field access, because "absent" and "a value nothing recognises" have to
 * be read the same way: the host always sends one (Rust's `Motion` is on every arm), so what
 * reaches the second arm is an answer that did not come from this host — a double, or a build
 * from before the field existed — and `system` is what this build was built with. Reading either
 * as `reduced` would invent a restriction the user never asked for.
 */
export function petMotionOf(read: { motion?: PetMotion }): PetMotion {
  return read.motion === 'reduced' ? 'reduced' : PET_MOTION_DEFAULT
}


/**
 * What the pet window draws, or why it draws nothing (`desktop_pet_appearance`).
 *
 * Three arms, and the two that draw nothing are deliberately not one: `unset` is a choice nobody
 * made, `missing` is a choice this build cannot honour — and a *read* that could not happen at all
 * is a rejected promise rather than a fourth arm, because it is the caller's failure to state
 * rather than a state of the character.
 *
 * **`motion` is on every arm, and it is not the character's.** It is `general`'s, and it rides
 * this read because a pet window may not read a settings domain for itself
 * (`capabilities/desktop-pet.json` holds no settings read) while the drawing and the policy are
 * what one frame needs together. Every arm, because `unset` is a fresh install: the ball draws
 * upstream's plain orb there, and the orb is a surface that moves.
 */
export type PetAppearance = {
  /** The window's motion policy, from `general.motion`. See {@link petMotionOf} for an absent one. */
  motion?: PetMotion
  /**
   * The bubble's background alpha, from `message.opacity`.
   *
   * A `message` field riding this read for the reason {@link PetMotion} gives: the bubble is one of
   * the surfaces in the window that draws the character, and `capabilities/desktop-pet.json` holds
   * no settings read, so the window cannot ask for the domain itself. Without it the control on
   * §5.2's 气泡与消息 page would store a number nothing acts on — which is the defect the field was
   * moved out of `view` to end.
   *
   * Optional, and read through the field's own rule by whoever draws it
   * (`features/desktop-pet/services/pet-appearance.ts`'s `petBubbleOpacityOf`, which uses
   * `PET_NUMBER_RULES['message.opacity']`): an answer from a host that does not carry it — or from
   * a double — is the schema's default rather than a guess.
   */
  bubbleOpacity?: number
} & (
  /** No character is chosen. */
  | { status: 'unset' }
  /** A character is chosen and cannot be produced, with the host's own reason. */
  | { status: 'missing'; characterId: string; detail: string }
  | {
      status: 'ready'
      characterId: string
      /** The pack's own name, for a sentence that has to name the character. */
      name: string
      /**
       * Where the spritesheet is, absolute. The command that answered this granted exactly this
       * file to `asset://`; turning it into a URL is `convertFileSrc`, in the adapter.
       */
      sheetPath: string
      /** The grid the pack was installed with — what the sprite slices the sheet on. */
      sheet: { columns: number; rows: number }
      /**
       * Rendered size in CSS pixels, and the animation mapping — the `character` domain's fields
       * a window draws with, already normalized by the host's store.
       *
       * Typed and narrowed here rather than sent as the domain's whole value map: the store is
       * where a stored value is validated (§5.3's 「界面和后端使用同一规则」), so a window that
       * re-checked these would be the second rule, and one that took a raw map would have to.
       */
      size: number
      /** Which sheet row each mood plays. */
      bindings: Readonly<Record<string, number>>
      /** The rows the idle mood cycles through, and how, and for how long each one stays. */
      idleClips: readonly number[]
      idleMode: 'random' | 'sequential'
      idleIntervalMs: number
    }
)

/**
 * Whether an answer is one of the three arms above.
 *
 * A check at the boundary and not a re-validation of the fields: the host's own store normalized
 * the values (§5.3), so what this refuses is an answer that is not an appearance *at all* — which
 * is a case with a real producer rather than a hypothetical one. The browser builds answer every
 * command their stub does not know with `undefined`, and a window that took that for an appearance
 * threw while rendering; the same defect reached the settings side through the capability report
 * (`DesktopPetSettings.vue` and `services/pet-capability-report.ts`).
 *
 * It lives in the contract because both sides of the wire need it — the adapter, before it converts
 * a path it may not have been given, and the window, before it draws — and `platform/` may not
 * reach into `features/` for it.
 */
export function isPetAppearance(value: unknown): value is PetAppearance {
  if (typeof value !== 'object' || value === null) return false
  const status = (value as { status?: unknown }).status
  return status === 'unset' || status === 'missing' || status === 'ready'
}

/**
 * One applied settings write, as a window that draws from settings hears about it.
 *
 * The domain and the revision and nothing else: a listener decides for itself whether it draws
 * from this domain, and carrying the values would make each subscriber a second copy of the
 * record §5.3 keeps in one place.
 */
export interface PetSettingsChange {
  domain: string
  revision: number
}
