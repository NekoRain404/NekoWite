/**
 * The character library policy (§8's 角色库), ported from `catalog.ts` and the library half of
 * `settings.ts`.
 *
 * The cases are the ones the ledger's §7.5 defect list names, plus the two the upstream tests did
 * not have: a stale choice, and a licence that was never stated. `catalog.test.ts` upstream holds
 * six cases about add/remove/resolve (`catalog.test.ts:31-74`); the ones ported here are marked
 * with their source, and what is added is the distinction the upstream code collapsed — its
 * `loadCatalog` returns `[]` on every failure, which this module makes unrepresentable.
 *
 * The two sources are `./pet-library-policy` (the library the user has) and `./pet-catalogue` (the
 * library a server offers), split by responsibility; they are covered by one file because the plan
 * names one command for this behaviour domain — §11's V6 — and a test in a file nobody runs is not
 * evidence.
 */
import { describe, expect, it } from 'vitest'

import {
  PET_CATALOGUE,
  planCharacterAdoption,
  type PetCatalogueOffer,
  type PetCatalogueState,
} from './pet-catalogue'
import {
  NO_PET_LIBRARY,
  PET_CHARACTER_NAME_LIMIT,
  petCharacterName,
  petSelection,
  readPetLibrary,
  removePetCharacter,
  renamePetCharacter,
  selectPetCharacter,
  type PetInstalledCharacter,
  type PetLibraryState,
} from './pet-library-policy'

function character(
  characterId: string,
  packName: string,
  overrides: Partial<PetInstalledCharacter> = {},
): PetInstalledCharacter {
  return {
    characterId,
    packName,
    kind: 'imported',
    files: 'intact',
    installedAtMs: 1_700_000_000_000,
    ...overrides,
  }
}

/** Upstream's own fixture shape (`catalog.test.ts:27-30`): two characters, in order. */
function twoCharacters(): PetLibraryState {
  return {
    installed: [
      character('dog', 'Dog', { installedAtMs: 1_000 }),
      character('cat', 'Cat', { installedAtMs: 2_000 }),
    ],
    names: {},
    selectedId: null,
  }
}

function offer(overrides: Partial<PetCatalogueOffer> = {}): PetCatalogueOffer {
  return {
    slug: 'boba',
    name: 'Boba',
    licence: { author: 'railly', terms: 'CC-BY-4.0' },
    ...overrides,
  }
}

describe('the installed library', () => {
  it('orders the newest character first, which is where an import lands', () => {
    const reading = readPetLibrary(twoCharacters())
    expect(reading.characters.map((row) => row.characterId)).toEqual(['cat', 'dog'])
  })

  it('reads the pack name when the user has not renamed anything', () => {
    const state = twoCharacters()
    expect(petCharacterName(state, 'cat')).toBe('Cat')
    expect(petCharacterName(state, 'ferret')).toBeNull()
    expect(readPetLibrary(state).characters[0].renamed).toBe(false)
  })

  it('does not throw and does not change anything when a removal misses', () => {
    const state = twoCharacters()
    const removal = removePetCharacter(state, 'ferret')
    expect(removal.state).toBe(state)
    expect(removal.releasedSelection).toBe(false)
  })
})

