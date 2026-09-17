/**
 * The character library: what the user has, what they called it, what they chose, and what a
 * catalogue may and may not do to any of it (§8's 角色库, and ledger §7.5's defect list).
 *
 * Ported from `references/desktop-pet/windows/src/catalog.ts` and the library half of
 * `windows/src/settings.ts`, at commit `be171a01273a1ed92a27bcdf72f8a58768bac421`:
 *
 *   - the selected slug and its three operations (`catalog.ts:33-46`)
 *   - the installed library (`catalog.ts:48-85`: `LibPet`, `getLibrary`, `addToLibrary`,
 *     `removeFromLibrary`, `libraryUrlForSlug`)
 *   - the per-slug name override and its 40-character cap (`catalog.ts:87-108`,
 *     `petDisplayName` / `renamePet`, whose rule that a name equal to the default clears the
 *     override is kept)
 *   - the delete that clears the selection rather than switching to another character
 *     (`settings.ts:391-406`, whose own comment is the rule: "so the main window falls back to
 *     the catalog default instead of silently switching to whatever happens to be library[0]")
 *   - the catalogue row's fields, licence included (`settings.ts:481-486`, `:560-570`)
 *
 * A pure module, like `pet-settings-policy.ts` and `pet-project-characters.ts` next door: state in,
 * state out, no storage, no IPC, no clock, no network, and no module-level mutable state — §11's
 * 「其他窗口无共享可变本地状态污染」 is answered by there being nothing here to share. Where the
 * files are, who reads them and who downloads anything are the host's questions; this module
 * decides *what the library is and what may be said about it*.
 *
 * The catalogue half — the states, the offers, the licence rule and what may be adopted — is
 * `./pet-catalogue`, split out on the same responsibility basis: this file is the library the user
 * *has*, and that one is the library a server *offers*.
 *
 * ## The defect this file exists to not repeat
 *
 * Upstream's `loadCatalog` catches its fetch error and returns `[]` (`catalog.ts:24-30`). An empty
 * list is a real state — a user who has adopted nothing — so that one return value makes "the
 * network is down", "the library is empty" and "the catalogue answered with nonsense" into one
 * indistinguishable answer, and the page then tells the user the wrong one of the three. Ledger
 * §7.5 records the fix as 「区分离线、空库、损坏、授权不明，保留已安装角色，禁止失败时重新下载覆盖」, and
 * each of those four clauses is a case below:
 *
 *  - **离线 / 空库 / 损坏** are three arms of {@link PetCatalogueState}, and the reading derived
 *    from them names which one it is. A library whose catalogue is unreachable still has its
 *    characters in it, and the notice says the catalogue was not reached rather than that nothing
 *    is installed.
 *  - **授权不明** is a catalogue offer whose terms were not stated. It is *shown*, it is
 *    installable, and {@link PetLibraryNotice} says what the catalogue left unsaid: §8's
 *    「不把下载成功当授权证明」 forbids this app from treating a successful download as permission,
 *    and it does not oblige it to refuse on the user's behalf. That ruling is the maintainer's and
 *    is deferred — see `pet-catalogue.ts`'s header for the whole of it.
 *  - **保留已安装角色 / 禁止失败时重新下载覆盖**: nothing in this module removes an installed
 *    character, and {@link planCharacterAdoption} refuses to adopt a slug that is already
 *    installed rather than fetching it again over the user's copy.
 *
 * ## The cache, at this level
 *
 * The host's installed set is the source of truth; the user's *choice* is a pointer into it that
 * can go stale, because a character can be removed in another window or from the library page
 * itself. A stale pointer is reported — {@link PetSelection} has a `missing` arm — and is never
 * resolved by picking another character: upstream clears the choice for exactly this reason, and
 * an app that quietly selected the first row would be showing the user a pet they did not choose.
 */

import { PET_CATALOGUE, statesTerms } from './pet-catalogue'
import type { PetCatalogueState } from './pet-catalogue'

/** What a character's files are, as the host read them (D8's `resources.rs` `EntryState`). */
export type PetCharacterFiles =
  /** Every file the host's manifest lists is there at the recorded size. */
  | 'intact'
  /** Something the host could not find, or found changed. It is still installed, and still the
   * user's; it may simply not be drawable. */
  | 'damaged'

/**
 * How a character came to be here.
 *
 * `remote` is a catalogue download. It is recorded rather than folded into `created` because the
 * deferred licence question is exactly the question "which of these came from a third party", and
 * a library that filed every download as one the user made could not answer it.
 */
export type PetCharacterKind = 'imported' | 'created' | 'remote'

/** One character the host has installed. What the *host* found, never what a catalogue said. */
export interface PetInstalledCharacter {
  characterId: string
  /** The name the pack carries, before any rename. What a cleared override falls back to. */
  packName: string
  kind: PetCharacterKind
  files: PetCharacterFiles
  /** When the host installed it, on the host's clock. Used only for the order the page shows. */
  installedAtMs: number
}

