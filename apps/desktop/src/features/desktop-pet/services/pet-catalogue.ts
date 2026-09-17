/**
 * The catalogue: what an online library offers, what may be done with one of its offers, and how a
 * page narrows four thousand rows to the one somebody wants.
 *
 * Split out of `pet-library-policy.ts` by responsibility (§13.1, and §13's 「400 行执行拆分」): that
 * file is the library the *user has*, this one is the library a *server offers*, and the two fail
 * differently — a library is wrong when its own files are wrong, a catalogue is wrong when a
 * network, a licence or a stranger's upload is. The dependency runs one way at runtime: the
 * library imports this file for its states, and this file imports the library's state as a type
 * only.
 *
 * **Nothing here makes a request.** The host reads the catalogue (§8's transfer rules live in
 * `desktop_pet/resources/remote.rs` and the socket is opened by exactly one file beside it); this
 * module is what those bytes *mean* to a page — the five states a read can be in, what may be done
 * with an offer, and the two pure helpers a gallery needs. Keeping it pure is what makes the whole
 * of browsing testable without a network.
 *
 * ## The licence, which is the maintainer's question and no longer this module's gate
 *
 * Every entry of every catalogue available today states no terms at all: 0 of 4,044 rows carry a
 * `license`, `author`, `credit` or `attribution` field, and the only credit-shaped one is
 * `submittedBy` — a byline, not a rights grant. This module used to *refuse* such an offer
 * (`licence-unknown`), and that refusal is gone: the maintainer's ruling is
 * 「许可我们最后解决，能接的全部接入」, and a gate that made all 4,044 offers un-adoptable would be
 * this code making that decision a second time after being overruled.
 *
 * What replaces the gate is not silence. {@link PetCatalogueOffer.terms} is carried, the row that
 * has none is *marked*, and the page says so — the user is told what the catalogue states and
 * decides for themselves. That is the difference between a decision this app makes for them and one
 * it hands back, and it is why the types below keep a field for terms they will almost always find
 * empty: the day an entry carries terms, the page shows them, and the day it does not, the page
 * still says that much.
 */

import type { PetLibraryState } from './pet-library-policy'

/** One character a catalogue offers, as the host read it. */
export interface PetCatalogueOffer {
  slug: string
  name: string
  /**
   * The catalogue's own byline for the entry (`submittedBy`). Free text, shown verbatim and never
   * parsed — it is what the catalogue states, and the page does not dress it up as permission.
   */
  author: string | null
  /**
   * The catalogue's own category word (`character`, `creature`, `object`, `asian`, `western`), or
   * null for an entry that states none. Free text for the same reason as {@link author}, and the
   * filter builds its choices from the values that are present rather than from a list here.
   */
  kind: string | null
  /**
   * The terms the catalogue stated, or null when it stated none.
   *
   * Null is **not** "public domain" and not "fine": it is "the catalogue did not say", which is a
   * fact about the catalogue and not a conclusion about the character. See this module's header.
   * Null is not a refusal either — the offer can be installed, and the row says what is missing.
   */
  terms: string | null
}

/**
 * What the catalogue is, in the states a page draws differently.
 *
 * `unconfigured` is a build with no endpoint at all — §8 puts an endpoint behind a reviewed change
 * (§10.1), so a build without one is a real build and this arm is its whole online story.
 * `unasked` is different and is **not** a claim about the network: it is a page that has not asked
 * yet. Before the read comes back, saying "no catalogue is configured" would be a statement the app
 * cannot support, and one it would then have to take back.
 *
 * The other four are what a read reports, and they exist because upstream's `loadCatalog` returns
 * `[]` on every failure (`catalog.ts:24-30`), which makes "offline", "empty" and "corrupt" one
 * value — ledger §7.5's recorded defect, and the reason a state invented later would be invented
 * under time pressure.
 */
export type PetCatalogueState =
  /** Nobody has asked yet. The initial value, and not an error. */
  | { status: 'unasked' }
  /** No catalogue endpoint is configured in this build. A statement, not an error. */
  | { status: 'unconfigured' }
  /** A catalogue is configured and this machine could not reach it. The library is unaffected. */
  | { status: 'unreachable'; detail: string }
  /** A configured catalogue answered with something that is not a catalogue. */
  | { status: 'unreadable'; detail: string }
  /** A configured catalogue answered, and nothing in it can be installed. */
  | { status: 'empty'; skipped: number }
  /** A configured catalogue answered with offers. */
  | { status: 'listed'; offers: readonly PetCatalogueOffer[]; skipped: number }

/** What a page holds about the catalogue before it has asked. Not a statement about the network. */
export const PET_CATALOGUE: PetCatalogueState = { status: 'unasked' }

