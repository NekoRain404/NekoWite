/**
 * The settings policy: what a stored record means, and whether a submitted write may be
 * accepted (§5.3).
 *
 * A pure module. It reads no storage, reaches no IPC, knows no window, and holds no state:
 * given what the store says it has and what a caller submitted, it decides the outcome, and
 * the caller does the writing. The purity is the point — §5.3 requires the interface and the
 * backend to validate by the same rule (「界面和后端使用同一规则」), and the only way to have
 * one rule is to have one function both sides call, rather than two that agree until the day
 * they do not. `R/src/desktop_pet/settings.rs` mirrors the decisions below; the report names
 * which of them carry the weight.
 *
 * The schema is D1's (`platform/gateways/pet-contracts/config.ts`) and is not restated: the
 * domains, the explicit defaults, the numeric rules and the load/update arms all come from
 * it. The field rules live in `./pet-settings-values` — one module every domain's values go
 * through — and this half is the record: version policy, revision policy, and the scoped
 * reset, which are the parts of §5.3 that are about a *record* rather than about a value.
 *
 * The arm shapes decide the shape of this module, so they are worth naming up front: a
 * *stored* record is normalized as far as it can be (a value nobody can use takes its rule's
 * fallback and is reported), while a *submitted* write is refused whole if any field is
 * unusable — because writing a fallback the user did not choose would be reporting success
 * for a save that changed their setting to something else.
 */
import { PET_SETTINGS_SCHEMA_VERSION } from '../../../platform/gateways/pet-contracts'
import type {
  PetSettingsDomain,
  PetSettingsLoad,
  PetSettingsRecord,
  PetSettingsUpdate,
  PetSettingsValues,
  PetSettingsWrite,
} from '../../../platform/gateways/pet-contracts'
import {
  isSettingsObject,
  petSettingsProblemMessage,
  petSettingsValueProblems,
  readPetSettingsValues,
  readStoredPetSettingsValues,
} from './pet-settings-values'

// The value-level rules stay reachable from this path: a caller deciding a write needs the
// field rules and the record rules together, and one import path is how the two stay one
// subject. Nothing is re-exported that this file does not itself use, so the list cannot
// drift away from what is actually shared.
export { petSettingsValueProblems, readPetSettingsValues, readStoredPetSettingsValues, samePetSettingsValues } from './pet-settings-values'
export type {
  PetSettingsProblemKind,
  PetSettingsReadout,
  PetSettingsValueProblem,
} from './pet-settings-values'

/** One domain's record, as the contract's union gives it. Derived, never restated. */
export type PetSettingsRecordFor<D extends PetSettingsDomain> = Extract<
  PetSettingsRecord,
  { domain: D }
>

/**
 * The revision a domain that has never been written is at.
 *
 * Named because both sides have to agree on it. A store that starts its counter anywhere
 * else turns the first write built from a `defaults` record into a false conflict, and the
 * user's first setting change comes back as "someone else changed this".
 */
export const PET_SETTINGS_INITIAL_REVISION = 0

/**
 * The record type is a union correlated on `domain`, which TypeScript cannot follow where
 * the domain is only a variable — the same limitation D1 recorded in `memory-pet/settings.ts`.
 * The object built here is exactly one arm of that union.
 *
 * The values are normalized into a copy rather than taken by reference: what this module
 * returns is a *snapshot* of a decision, and a caller's draft is usually a reactive object it
 * keeps editing. Handing that object out inside a record would mean the record the caller
 * then persists was still moving.
 */
function recordFor(
  domain: PetSettingsDomain,
  schemaVersion: number,
  revision: number,
  values: PetSettingsValues[PetSettingsDomain],
): PetSettingsRecord {
  const snapshot = readPetSettingsValues(domain, values).values
  return { domain, schemaVersion, revision, values: snapshot } as PetSettingsRecord
}

function defaultsLoad(domain: PetSettingsDomain, reason: 'absent' | 'unreadable'): PetSettingsLoad {
  return {
    status: 'defaults',
    reason,
    record: recordFor(
      domain,
      PET_SETTINGS_SCHEMA_VERSION,
      PET_SETTINGS_INITIAL_REVISION,
      readPetSettingsValues(domain, {}).values,
    ),
  }
}

/**
 * What one stored record is, as this build can read it.
 *
 * The version check precedes every other one. Data written by a newer build is reported and
 * left alone (§10.2's 「遇到新版本数据，旧程序只读/报错，禁止按默认值覆盖」), and it has to be
 * decided *before* the fields are examined: reading a future record as "this version, with
 * defaults for anything I did not recognise" is the overwrite the rule exists to prevent,
 * and it is exactly what a caller would then write back.
 */