/** What the app holds about the library, as one value. */
export interface PetLibraryState {
  /**
   * The characters the host has installed.
   *
   * The only list there is: there is no separate index, and this module never adds to it or
   * removes from it on its own initiative. Its length is what "the library is empty" means.
   */
  installed: readonly PetInstalledCharacter[]
  /** The user's name overrides, by character id (upstream's `desktoppet.petNames`). */
  names: Readonly<Record<string, string>>
  /**
   * The character the user chose, or null for "no explicit choice" (upstream's
   * `desktoppet.petSlug`, whose `savedSlug()` returns null the same way). Null is a real value:
   * it is what a first run has, and what removing the chosen character leaves behind.
   */
  selectedId: string | null
}

/** The library a host that has never installed anything holds. */
export const NO_PET_LIBRARY: PetLibraryState = { installed: [], names: {}, selectedId: null }

/**
 * The rename cap, from upstream's `renamePet` (`catalog.ts:100-107`).
 *
 * Kept as an exported constant because the settings page has to draw the same limit it enforces,
 * and a page that offered a 60-character name and then quietly stored 40 would be the control that
 * disagrees with the rule.
 */
export const PET_CHARACTER_NAME_LIMIT = 40


/** A character as one row of the library page shows it. */
export interface PetLibraryRow {
  characterId: string
  /** The override the user set, else the pack's own name. Never empty. */
  name: string
  /** Whether that name is the user's, so a page can offer to clear it. */
  renamed: boolean
  kind: PetCharacterKind
  files: PetCharacterFiles
  /**
   * Whether the character can be drawn right now. A damaged one is still listed — it is the
   * user's, and hiding it would make a character that needs attention look like one that was
   * never there — and is offered with the reason instead of being selectable as if nothing were
   * wrong.
   */
  usable: boolean
  selected: boolean
}

/**
 * Which character the user chose, and whether it is still there.
 *
 * Three arms rather than a nullable id because the third is the one that would otherwise be
 * invisible: a choice that names a character the library no longer holds is a disagreement between
 * the pointer and its source, and it is reported rather than resolved (§11's 已删除会话 case, one
 * layer down).
 */
export type PetSelection =
  | { status: 'none' }
  | { status: 'chosen'; character: PetInstalledCharacter }
  | { status: 'missing'; characterId: string }

/**
 * Something the page has to say. A closed vocabulary, because a notice a page cannot
 * translate is a sentence nobody can read, and an empty list is a real answer.
 */
export type PetLibraryNotice =
  /** The library is empty and nothing is wrong with it. Not shown next to a catalogue failure. */
  | 'no-characters'
  /** One or more installed characters are not what the host wrote. Named by the rows. */
  | 'characters-damaged'
  /** The chosen character is not installed any more. The choice is kept; see {@link PetSelection}. */
  | 'selection-missing'
  /** A catalogue is configured and could not be reached, so the offers are not shown. */
  | 'catalogue-unreachable'
  /** A catalogue answered with something that is not a catalogue. */
  | 'catalogue-unreadable'
  /** No catalogue is configured. Stated, so a page does not draw a control that does nothing. */
  | 'catalogue-unconfigured'
  /** The catalogue offers nothing. */
  | 'catalogue-empty'
  /**
   * At least one offer states no terms. A *statement* and not a refusal: the offer is listed and
   * installable, and the page says what the catalogue left unsaid. See `pet-catalogue.ts`.
   */
  | 'offers-without-terms'

/** Everything the library page needs, derived in one pass. */
export interface PetLibraryReading {
  /**
   * Installed characters, newest first — where an import lands (upstream's `addToLibrary` puts the
   * new one at the front, `catalog.ts:74-79`), and what makes "the one I just added" findable.
   */
  characters: readonly PetLibraryRow[]
  selection: PetSelection
  catalogue: PetCatalogueState
  notices: readonly PetLibraryNotice[]
}

/** The name to show for a character: the user's, then the pack's. */
export function petCharacterName(state: PetLibraryState, characterId: string): string | null {
  const installed = state.installed.find((character) => character.characterId === characterId)
  if (installed === undefined) return null
  const override = state.names[characterId]
  return override !== undefined && override.trim().length > 0 ? override : installed.packName
}

/**
 * Rename a character, or clear the rename.
 *
 * Upstream's rule, kept whole (`catalog.ts:100-107`): the name is trimmed and capped, and a name
 * that is empty or equal to the pack's own is not stored at all — it *clears* the override, so the
 * character goes back to following its pack. That is what makes renaming reversible without a
 * second "reset name" control, and it is why the stored value is an override map rather than a
 * name field: a field would have to be rewritten whenever the pack it came from changed.
 *
 * Renaming a character that is not installed changes nothing: an override for a character nobody
 * has would be a name waiting to attach itself to whatever arrived next under that id.
 */
export function renamePetCharacter(
  state: PetLibraryState,
  characterId: string,
  name: string,
): PetLibraryState {
  const installed = state.installed.find((character) => character.characterId === characterId)
  if (installed === undefined) return state
  const trimmed = name.trim().slice(0, PET_CHARACTER_NAME_LIMIT)
  const names = { ...state.names }
  if (trimmed.length === 0 || trimmed === installed.packName) delete names[characterId]
  else names[characterId] = trimmed
  return { ...state, names }
}