/**
 * How many offers a page draws at once.
 *
 * The catalogue holds 4,044 rows, and a list that long is not a list — the reference filters and
 * searches for the same reason (`PetBrowser.swift:65-73`). This is a *display* bound and not a
 * data bound: the reading carries every offer, the filter searches all of them, and the page draws
 * the first {@link CATALOGUE_VISIBLE_LIMIT} matches with the count of the rest. Narrowing the
 * search is how the rest are reached, and the page says so rather than pretending they are not
 * there.
 */
export const CATALOGUE_VISIBLE_LIMIT = 60

/** Why a catalogue offer cannot be adopted. */
export type PetAdoptionRefusal =
  /** No catalogue is readable, so there is nothing to adopt from. */
  | 'no-catalogue'
  /** A catalogue is configured and could not be reached, or answered with nonsense. */
  | 'catalogue-unavailable'
  /** A character is already installed under that id. */
  | 'already-installed'

/** What adopting an offer would do, or why it will not. */
export type PetAdoptionPlan =
  | { status: 'planned'; slug: string; name: string }
  | { status: 'refused'; refusal: PetAdoptionRefusal; detail: string }

/**
 * Whether one catalogue offer may be adopted, and what that would fetch.
 *
 * Three refusals, and the last is §7.5's 「禁止失败时重新下载覆盖」: a slug that is already
 * installed is refused rather than fetched again onto the user's copy. Upstream's `addToLibrary`
 * de-duplicates by slug and moves the entry to the front (`catalog.ts:74-79`), so a second Get
 * replaces what the user has — the same defect as importing over an installed character, reached
 * from the network side, and D8's `resources.rs` refuses it there with `AlreadyInstalled`.
 *
 * The check is on the *id*, not on the name or the file: two catalogue rows with the same display
 * name are two characters, and a character the user renamed is still the one already installed.
 *
 * **There is deliberately no refusal for an offer that states no terms.** See this module's header:
 * that decision is the maintainer's and is deferred, and the page marks the row instead of
 * blocking it.
 */
export function planCharacterAdoption(
  state: PetLibraryState,
  catalogue: PetCatalogueState,
  offer: PetCatalogueOffer,
): PetAdoptionPlan {
  if (catalogue.status === 'unasked' || catalogue.status === 'unconfigured') {
    return {
      status: 'refused',
      refusal: 'no-catalogue',
      detail:
        catalogue.status === 'unasked'
          ? 'the catalogue has not been read yet; a pack can still be imported from the user’s own files'
          : 'no catalogue is configured in this build; a pack can still be imported from the user’s own files',
    }
  }
  if (catalogue.status !== 'listed' && catalogue.status !== 'empty') {
    return {
      status: 'refused',
      refusal: 'catalogue-unavailable',
      detail: `the catalogue could not be read (${catalogue.status}); installed characters are unaffected`,
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

/** The category words the offers actually use, in the order they are first seen. */
export function catalogueKinds(offers: readonly PetCatalogueOffer[]): readonly string[] {
  const kinds: string[] = []
  for (const offer of offers) {
    if (offer.kind !== null && !kinds.includes(offer.kind)) kinds.push(offer.kind)
  }
  return kinds
}

/**
 * The offers a page draws, for one search and one category.
 *
 * `kind` is null for "all": the words are the catalogue's own and "all" is not one of them, so
 * matching a category literally against null would be a category nobody can select. The search is
 * a lowercased substring of the name or the slug — the reference's rule
 * (`PetBrowser.swift:65-73`), kept because a user who half-remembers a name is the common case and
 * a prefix match would refuse them.
 *
 * A blank query is all offers, not none: an empty search box is the absence of a filter and not a
 * filter that matches nothing.
 */
export function filterCatalogueOffers(
  offers: readonly PetCatalogueOffer[],
  query: string,
  kind: string | null,
): readonly PetCatalogueOffer[] {
  const needle = query.trim().toLowerCase()
  return offers.filter((offer) => {
    if (kind !== null && offer.kind !== kind) return false
    if (needle.length === 0) return true
    return (
      offer.name.toLowerCase().includes(needle) || offer.slug.toLowerCase().includes(needle)
    )
  })
}

/**
 * Whether an offer states its terms, for the row that marks one that does not.
 *
 * A named function rather than `offer.terms === null` at the call site, because the two places
 * that ask — the row and the page's own note — have to give the same answer, and an inverted
 * comparison in one of them is a page that says "no terms" on a row that has them.
 */
export function statesTerms(offer: PetCatalogueOffer): boolean {
  return offer.terms !== null && offer.terms.trim().length > 0
}
