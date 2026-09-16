/**
 * Project characters: which character one project wears, how many may stand on the
 * desktop at once, and how the user takes them all back (§5.2's 项目与多角色).
 *
 * Ported from `references/desktop-pet/windows/src/projectpets.ts` and the extra-pet half of
 * `windows/src/settings.ts`, at commit `be171a01273a1ed92a27bcdf72f8a58768bac421`:
 *
 *   - the per-project binding and its map (`projectpets.ts:8-9` `ap_split` /
 *     `ap_project_pets`, `:18-21`, `:25-29`, `:30-32` `configuredProjectIds`, `:33-35`)
 *   - the cap on how many decoration windows may be out (`settings.ts:671-672`
 *     `EXTRA_PREFIX` and `MAX_EXTRA_PETS = 12`), the count that is shown against it
 *     (`:749-758`) and the one button that closes them all (`:769-777`)
 *   - the desired-set push that follows a binding change (`main.ts:55-58` calling
 *     `sync_project_windows` with the configured ids, or with an empty list when off)
 *
 * A pure module, like `pet-settings-policy.ts` next door: state in, state out, no storage, no
 * IPC, no clock and no module-level mutable state — §11's 「其他窗口无共享可变本地状态污染」
 * is answered by there being nothing here to share. Who persists a binding and who creates the
 * windows are the host's questions; this file decides *what the desktop should be showing*.
 *
 * ## The identity, which is the part that could not be copied
 *
 * Upstream keys the binding by the project id alone: the map is `{ [projectId]: slug }`
 * (`projectpets.ts:18-21`), `configuredProjectIds()` is its keys (`:30-32`), and the window it
 * asks the backend for is labelled `format!("pet-{id}")` (`lib.rs:270-290`, with
 * `starts_with("pet-")` deciding what may be closed). An id is unique inside the app that
 * minted it, so one map is enough there. It is not enough here: a project id is only unique
 * inside its **vault**, so the same project id in two vaults would be one entry, one window
 * label and one character — 「绑定不影响其他库」 failing in the quietest possible way, with a
 * single-vault test still green.
 *
 * So the key is the pair, written with {@link petKeyToken} from the frozen contract: the
 * identity is compared field by field and never as a substring of anything, for the reason
 * `pet-contracts/task.ts` gives about `${agent}:${session}`. And a pair with a missing half is
 * *refused* rather than defaulted: a binding filed under an empty vault id would be a bucket
 * every vault shares, which is the same bug reached from the other side.
 *
 * ## What the cap is, and what it is not
 *
 * §7.1 puts the number of character windows under backend control (default 3, hard maximum 5),
 * and D1 stores it as `project.maxCharacters`. The check in {@link bindProjectCharacter} is the
 * *affordance* half of that rule: it refuses a binding the desktop would not be able to show and
 * says which limit refused it, so the user is not left with a setting that silently does
 * nothing. It enforces nothing — a window that the backend has already opened stays open, and
 * the backend refuses on its own count regardless of what this module decided. §5.3's
 * 「界面和后端使用同一规则」 is why the number is read with the contract's own
 * `readPetNumber`, so a corrupt stored value falls back here exactly as it does there.
 *
 * The count is per vault, because the desktop only ever shows one vault's characters: a
 * binding in another vault consumes no slot here, which is the same statement as 「绑定不影响
 * 其他库」 said about capacity.
 */

import {
  PET_NUMBER_RULES,
  petKeyToken,
  readPetNumber,
} from '../../../platform/gateways/pet-contracts'

/**
 * One character, bound to one project of one vault.
 *
 * There is no project *name* here and there is no project *path*, deliberately: a binding is
 * addressed by identifiers the host minted, so two projects that share a display name stay two
 * bindings, and a vault that is renamed does not move anybody's character — the identity a
 * rename cannot change is the one that is not in this type.
 */
export interface PetProjectBinding {
  /** The vault the project lives in. Never a path this module accepted from a caller. */
  vaultId: string
  /** The project, as the host names it. Unique inside its vault, not across vaults. */
  projectId: string
  /** The character that project wears. */
  characterId: string
}

/** What the host holds: the bindings the user made, and the ones the user took off the desktop. */
export interface PetProjectCharacterState {
  bindings: readonly PetProjectBinding[]
  /**
   * Binding keys the user withdrew (§5.2's one-click 收回), by {@link petBindingKey}.
   *
   * Withdrawn is not deleted. Upstream's close-all closed windows and left `ap_project_pets`
   * alone (`settings.ts:769-777`), and §4's rollback rule asks for the same thing for a
   * stronger reason: the user's choice of character is theirs, and a feature that "cleans up"
   * by forgetting it is a feature they cannot undo.
   */
  withdrawn: readonly string[]
}

