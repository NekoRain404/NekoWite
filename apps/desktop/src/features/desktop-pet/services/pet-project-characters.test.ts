/**
 * Project characters: the cap, the way back, and the boundary between two vaults.
 *
 * The third group is why this file exists. A binding keyed by a project id alone passes every
 * single-vault test there is and merges two vaults' characters the first time a user has the
 * same project in both — the failure the plan's §6.1 tuple rule and the ledger's
 * 「路径绑定转稳定 `vaultId`」 both point at, and the reason the assertions below are written
 * as *two vaults* rather than as one vault used carefully.
 */
import { describe, expect, it } from 'vitest'
import {
  NO_PROJECT_CHARACTERS,
  bindProjectCharacter,
  petBindingKey,
  petVaultCharacters,
  showProjectCharacters,
  unbindProjectCharacter,
  withdrawAllProjectCharacters,
  withdrawProjectCharacters,
  type PetProjectBinding,
  type PetProjectCharacterState,
} from './pet-project-characters'

const VAULT_A = 'vault-a'
const VAULT_B = 'vault-b'
const CAP = 3

function binding(vaultId: string, projectId: string, characterId: string): PetProjectBinding {
  return { vaultId, projectId, characterId }
}

/** Bind, and fail loudly if the write was refused: the tests that expect a refusal say so themselves. */
function bound(
  state: PetProjectCharacterState,
  next: PetProjectBinding,
  maxCharacters: unknown = CAP,
): PetProjectCharacterState {
  const outcome = bindProjectCharacter(state, next, maxCharacters)
  if (outcome.status !== 'bound') throw new Error(`expected a bind, got ${outcome.refusal}`)
  return outcome.state
}

function refusalOf(
  state: PetProjectCharacterState,
  next: PetProjectBinding,
  maxCharacters: unknown = CAP,
): string {
  const outcome = bindProjectCharacter(state, next, maxCharacters)
  return outcome.status === 'refused' ? outcome.refusal : `bound (${outcome.binding.characterId})`
}

function projectsOf(state: PetProjectCharacterState, vaultId: string): string[] {
  return petVaultCharacters(state, vaultId, CAP).showing.map((shown) => shown.projectId)
}

describe('a binding belongs to one project of one vault', () => {
  it('keeps two vaults that name the same project apart', () => {
    const state = bound(NO_PROJECT_CHARACTERS, binding(VAULT_A, 'notes', 'cat'))

    expect(projectsOf(state, VAULT_A)).toEqual(['notes'])
    // The vault next door has a project with the same id and no character at all. A map keyed
    // by the project id would have handed it `cat`.
    expect(petVaultCharacters(state, VAULT_B, CAP)).toMatchObject({ showing: [], held: [], remaining: CAP })
  })

  it('refuses a half-identified binding instead of filing it where every vault looks', () => {
    expect(refusalOf(NO_PROJECT_CHARACTERS, binding('', 'notes', 'cat'))).toBe('incomplete-identity')
    expect(refusalOf(NO_PROJECT_CHARACTERS, binding(VAULT_A, '', 'cat'))).toBe('incomplete-identity')
    expect(petBindingKey('', 'notes')).toBeNull()
    expect(petBindingKey(VAULT_A, '')).toBeNull()
  })

  it('keeps two projects apart when their ids collide as a joined string', () => {
    // `a` + `:` + `b:c` and `a:b` + `:` + `c` are one string under any separator that can occur
    // inside an id, and that string is what a suffix match then confuses. Lengths leave no such
    // pair — the contract's reason for `petKeyToken`.
    const state = bound(NO_PROJECT_CHARACTERS, binding('a', 'b:c', 'cat'))

    expect(petBindingKey('a', 'b:c')).not.toBe(petBindingKey('a:b', 'c'))
    expect(projectsOf(state, 'a:b')).toEqual([])
    expect(projectsOf(state, 'a')).toEqual(['b:c'])
  })

  it('replaces the character of one project without touching the vault next door', () => {
    let state = bound(NO_PROJECT_CHARACTERS, binding(VAULT_A, 'notes', 'cat'))
    state = bound(state, binding(VAULT_B, 'notes', 'fox'))
    state = bound(state, binding(VAULT_A, 'notes', 'owl'))

    expect(petVaultCharacters(state, VAULT_A, CAP).showing).toEqual([binding(VAULT_A, 'notes', 'owl')])
    expect(petVaultCharacters(state, VAULT_B, CAP).showing).toEqual([binding(VAULT_B, 'notes', 'fox')])
  })

  it('writes nothing a caller can see through its own copy of the state', () => {
    const before: PetProjectCharacterState = { ...NO_PROJECT_CHARACTERS }
    const after = bound(before, binding(VAULT_A, 'notes', 'cat'))

    expect(before.bindings).toHaveLength(0)
    expect(after.bindings).toHaveLength(1)
    expect(after).not.toBe(before)
  })
})

