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
  kind: 'imported' | 'created'
  /**
   * Whether the character can be drawn. `damaged` is not "not installed": the character is the
   * user's and is listed, and what a page says about it is a page's business.
   */
  files: 'intact' | 'damaged'
  /** The host's clock, in epoch ms. Used for the order a page shows them in, and nothing else. */
  installedAtMs: number
}

/**
 * What the pet window draws, or why it draws nothing (`desktop_pet_appearance`).
 *
 * Three arms, and the two that draw nothing are deliberately not one: `unset` is a choice nobody
 * made, `missing` is a choice this build cannot honour — and a *read* that could not happen at all
 * is a rejected promise rather than a fourth arm, because it is the caller's failure to state
 * rather than a state of the character.
 */
export type PetAppearance =
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