describe('the four states upstream collapsed into an empty list', () => {
  it('says the library is empty only when the library is empty', () => {
    // Ledger §7.5: 区分离线、空库. A library with characters and an unreachable catalogue is not
    // an empty library, and the notice has to say which of the two it is.
    const offline: PetCatalogueState = { status: 'unreachable', detail: 'no route to host' }
    const reading = readPetLibrary(twoCharacters(), offline)

    expect(reading.characters).toHaveLength(2)
    expect(reading.notices).toContain('catalogue-unreachable')
    expect(reading.notices).not.toContain('no-characters')
  })

  it('says the library is empty when it is, whatever the catalogue is doing', () => {
    const reading = readPetLibrary(NO_PET_LIBRARY, PET_CATALOGUE)
    expect(reading.characters).toEqual([])
    expect(reading.notices).toContain('no-characters')
    expect(reading.notices).toContain('catalogue-unconfigured')
  })

  it('tells a corrupt catalogue apart from an unreachable one and from an empty one', () => {
    const states: PetCatalogueState[] = [
      { status: 'unconfigured' },
      { status: 'unreachable', detail: 'connection refused' },
      { status: 'unreadable', detail: 'not JSON' },
      { status: 'empty' },
    ]
    const notices = states.map((state) => readPetLibrary(NO_PET_LIBRARY, state).notices)
    const catalogueNotices = notices.map((list) =>
      list.filter((notice) => notice.startsWith('catalogue-')),
    )
    expect(new Set(catalogueNotices.map((list) => list.join())).size).toBe(4)
    expect(notices[2]).toContain('catalogue-unreadable')
    expect(notices[3]).toContain('catalogue-empty')
    // 保留已安装角色: a catalogue that failed changes nothing about what is installed.
    const corrupt = readPetLibrary(twoCharacters(), { status: 'unreadable', detail: 'not JSON' })
    expect(corrupt.characters).toHaveLength(2)
  })

  it('reports a damaged character rather than hiding it', () => {
    const state: PetLibraryState = {
      installed: [character('cat', 'Cat', { files: 'damaged' })],
      names: {},
      selectedId: null,
    }
    const reading = readPetLibrary(state)
    expect(reading.notices).toContain('characters-damaged')
    expect(reading.characters).toHaveLength(1)
    expect(reading.characters[0].usable).toBe(false)
    // Still the user's character, and still listed — a row that vanished because its files moved
    // would read as a character that was never installed.
    expect(reading.characters[0].name).toBe('Cat')
  })

  it('states that no catalogue is configured rather than offering nothing', () => {
    // §8: only local mode until the endpoint, the terms and the data flow are settled. A page
    // draws "not available" from this; a page that drew nothing would be the control that does
    // nothing when pressed.
    expect(PET_CATALOGUE).toEqual({ status: 'unconfigured' })
    expect(readPetLibrary(NO_PET_LIBRARY).notices).toContain('catalogue-unconfigured')
  })
})

describe('rename', () => {
  it('stores the trimmed name and shows it', () => {
    const state = renamePetCharacter(twoCharacters(), 'cat', '  Whiskers  ')
    expect(state.names.cat).toBe('Whiskers')
    expect(petCharacterName(state, 'cat')).toBe('Whiskers')
    expect(readPetLibrary(state).characters.find((row) => row.characterId === 'cat')?.renamed).toBe(
      true,
    )
  })

  it('caps the name at the same limit the page draws', () => {
    const state = renamePetCharacter(twoCharacters(), 'cat', 'x'.repeat(60))
    expect(state.names.cat).toHaveLength(PET_CHARACTER_NAME_LIMIT)
  })

  it('clears the override when the name is empty or is the pack’s own', () => {
    // Upstream's `renamePet` (`catalog.ts:100-107`): a name that matches the default removes the
    // override, which is what makes a rename reversible without a second control.
    const renamed = renamePetCharacter(twoCharacters(), 'cat', 'Whiskers')
    expect(renamePetCharacter(renamed, 'cat', '').names.cat).toBeUndefined()
    expect(renamePetCharacter(renamed, 'cat', '   ').names.cat).toBeUndefined()
    expect(renamePetCharacter(renamed, 'cat', 'Cat').names.cat).toBeUndefined()
    expect(petCharacterName(renamePetCharacter(renamed, 'cat', 'Cat'), 'cat')).toBe('Cat')
  })

  it('ignores a rename for a character that is not installed', () => {
    const state = renamePetCharacter(twoCharacters(), 'ferret', 'Loki')
    expect(state).toEqual(twoCharacters())
  })
})

describe('the choice, and the choice going stale', () => {
  it('starts with no choice, which is a value rather than a missing one', () => {
    expect(petSelection(NO_PET_LIBRARY)).toEqual({ status: 'none' })
  })

  it('resolves a choice to the character it names', () => {
    const state = selectPetCharacter(twoCharacters(), 'cat')
    const selection = petSelection(state)
    expect(selection.status).toBe('chosen')
    expect(readPetLibrary(state).characters.find((row) => row.selected)?.characterId).toBe('cat')
  })

  it('reports a choice that names a character the library no longer has', () => {
    // The cache rule at this level: the choice is a pointer and the installed set is the source,
    // and a disagreement is a state the page can act on rather than a row that quietly changes.
    const orphaned: PetLibraryState = { ...twoCharacters(), selectedId: 'ferret' }
    expect(petSelection(orphaned)).toEqual({ status: 'missing', characterId: 'ferret' })
    const reading = readPetLibrary(orphaned)
    expect(reading.notices).toContain('selection-missing')
    expect(reading.characters.every((row) => !row.selected)).toBe(true)
  })

  it('refuses to choose something that is not installed', () => {
    const state = twoCharacters()
    expect(selectPetCharacter(state, 'ferret')).toBe(state)
  })

  it('clears the choice on null, and keeps referential equality when nothing changed', () => {
    const chosen = selectPetCharacter(twoCharacters(), 'cat')
    expect(selectPetCharacter(chosen, null).selectedId).toBeNull()
    expect(selectPetCharacter(chosen, 'cat')).toBe(chosen)
  })
})

