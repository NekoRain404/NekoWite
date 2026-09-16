/**
 * The catalogue: what an online library would be, and what may be done with one of its offers (§8).
 *
 * Split out of `pet-library-policy.ts` by responsibility (§13.1, and §13's 「400 行执行拆分」): that
 * file is the library the *user has*, this one is the library a *server offers*, and the two fail
 * differently — a library is wrong when its own files are wrong, a catalogue is wrong when a
 * network, a licence or a stranger's upload is. The dependency runs one way at runtime: the
 * library imports this file for its states, and this file imports the library's state as a type
 * only.
 *
 * **Nothing here makes a request, and in this build nothing calls it either.** §8 puts the online
 * catalogue behind its own sub-plan with 「明确端点与配置权限」 and requires only local mode until
 * the network identity, the terms of service, the asset licences and the data flow are settled — so
 * {@link PET_CATALOGUE} is `unconfigured`, and that is a statement the settings page draws rather
 * than a control it draws greyed out. The rest of the vocabulary is here because the ledger's §7.5
 * defect was precisely a missing vocabulary: upstream's `loadCatalog` returns `[]` on every
 * failure (`catalog.ts:24-30`), which makes "offline", "empty" and "corrupt" one state, and a state
 * that has to be invented later is one invented under time pressure.
 *
 * §8's licence rule is the one clause of this file that is enforced rather than described:
 * 「不把下载成功当授权证明」. An offer that states no terms is listed and cannot be adopted, and the
 * refusal says that rather than calling the offer invalid.
 */

import type { PetLibraryState } from './pet-library-policy'

/** Where a catalogue offer came from and on what terms (§8: 作者、来源、许可和再分发条件). */
export interface PetCatalogueLicence {
  author: string
  /** The terms as the catalogue states them. Free text, shown to the user and never parsed. */
  terms: string
}

/** One character a catalogue offers. */
export interface PetCatalogueOffer {
  slug: string
  name: string
  /**
   * The licence as the catalogue stated it, or null when it stated none.
   *
   * Null is not "public domain" and not "fine": §8 requires each pack's terms to be recorded, and a
   * catalogue that did not state them has left the app unable to say what the user would be
   * agreeing to. See {@link planCharacterAdoption}.
   */
  licence: PetCatalogueLicence | null
}

/**
 * What the catalogue is, in the five states §7.5 requires be told apart.
 *
 * `unconfigured` is this build's only reachable arm and is not a failure: §8 puts the online
 * catalogue behind its own sub-plan with 「明确端点与配置权限」, and until that is signed off
 * 「只交付本地模式」. The other four are here because they are what the endpoint will report the
 * day it exists, and because a vocabulary invented at that moment is one invented under time
 * pressure — which is how `[]` came to mean three things upstream.
 */
export type PetCatalogueState =
  /** No catalogue endpoint is configured. This build. A statement, not an error. */
  | { status: 'unconfigured' }
  /** A catalogue is configured and this machine could not reach it. The library is unaffected. */
  | { status: 'unreachable'; detail: string }
  /** A configured catalogue answered, and it offers nothing. */
  | { status: 'empty' }
  /** A configured catalogue answered with something that is not a catalogue. */
  | { status: 'unreadable'; detail: string }
  /** A configured catalogue answered with offers. */
  | { status: 'listed'; offers: readonly PetCatalogueOffer[] }

/** What this build has to say about the network, spelled once. */
export const PET_CATALOGUE: PetCatalogueState = { status: 'unconfigured' }

/** Why a catalogue offer cannot be adopted. */
export type PetAdoptionRefusal =
  /** No catalogue is configured, so there is nothing to adopt from. */
  | 'no-catalogue'
  /** A catalogue is configured and could not be reached, or answered with nonsense. */
  | 'catalogue-unavailable'
  /** The offer does not name a licence, so the app cannot say what the user would be agreeing to. */
  | 'licence-unknown'
  /** A character is already installed under that id. */
  | 'already-installed'

/** What adopting an offer would do, or why it will not. */
export type PetAdoptionPlan =
  | { status: 'planned'; slug: string; name: string }
  | { status: 'refused'; refusal: PetAdoptionRefusal; detail: string }

/**
 * Whether one catalogue offer may be adopted, and what that would fetch.
 *
 * Three refusals, and the third is §7.5's 「禁止失败时重新下载覆盖」: a slug that is already
 * installed is refused rather than fetched again onto the user's copy. Upstream's `addToLibrary`
 * de-duplicates by slug and moves the entry to the front (`catalog.ts:74-79`), so a second Get
 * replaces what the user has — which is the same defect as importing over an installed character,
 * reached from the network side, and D8's `resources.rs` refuses it there with `AlreadyInstalled`.
 *
 * The check is on the *id*, not on the name or the file: two catalogue rows with the same display
 * name are two characters, and a character the user renamed is still the one already installed.
 */
export function planCharacterAdoption(
  state: PetLibraryState,
  catalogue: PetCatalogueState,
  offer: PetCatalogueOffer,
): PetAdoptionPlan {
  if (catalogue.status === 'unconfigured') {
    return {
      status: 'refused',
      refusal: 'no-catalogue',
      detail:
        'no catalogue is configured in this build; a pack can still be imported from the user’s own files',
    }
  }
  if (catalogue.status !== 'listed' && catalogue.status !== 'empty') {
    return {
      status: 'refused',
      refusal: 'catalogue-unavailable',
      detail: `the catalogue could not be read (${catalogue.status}); installed characters are unaffected`,
    }
  }
  if (offer.licence === null) {
    return {
      status: 'refused',
      refusal: 'licence-unknown',
      detail:
        'the catalogue states no licence for this pack, and a download that succeeded is not a licence',
    }
  }
  if (state.installed.some((character) => character.characterId === offer.slug)) {
    return {
      status: 'refused',
      refusal: 'already-installed',
      detail: `${offer.slug} is already installed; it is the user’s copy, and adopting it again would replace it`,
    }
  }
  return { status: 'planned', slug: offer.slug, name: offer.name }
}