/**
 * Choose a character, or clear the choice with null.
 *
 * A damaged character can be chosen — the user may be about to fix it, and refusing here would be
 * this module deciding something it cannot see — but a character that is not installed cannot, and
 * the refusal is expressed by returning the state unchanged rather than by storing an id nothing
 * can resolve.
 */
export function selectPetCharacter(state: PetLibraryState, characterId: string | null): PetLibraryState {
  if (characterId === null) {
    return state.selectedId === null ? state : { ...state, selectedId: null }
  }
  if (!state.installed.some((character) => character.characterId === characterId)) return state
  return state.selectedId === characterId ? state : { ...state, selectedId: characterId }
}

/** What a removal did, beyond the state to store. */
export interface PetCharacterRemoval {
  state: PetLibraryState
  /**
   * Whether the removed character was the chosen one — in which case the choice is now null rather
   * than pointing at the next row.
   *
   * Upstream's comment says why (`settings.ts:396-398`), and it is the user-visible half of the
   * rule: the app falls back to "no explicit choice" instead of to "whatever happens to be first",
   * so the pet that appears next is the one the app would pick for a new user rather than one the
   * user happens to have installed.
   */
  releasedSelection: boolean
}

/**
 * Remove a character. The user's explicit act, and the only removal this module performs.
 *
 * Removing one that is not installed returns the state unchanged with `releasedSelection: false`
 * rather than throwing: the operation is idempotent at this level, and the *host* is the one that
 * knows whether a directory was actually removed (D8's `resources.rs` refuses that with
 * `NotInstalled`, since a removal that succeeded for something that was not there would be a
 * success reported for nothing).
 *
 * The name override goes with the character. Keeping it would be a name waiting for the next pack
 * to arrive under the same id — the same hazard {@link renamePetCharacter} refuses.
 */
export function removePetCharacter(
  state: PetLibraryState,
  characterId: string,
): PetCharacterRemoval {
  const installed = state.installed.filter((character) => character.characterId !== characterId)
  if (installed.length === state.installed.length) {
    return { state, releasedSelection: false }
  }
  const names = { ...state.names }
  delete names[characterId]
  const releasedSelection = state.selectedId === characterId
  return {
    state: {
      installed,
      names,
      selectedId: releasedSelection ? null : state.selectedId,
    },
    releasedSelection,
  }
}

/**
 * The user's choice, with the disagreement named rather than resolved.
 */
export function petSelection(state: PetLibraryState): PetSelection {
  if (state.selectedId === null) return { status: 'none' }
  const character = state.installed.find((candidate) => candidate.characterId === state.selectedId)
  return character === undefined
    ? { status: 'missing', characterId: state.selectedId }
    : { status: 'chosen', character }
}

/**
 * Everything the library page shows, derived from the host's set and the catalogue's state.
 *
 * The order of the notices is the order a page draws them, and it is a priority: a chosen
 * character that has gone missing is about *this* app's state and comes before anything about a
 * catalogue, because the user can act on it without a network.
 */
export function readPetLibrary(
  state: PetLibraryState,
  catalogue: PetCatalogueState = PET_CATALOGUE,
): PetLibraryReading {
  const selection = petSelection(state)
  const characters: PetLibraryRow[] = [...state.installed]
    .sort((left, right) => right.installedAtMs - left.installedAtMs)
    .map((character) => {
      const override = state.names[character.characterId]
      const renamed = override !== undefined && override.trim().length > 0
      return {
        characterId: character.characterId,
        name: renamed ? override.trim() : character.packName,
        renamed,
        kind: character.kind,
        files: character.files,
        usable: character.files === 'intact',
        selected: state.selectedId === character.characterId,
      }
    })

  const notices: PetLibraryNotice[] = []
  // The three states the ledger's §7.5 asks be told apart, kept apart: "the library is empty" is
  // said only when the library is empty, never as a way of saying a catalogue failed.
  if (characters.length === 0) notices.push('no-characters')
  if (selection.status === 'missing') notices.push('selection-missing')
  if (characters.some((row) => !row.usable)) notices.push('characters-damaged')
  switch (catalogue.status) {
    case 'unconfigured':
      notices.push('catalogue-unconfigured')
      break
    case 'unreachable':
      notices.push('catalogue-unreachable')
      break
    case 'unreadable':
      notices.push('catalogue-unreadable')
      break
    case 'empty':
      notices.push('catalogue-empty')
      break
    case 'listed':
      // A *statement* and not a gate: an offer that states no terms is listed, is installable, and
      // the page says what the catalogue left unsaid. See `pet-catalogue.ts`'s header for why the
      // refusal this used to raise is gone.
      if (catalogue.offers.some((offer) => !statesTerms(offer))) {
        notices.push('offers-without-terms')
      }
      break
    case 'unasked':
      // Nobody has asked yet. Saying anything about the catalogue here would be a claim the app
      // cannot support before the read comes back — and one it would have to take back.
      break
  }

  return { characters, selection, catalogue, notices }
}