describe('the cap counts one vault, and only what is showing', () => {
  function atCap(): PetProjectCharacterState {
    let state = bound(NO_PROJECT_CHARACTERS, binding(VAULT_A, 'one', 'cat'))
    state = bound(state, binding(VAULT_A, 'two', 'fox'))
    return bound(state, binding(VAULT_A, 'three', 'owl'))
  }

  it('refuses a character past the limit, and says which limit refused it', () => {
    const outcome = bindProjectCharacter(atCap(), binding(VAULT_A, 'four', 'bat'), CAP)

    expect(outcome.status).toBe('refused')
    if (outcome.status !== 'refused') return
    expect(outcome.refusal).toBe('at-capacity')
    expect(outcome.detail).toMatch(/3/)
  })

  it('does not spend the room of a vault nobody opened', () => {
    const state = atCap()

    expect(petVaultCharacters(state, VAULT_B, CAP).remaining).toBe(CAP)
    expect(refusalOf(state, binding(VAULT_B, 'notes', 'bat'))).toBe('bound (bat)')
  })

  it('replaces a character that is already showing, at the cap', () => {
    const state = atCap()
    const rebind = bindProjectCharacter(state, binding(VAULT_A, 'two', 'bat'), CAP)

    expect(rebind.status).toBe('bound')
    expect(projectsOf(rebind.status === 'bound' ? rebind.state : state, VAULT_A)).toEqual([
      'one',
      'two',
      'three',
    ])
  })

  it('reads a corrupt stored limit by the contract rule rather than growing to fit', () => {
    // `readPetNumber` (`pet-contracts/config.ts:171`) is the one rule the settings page and the
    // backend already share; `9` is outside the contract's 1..5, so the value is corrupt and the
    // default applies — not "the user asked for nine".
    for (const stored of ['lots', 9, 0, 3.5, null, undefined]) {
      expect(petVaultCharacters(NO_PROJECT_CHARACTERS, VAULT_A, stored).limit).toBe(CAP)
    }
    expect(petVaultCharacters(NO_PROJECT_CHARACTERS, VAULT_A, 5).limit).toBe(5)
  })

  it('holds the bindings a lowered limit cannot show instead of forgetting them', () => {
    // Bound while the limit was 5, read back once the user has lowered it to 3: the extra
    // binding is the case §5.3's 「越界旧值」 describes, and it waits rather than vanishing.
    const state = bound(atCap(), binding(VAULT_A, 'four', 'bat'), 5)
    const reading = petVaultCharacters(state, VAULT_A, CAP)

    expect(reading.showing).toHaveLength(3)
    expect(reading.held).toEqual([{ binding: binding(VAULT_A, 'four', 'bat'), reason: 'beyond-cap' }])
    expect(reading.remaining).toBe(0)
    // Nothing was deleted to make the numbers agree.
    expect(state.bindings).toHaveLength(4)

    const lower = petVaultCharacters(state, VAULT_A, 1)
    expect(lower.showing.map((shown) => shown.projectId)).toEqual(['one'])
    expect(lower.held).toHaveLength(3)
  })

  it('shows them again when the limit comes back up', () => {
    const state = bound(atCap(), binding(VAULT_A, 'four', 'bat'), 5)

    expect(petVaultCharacters(state, VAULT_A, 5).showing.map((shown) => shown.projectId)).toEqual([
      'one',
      'two',
      'three',
      'four',
    ])
    expect(petVaultCharacters(state, VAULT_A, 5).held).toEqual([])
  })
})

