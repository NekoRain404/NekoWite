/**
 * The double's settings store: one versioned record per domain, with the revision rule
 * enforced on the only path that writes.
 *
 * Every change goes through `write`, revision check included. There is no shortcut that
 * writes around it, because §5.3's rule is only worth having if the way in and the way
 * out are the same way — a second write path is how two windows end up disagreeing about
 * whose value is current.
 *
 * Split out of `../memory-pet` because it is the one part of the double that models
 * *storage*: what a real install meets — a record written by a newer build, a disk that
 * refused the write — is what the arms below exist to make reachable from a test.
 */
import {
  PET_SETTINGS_DEFAULTS,
  PET_SETTINGS_SCHEMA_VERSION,
  type PetSettingsDomain,
  type PetSettingsLoad,
  type PetSettingsRecord,
  type PetSettingsUpdate,
  type PetSettingsValues,
  type PetSettingsWrite,
} from '../pet-contracts'

export interface MemoryPetSettings {
  /** The domain's record, or the reason the host will not read it as its own. */
  read(domain: PetSettingsDomain): PetSettingsLoad
  /** Apply one domain's write, or say why it did not apply. */
  write(write: PetSettingsWrite): PetSettingsUpdate
  /** The general domain's switch, which the reported feature state is read from. */
  enabled(): boolean
}

export interface MemoryPetSettingsOptions {
  /**
   * The schema version the stored settings claim. Defaults to this build's, so the two
   * cases a real install meets are reachable: newer data this build must not overwrite
   * (§10.2), and older data that has to be migrated.
   */
  storedSchemaVersion?: number
  /** How many of the next writes fail, so a save failure is demonstrable (§5.3). */
  writeFailures?: number
}

export function createPetSettingsDouble(
  options: MemoryPetSettingsOptions = {},
): MemoryPetSettings {
  const values: { [D in PetSettingsDomain]: PetSettingsValues[D] } = { ...PET_SETTINGS_DEFAULTS }
  const revisions: { [D in PetSettingsDomain]: number } = {
    general: 1,
    character: 1,
    view: 1,
    message: 1,
    notification: 1,
    care: 1,
    project: 1,
  }
  const storedSchemaVersion = options.storedSchemaVersion ?? PET_SETTINGS_SCHEMA_VERSION
  let writeFailures = options.writeFailures ?? 0

  function recordFor(domain: PetSettingsDomain): PetSettingsRecord {
    // The record type is a union correlated on `domain`, which TypeScript cannot follow
    // where the domain is only a variable. This is the module's one cast.
    return {
      domain,
      schemaVersion: storedSchemaVersion,
      revision: revisions[domain],
      values: values[domain],
    } as PetSettingsRecord
  }

  return {
    read(domain: PetSettingsDomain): PetSettingsLoad {
      if (storedSchemaVersion > PET_SETTINGS_SCHEMA_VERSION) {
        // §10.2: a build that meets data from a newer schema reports it and stays off it.
        return { status: 'read-only', reason: 'schema-newer', foundVersion: storedSchemaVersion }
      }
      if (storedSchemaVersion < PET_SETTINGS_SCHEMA_VERSION) {
        return {
          status: 'migrated',
          record: recordFor(domain),
          fromVersion: storedSchemaVersion,
          repaired: [],
        }
      }
      return { status: 'current', record: recordFor(domain) }
    },

    write(write: PetSettingsWrite): PetSettingsUpdate {
      if (storedSchemaVersion > PET_SETTINGS_SCHEMA_VERSION) {
        return {
          status: 'refused',
          reason: 'schema-newer',
          message: `the stored settings are schema ${storedSchemaVersion}; this build writes ${PET_SETTINGS_SCHEMA_VERSION}`,
        }
      }
      if (write.revision !== revisions[write.domain]) {
        // §5.3: an update based on a revision that has moved on is refused and the caller
        // reloads. It is never merged, because a merge is how a value the user changed on
        // another page gets undone.
        return { status: 'conflict', current: recordFor(write.domain) }
      }
      if (writeFailures > 0) {
        writeFailures -= 1
        return { status: 'failed', message: 'the settings could not be written' }
      }
      // A union index into a per-domain record is not something TypeScript can
      // prove: `values[D]` where `D` is the union of all domains erases to the
      // *intersection* of every domain's shape, which no single domain
      // satisfies — and a cast to `values[typeof write.domain]` does not help,
      // because that is the same intersection. The key and the value come from
      // the same union member, so this one write goes through a loose view of
      // the record rather than a wrong one.
      ;(values as Record<string, unknown>)[write.domain] = write.values
      revisions[write.domain] += 1
      return { status: 'applied', record: recordFor(write.domain) }
    },

    /**
     * The general domain's master, **derived from the two window switches it is a statement
     * about** — `characterWindow || ball`, the same rule the store recomputes on every read
     * (`R/src/desktop_pet/settings/values.rs`'s `derive_master`) and the page normalizes its
     * draft with (`pet-settings-values.ts`'s `readPetSettingsValues`).
     *
     * Read from the switches here rather than from the stored field, and that is the one place
     * this double cannot simply echo what a caller wrote: `platform/` does not import from
     * `features/`, so the normalizer is out of reach, and answering with a stored master that
     * a hand-built write left disagreeing with its own switches would be the double reporting
     * a state the product cannot have. A double exists to be the host a page meets, not a
     * second opinion about it.
     */
    enabled(): boolean {
      return values.general.characterWindow === true || values.general.ball === true
    },
  }
}