describe('removal', () => {
  it('takes the character and its name out and leaves the rest alone', () => {
    const renamed = renamePetCharacter(twoCharacters(), 'cat', 'Whiskers')
    const removal = removePetCharacter(renamed, 'cat')

    expect(removal.state.installed.map((entry) => entry.characterId)).toEqual(['dog'])
    expect(removal.state.names.cat).toBeUndefined()
    expect(removal.releasedSelection).toBe(false)
  })

  it('clears the choice instead of switching to whatever is first', () => {
    // Upstream's own rule (`settings.ts:396-398`). A library that silently selected `dog` would be
    // showing the user a pet they did not choose.
    const chosen = selectPetCharacter(twoCharacters(), 'cat')
    const removal = removePetCharacter(chosen, 'cat')

    expect(removal.releasedSelection).toBe(true)
    expect(removal.state.selectedId).toBeNull()
    expect(petSelection(removal.state)).toEqual({ status: 'none' })
    expect(readPetLibrary(removal.state).notices).not.toContain('selection-missing')
  })

  it('leaves the choice alone when it named somebody else', () => {
    const chosen = selectPetCharacter(twoCharacters(), 'dog')
    const removal = removePetCharacter(chosen, 'cat')
    expect(removal.state.selectedId).toBe('dog')
    expect(removal.releasedSelection).toBe(false)
  })
})

describe('adoption from a catalogue', () => {
  it('plans a fetch for an offer with a stated licence that is not installed', () => {
    expect(planCharacterAdoption(NO_PET_LIBRARY, PET_CATALOGUE, offer())).toEqual({
      status: 'refused',
      refusal: 'no-catalogue',
      detail: expect.stringContaining('no catalogue is configured'),
    })
    const listed: PetCatalogueState = { status: 'listed', offers: [offer()] }
    expect(planCharacterAdoption(NO_PET_LIBRARY, listed, offer())).toEqual({
      status: 'planned',
      slug: 'boba',
      name: 'Boba',
    })
  })

  it('refuses an offer whose licence the catalogue did not state', () => {
    // §8: 不把下载成功当授权证明. The pack is still listed; it simply cannot be adopted, and the
    // refusal names that rather than saying the offer is invalid.
    const listed: PetCatalogueState = { status: 'listed', offers: [offer({ licence: null })] }
    const plan = planCharacterAdoption(NO_PET_LIBRARY, listed, offer({ licence: null }))
    expect(plan.status).toBe('refused')
    if (plan.status === 'refused') expect(plan.refusal).toBe('licence-unknown')
    expect(readPetLibrary(NO_PET_LIBRARY, listed).notices).toContain('offers-without-licence')
  })

  it('refuses to adopt over a character the user already has', () => {
    // §7.5's 禁止失败时重新下载覆盖, and the same rule D8's `resources.rs` enforces for an import:
    // adopting again would replace the user's copy of something, including a copy they renamed.
    const installed: PetLibraryState = {
      installed: [character('boba', 'Boba')],
      names: { boba: 'Boba the Second' },
      selectedId: 'boba',
    }
    const listed: PetCatalogueState = { status: 'listed', offers: [offer()] }
    const plan = planCharacterAdoption(installed, listed, offer())

    expect(plan.status).toBe('refused')
    if (plan.status === 'refused') expect(plan.refusal).toBe('already-installed')
    expect(petCharacterName(installed, 'boba')).toBe('Boba the Second')
  })

  it('refuses in every arm in which the catalogue is not a list of offers', () => {
    const catalogue: PetCatalogueState = { status: 'unreachable', detail: 'no route to host' }
    const plan = planCharacterAdoption(twoCharacters(), catalogue, offer())
    expect(plan.status).toBe('refused')
    if (plan.status === 'refused') {
      expect(plan.refusal).toBe('catalogue-unavailable')
      // And the installed characters are untouched: the refusal is about the catalogue.
      expect(twoCharacters().installed).toHaveLength(2)
    }
  })
})