describe('收回 takes the characters back, and gives them back', () => {
  function twoVaults(): PetProjectCharacterState {
    let state = bound(NO_PROJECT_CHARACTERS, binding(VAULT_A, 'notes', 'cat'))
    state = bound(state, binding(VAULT_A, 'site', 'fox'))
    return bound(state, binding(VAULT_B, 'notes', 'owl'))
  }

  it('takes one vault off the desktop and leaves the other standing', () => {
    const state = withdrawProjectCharacters(twoVaults(), VAULT_A)

    expect(petVaultCharacters(state, VAULT_A, CAP)).toMatchObject({ showing: [], remaining: CAP })
    expect(petVaultCharacters(state, VAULT_A, CAP).held.map((hold) => hold.reason)).toEqual([
      'withdrawn',
      'withdrawn',
    ])
    expect(projectsOf(state, VAULT_B)).toEqual(['notes'])
  })

  it('takes every vault off the desktop with one call', () => {
    const state = withdrawAllProjectCharacters(twoVaults())

    expect(petVaultCharacters(state, VAULT_A, CAP).showing).toEqual([])
    expect(petVaultCharacters(state, VAULT_B, CAP).showing).toEqual([])
    expect(state.bindings).toHaveLength(3)
  })

  it('gives one vault back without disturbing the vault that is still away', () => {
    const away = withdrawAllProjectCharacters(twoVaults())
    const back = showProjectCharacters(away, VAULT_A)

    expect(projectsOf(back, VAULT_A)).toEqual(['notes', 'site'])
    expect(petVaultCharacters(back, VAULT_B, CAP).showing).toEqual([])
  })

  it('takes the same reading twice without growing the withdrawn list', () => {
    const once = withdrawAllProjectCharacters(twoVaults())

    // Referential equality, so a desktop does not repaint because a button was pressed twice.
    expect(withdrawAllProjectCharacters(once)).toBe(once)
    expect(withdrawProjectCharacters(once, VAULT_A)).toBe(once)
    expect(showProjectCharacters(NO_PROJECT_CHARACTERS, VAULT_A)).toBe(NO_PROJECT_CHARACTERS)
  })

  it('frees a slot without giving up the binding', () => {
    let state = bound(NO_PROJECT_CHARACTERS, binding(VAULT_A, 'one', 'cat'))
    state = bound(state, binding(VAULT_A, 'two', 'fox'))
    state = bound(state, binding(VAULT_A, 'three', 'owl'))
    expect(refusalOf(state, binding(VAULT_A, 'four', 'bat'))).toBe('at-capacity')

    const quiet = withdrawProjectCharacters(state, VAULT_A)
    const withNew = bound(quiet, binding(VAULT_A, 'four', 'bat'))

    expect(petVaultCharacters(withNew, VAULT_A, CAP).showing).toEqual([binding(VAULT_A, 'four', 'bat')])
    expect(petVaultCharacters(withNew, VAULT_A, CAP).held.map((hold) => hold.binding.projectId)).toEqual([
      'one',
      'two',
      'three',
    ])
    expect(petVaultCharacters(withNew, VAULT_A, CAP).held.every((hold) => hold.reason === 'withdrawn')).toBe(true)
  })

  it('puts a project back when the user chooses its character again', () => {
    const away = withdrawProjectCharacters(twoVaults(), VAULT_A)
    const again = bound(away, binding(VAULT_A, 'notes', 'bat'))

    expect(projectsOf(again, VAULT_A)).toEqual(['notes'])
    expect(petVaultCharacters(again, VAULT_A, CAP).held).toEqual([{ binding: binding(VAULT_A, 'site', 'fox'), reason: 'withdrawn' }])
  })

  it('forgets a project only when the user unbinds it, and only that one', () => {
    const state = unbindProjectCharacter(twoVaults(), VAULT_A, 'notes')

    expect(projectsOf(state, VAULT_A)).toEqual(['site'])
    expect(projectsOf(state, VAULT_B)).toEqual(['notes'])
    expect(state.bindings).toHaveLength(2)
  })

  it('leaves nothing withdrawn behind an unbound project', () => {
    const away = withdrawProjectCharacters(twoVaults(), VAULT_A)
    const gone = unbindProjectCharacter(away, VAULT_A, 'notes')

    expect(gone.withdrawn).not.toContain(petBindingKey(VAULT_A, 'notes'))
    expect(gone.withdrawn).toContain(petBindingKey(VAULT_A, 'site'))
  })
})