/** No bindings and nothing withdrawn: what a host that has never been configured holds. */
export const NO_PROJECT_CHARACTERS: PetProjectCharacterState = { bindings: [], withdrawn: [] }

/** Why a binding the user asked for is not on the desktop (§7.2: a thing that is not there says so). */
export type PetCharacterHoldReason =
  /** The user took this vault's characters back; the binding is kept. */
  | 'withdrawn'
  /** More characters are bound for this vault than the cap allows; the rest wait their turn. */
  | 'beyond-cap'

/** One binding that is wanted, kept and not on screen, with the reason it is not. */
export interface PetCharacterHold {
  binding: PetProjectBinding
  reason: PetCharacterHoldReason
}

/** What one vault's characters are, as the desktop would show them. */
export interface PetVaultCharacters {
  vaultId: string
  /** On the desktop now, in the order the user bound them. */
  showing: readonly PetProjectBinding[]
  /** Wanted, kept, off the desktop — each with why, so a settings row can say it. */
  held: readonly PetCharacterHold[]
  /** The cap in force, after the contract's rule for a stored number. */
  limit: number
  /** How many more this vault may show before a new binding is refused. */
  remaining: number
}

/** Why a binding was not written. */
export type PetBindingRefusal =
  /** A half-identified binding: a vault or a project nobody named cannot be keyed. */
  | 'incomplete-identity'
  /** No character chosen, so there is nothing the desktop could show. */
  | 'no-character'
  /** This vault already shows as many characters as its limit allows (§7.1). */
  | 'at-capacity'

/** What a bind did: either the state to store, or nothing written and why. */
export type PetBindingOutcome =
  | { status: 'bound'; state: PetProjectCharacterState; binding: PetProjectBinding }
  | { status: 'refused'; refusal: PetBindingRefusal; detail: string }

/**
 * The key of one project in one vault, or null when either half is missing.
 *
 * Null is the whole point and not a convenience: `'' + ':' + id` would file every vault's
 * projects under one bucket, so a caller holding an incomplete identity gets a refusal it can
 * report instead of a binding that quietly belongs to everybody.
 */
export function petBindingKey(vaultId: string, projectId: string): string | null {
  if (vaultId.length === 0 || projectId.length === 0) return null
  return petKeyToken([vaultId, projectId])
}

/** The cap in force, read by the contract's rule so a corrupt value falls back rather than grows. */
function capOf(maxCharacters: unknown): number {
  return readPetNumber(maxCharacters, PET_NUMBER_RULES['project.maxCharacters'])
}

/** Whether two bindings name the same project of the same vault. */
function sameBinding(a: PetProjectBinding, b: { vaultId: string; projectId: string }): boolean {
  return a.vaultId === b.vaultId && a.projectId === b.projectId
}

/**
 * What one vault shows, what it holds back, and how much room is left.
 *
 * The cap counts what is *showing*, not what is bound: §7.1's limit is about how many
 * character windows exist, so a character the user took back frees its slot. That is also what
 * makes 收回 usable — a user who retracts everything to get a quiet desktop can bind someone
 * else without first giving up a binding they still want.
 */
export function petVaultCharacters(
  state: PetProjectCharacterState,
  vaultId: string,
  maxCharacters: unknown,
): PetVaultCharacters {
  const limit = capOf(maxCharacters)
  const withdrawn = new Set(state.withdrawn)
  const showing: PetProjectBinding[] = []
  const held: PetCharacterHold[] = []

  for (const binding of state.bindings) {
    // Exact equality on the vault identity. Never a prefix, a suffix or a normalised path:
    // every earlier bug of this shape in this repository came from deciding ownership by
    // matching a piece of a name.
    if (binding.vaultId !== vaultId) continue
    const key = petBindingKey(binding.vaultId, binding.projectId)
    if (key !== null && withdrawn.has(key)) {
      held.push({ binding, reason: 'withdrawn' })
      continue
    }
    if (showing.length >= limit) {
      held.push({ binding, reason: 'beyond-cap' })
      continue
    }
    showing.push(binding)
  }

  return { vaultId, showing, held, limit, remaining: Math.max(0, limit - showing.length) }
}