export function readPetSettingsDomain(domain: PetSettingsDomain, stored: unknown): PetSettingsLoad {
  if (stored === null || stored === undefined) return defaultsLoad(domain, 'absent')
  if (!isSettingsObject(stored)) return defaultsLoad(domain, 'unreadable')
  const version = stored.schemaVersion
  const revision = stored.revision
  if (
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version > PET_SETTINGS_SCHEMA_VERSION
  ) {
    return { status: 'read-only', reason: 'schema-newer', foundVersion: version }
  }
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 0 ||
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 0
  ) {
    // A record whose version or revision is not a number cannot be written against, so there
    // is nothing here to merge a change into, and inventing a revision would hand the caller
    // a token the store never issued. Reported as unreadable — the arm a caller is also meant
    // to back the file up from before writing (§10.2).
    return defaultsLoad(domain, 'unreadable')
  }
  const readout = readStoredPetSettingsValues(domain, stored.values)
  if (readout === null) return defaultsLoad(domain, 'unreadable')
  const record = recordFor(domain, PET_SETTINGS_SCHEMA_VERSION, revision, readout.values)
  if (version === PET_SETTINGS_SCHEMA_VERSION) {
    // `current` carries no field for repairs, so a current-version record with an unusable
    // value is normalized without a report here; a caller that needs the list calls
    // `readPetSettingsValues` itself.
    return { status: 'current', record }
  }
  // The upgraded record carries *this* build's version, so a write-back is an upgrade rather
  // than a migration that has to be replayed on every read. The backup §10.2 requires belongs
  // to the store; a policy that cannot write cannot take one.
  return { status: 'migrated', record, fromVersion: version, repaired: readout.repaired }
}

/**
 * Whether one submitted write may be applied — the decision the store is asked to honour, and
 * the one both sides compute the same way.
 *
 * The three refusals are ordered by what the caller has to do about them:
 *
 *  - a newer store is refused before anything else, so a build that meets data from its future
 *    does not overwrite it even with a write that *looks* current (§10.2);
 *  - a write for another domain is refused, because the record's `domain` and the
 *    submission's are two halves of one fact and a mismatch means the pair was assembled
 *    wrong — the type system guarantees this inside the app, and the IPC boundary does not
 *    (arguing「不能让任意窗口提交 XP」 is the same class of check);
 *  - a submission that is not at the revision the caller read is a *conflict*, refused so the
 *    caller reloads. It is never merged: a merge is how a value the user changed in another
 *    window gets undone, and this is the arm that makes that unwritable. A revision *ahead*
 *    of the store is refused the same way — a window cannot skip the counter, or it would win
 *    every later conflict by asserting a number nobody issued.
 *
 * What is deliberately absent is a `failed` arm: this function cannot fail to decide, and "the
 * store could not persist it" is the caller's own outcome, not a judgement about a submission.
 */
export function decidePetSettingsWrite(
  stored: PetSettingsRecord,
  write: PetSettingsWrite,
): PetSettingsUpdate {
  if (stored.schemaVersion > PET_SETTINGS_SCHEMA_VERSION) {
    return {
      status: 'refused',
      reason: 'schema-newer',
      message: `${stored.domain} is at schema ${stored.schemaVersion}; this build writes ${PET_SETTINGS_SCHEMA_VERSION}`,
    }
  }
  if (stored.domain !== write.domain) {
    return {
      status: 'refused',
      reason: 'invalid-value',
      message: `a ${write.domain} write against a ${stored.domain} record`,
    }
  }
  if (stored.revision !== write.revision) {
    return { status: 'conflict', current: stored }
  }
  const problems = petSettingsValueProblems(write.domain, write.values)
  if (problems.length > 0) {
    return { status: 'refused', reason: 'invalid-value', message: petSettingsProblemMessage(problems) }
  }
  return {
    status: 'applied',
    record: recordFor(write.domain, PET_SETTINGS_SCHEMA_VERSION, stored.revision + 1, write.values),
  }
}

/**
 * One domain's write, at the revision the caller read.
 *
 * The version stamped is *this* build's, whatever the stored record said: a submission
 * accepted against an older record is the migration's write-back, and letting the caller
 * choose the version would let it write the old schema forward.
 */
export function petSettingsWrite(
  domain: PetSettingsDomain,
  revision: number,
  values: PetSettingsValues[PetSettingsDomain],
): PetSettingsWrite {
  return { domain, revision, values } as PetSettingsWrite
}

/**
 * §5.3's 「恢复本页默认只影响当前域」, as a *write* rather than a mutation.
 *
 * It returns the submission for one domain and nothing else — no other domain's values, and
 * no verb that could reach them — so a page's reset cannot clear the character library or care
 * progress, which §5.3 requires be kept. Going back through the write path rather than
 * resetting a record in place means a reset is revision-checked like any other change, and the
 * store is still the only thing that decides whether it applies. 重置养成、删除素材、删除历史
 * need their own confirmations and are three other operations; none of them is this one.
 *
 * The values are a copy: `PET_SETTINGS_DEFAULTS` is a module constant the whole process
 * shares, so handing it out directly would let a draft edit (a Vue reactive proxy, in the
 * caller) rewrite the defaults every other page reads.
 */
export function resetPetSettingsDomain(
  domain: PetSettingsDomain,
  revision: number,
): PetSettingsWrite {
  return petSettingsWrite(domain, revision, readPetSettingsValues(domain, {}).values)
}

/**
 * `record` as the arm for `domain`, or null when it is a record of another domain.
 *
 * The check is the point: the contract's record is a union correlated on `domain`, so a caller
 * that took the values out of whichever arm arrived would be reading one domain's settings
 * through another domain's schema. The cast is the same limitation `recordFor` records —
 * TypeScript will not follow the comparison into the union's arm.
 */
export function petSettingsRecordFor<D extends PetSettingsDomain>(
  record: PetSettingsRecord | null,
  domain: D,
): PetSettingsRecordFor<D> | null {
  if (record === null || record.domain !== domain) return null
  return record as unknown as PetSettingsRecordFor<D>
}