/**
 * Bind a character to a project, replacing whatever that project wore before.
 *
 * Rebinding a project that is already showing is allowed at the cap: the desktop would show
 * exactly as many characters afterwards, so it is a replacement and not an addition. Upstream
 * overwrote the same way (`projectpets.ts:25-29`); what is new is that the write is refused
 * when the character could never appear.
 *
 * Choosing a character also un-withdraws the binding. A user who picks a character for a
 * project is asking to see it, and a binding that stayed hidden through that would look like a
 * setting that does nothing.
 */
export function bindProjectCharacter(
  state: PetProjectCharacterState,
  binding: PetProjectBinding,
  maxCharacters: unknown,
): PetBindingOutcome {
  const key = petBindingKey(binding.vaultId, binding.projectId)
  if (key === null) {
    return {
      status: 'refused',
      refusal: 'incomplete-identity',
      detail: 'a binding needs both a vault and a project; a missing half would file every vault together',
    }
  }
  if (binding.characterId.length === 0) {
    return {
      status: 'refused',
      refusal: 'no-character',
      detail: 'no character was chosen, so there is nothing to put on the desktop',
    }
  }

  const reading = petVaultCharacters(state, binding.vaultId, maxCharacters)
  const alreadyShowing = reading.showing.some((shown) => sameBinding(shown, binding))
  if (!alreadyShowing && reading.remaining === 0) {
    return {
      status: 'refused',
      refusal: 'at-capacity',
      detail: `this vault already shows ${reading.limit}; the limit is the desktop's, and the host refuses windows past it too`,
    }
  }

  const existing = state.bindings.find((candidate) => sameBinding(candidate, binding))
  const bindings = existing
    ? state.bindings.map((candidate) => (candidate === existing ? binding : candidate))
    : [...state.bindings, binding]

  return {
    status: 'bound',
    state: { bindings, withdrawn: state.withdrawn.filter((held) => held !== key) },
    binding,
  }
}

/**
 * Remove a binding. The user's explicit choice, and the only place a binding is forgotten.
 *
 * Distinct from {@link withdrawProjectCharacters} on purpose: this is "this project has no
 * character", while withdrawing is "not right now". Rollback (§4) is the switch and the
 * withdraw path; neither of them deletes anything here.
 */
export function unbindProjectCharacter(
  state: PetProjectCharacterState,
  vaultId: string,
  projectId: string,
): PetProjectCharacterState {
  const key = petBindingKey(vaultId, projectId)
  return {
    bindings: state.bindings.filter((binding) => !sameBinding(binding, { vaultId, projectId })),
    withdrawn: key === null ? state.withdrawn : state.withdrawn.filter((held) => held !== key),
  }
}

/** The binding keys of one vault, or of every vault when none is named. */
function keysOf(state: PetProjectCharacterState, vaultId?: string): string[] {
  const keys: string[] = []
  for (const binding of state.bindings) {
    if (vaultId !== undefined && binding.vaultId !== vaultId) continue
    const key = petBindingKey(binding.vaultId, binding.projectId)
    if (key !== null) keys.push(key)
  }
  return keys
}

/** Take one vault's characters off the desktop, keeping every binding. */
export function withdrawProjectCharacters(
  state: PetProjectCharacterState,
  vaultId: string,
): PetProjectCharacterState {
  return withdrawKeys(state, keysOf(state, vaultId))
}

/**
 * Take every character the host holds off the desktop — §5.2's 「一键收回所有角色」.
 *
 * One button, and it reaches every vault because the settings page is app-level while the
 * desktop shows one vault at a time: a button that only silenced the vault the user happens to
 * be standing in would be a button that did not do what its label says.
 */
export function withdrawAllProjectCharacters(
  state: PetProjectCharacterState,
): PetProjectCharacterState {
  return withdrawKeys(state, keysOf(state))
}

/** Put one vault's characters back. The bindings were never gone, so this is the whole undo. */
export function showProjectCharacters(
  state: PetProjectCharacterState,
  vaultId: string,
): PetProjectCharacterState {
  const keys = new Set(keysOf(state, vaultId))
  if (keys.size === 0) return state
  const withdrawn = state.withdrawn.filter((key) => !keys.has(key))
  return withdrawn.length === state.withdrawn.length ? state : { bindings: state.bindings, withdrawn }
}

function withdrawKeys(state: PetProjectCharacterState, keys: readonly string[]): PetProjectCharacterState {
  if (keys.length === 0) return state
  const withdrawn = [...new Set([...state.withdrawn, ...keys])]
  // Referential equality when nothing changed, so a caller mirroring this into a computed value
  // does not repaint a desktop because a button was pressed twice.
  return withdrawn.length === state.withdrawn.length ? state : { bindings: state.bindings, withdrawn }
}
