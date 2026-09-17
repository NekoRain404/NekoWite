/**
 * The double's character library, and the appearance a window would draw from it.
 *
 * The two reads `appearance()` answers are the two the real host joins: what the library holds,
 * and what the `character` settings domain names. Keeping both here — rather than letting a test
 * hand in a pre-built appearance — is what makes the *flow* reachable from a test: a page writes
 * `characterId` through the double's settings, and the next `appearance()` read is the state that
 * follows. A double that answered a canned appearance could not show a character being chosen at
 * all, which is the one thing this read exists for.
 *
 * Split out of `../memory-pet` for the reason `./settings` is: it is a part of the double with its
 * own subject, and the composition next door is left as the surface a test reads.
 */
import type {
  PetAppearance,
  PetCatalogueReading,
  PetCharacterEntry,
  PetSettingsValues,
} from '../pet-contracts'
import type { MemoryPetSettings } from './settings'

export interface MemoryPetCharacters {
  /** Every character the double's library holds. */
  library(): PetCharacterEntry[]
  /** What a pet window would draw, derived from the library and the stored selection. */
  appearance(): PetAppearance
  /** One import, as the real command's dialog produces: a new entry, or a refusal. */
  importCharacter(): PetCharacterEntry
  /** What the catalogue answers, which is the `unconfigured` arm unless a test scripted one. */
  catalogue(): PetCatalogueReading
  /** One download, as the real command's transfer produces: a new entry, or a refusal. */
  adoptCharacter(slug: string): PetCharacterEntry
}

export interface MemoryCharacterOptions {
  /** The characters the library already holds. */
  characters?: readonly PetCharacterEntry[]
  /**
   * The sentence an import is refused with, for the failure path a page has to draw: a real import
   * refuses when a pack is not one, when a budget is exceeded and when the disk says no, and a
   * double that could only succeed would leave the half of the page that shows a refusal untested.
   */
  importRefusal?: string
  /** What the catalogue answers. Absent means `unconfigured` — this double has no network. */
  catalogue?: PetCatalogueReading
  /** The sentence a download is refused with, for the failure path a page has to draw. */
  adoptRefusal?: string
}

/**
 * The double's library, over the settings double it shares with the gateway.
 *
 * `settings` is the same store the gateway's `readSettings`/`updateSettings` answer from, so the
 * selection a page writes is the selection `appearance()` reads — one record, one answer, exactly
 * as `character.characterId` is in the product.
 */
export function createPetCharacterDouble(
  options: MemoryCharacterOptions,
  settings: MemoryPetSettings,
): MemoryPetCharacters {
  const installed: PetCharacterEntry[] = [...(options.characters ?? [])]
  let imported = 0
  let downloaded = 0

  /**
   * The `character` domain, as the host would read it for an appearance.
   *
   * The one cast in this file: a record's `values` is the union of all seven domains' shapes, and
   * TypeScript cannot narrow it by a variable domain (the same limitation `./settings` records for
   * its write path). It is read here for one literal domain, so what comes back is that domain's
   * shape and the cast says so.
   */
  function storedCharacter(): { selected: string | null; values: PetSettingsValues['character'] } {
    const load = settings.read('character')
    if (load.status === 'read-only') {
      // A settings file this build must not read. There is no record to draw from, and this is
      // deliberately not reported as "nothing chosen" — the difference matters to the window.
      throw new Error(
        `the character settings are at schema ${load.foundVersion}, which this build cannot read`,
      )
    }
    const values = load.record.values as PetSettingsValues['character']
    return { selected: values.characterId, values }
  }

  return {
    library() {
      return [...installed]
    },

    appearance(): PetAppearance {
      const { selected, values } = storedCharacter()
      if (selected === null) return { status: 'unset' }
      const entry = installed.find((candidate) => candidate.characterId === selected)
      if (entry === undefined) {
        return {
          status: 'missing',
          characterId: selected,
          detail: 'it is not installed in the character library',
        }
      }
      if (entry.files === 'damaged') {
        return {
          status: 'missing',
          characterId: selected,
          detail: 'its files are not what the library recorded',
        }
      }
      return {
        status: 'ready',
        characterId: selected,
        name: entry.packName,
        // A real adapter answers an absolute path and converts it with `convertFileSrc`; the
        // double has no file system, so it answers a URL of the same shape so a test's assertions
        // read the same either way.
        sheetPath: `memory://characters/${selected}/sheet.png`,
        sheet: { columns: 8, rows: 9 },
        // The stored domain, as the store read it — the same fields the host's own read sends,
        // because the double's whole job here is to answer the shape the window draws from.
        size: values.size,
        bindings: values.bindings,
        idleClips: values.idleClips,
        idleMode: values.idleMode,
        idleIntervalMs: values.idleIntervalSeconds * 1000,
      }
    },

    importCharacter(): PetCharacterEntry {
      if (options.importRefusal !== undefined) throw new Error(options.importRefusal)
      imported += 1
      const entry: PetCharacterEntry = {
        characterId: `imported-${imported}`,
        packName: `Imported ${imported}`,
        kind: 'imported',
        files: 'intact',
        // Later than anything a test hands the double, so "newest first" has something to order.
        installedAtMs: 1_700_000_000_000 + imported,
      }
      installed.push(entry)
      return entry
    },

    catalogue(): PetCatalogueReading {
      // `unconfigured` rather than an empty listing, and it is the same value the product answered
      // before there was an endpoint: a double that answered `listed` with nothing in it would
      // make "no catalogue" and "an empty catalogue" the same answer, which is the defect the
      // whole vocabulary exists to keep apart.
      return options.catalogue ?? { status: 'unconfigured' }
    },

    adoptCharacter(slug: string): PetCharacterEntry {
      if (options.adoptRefusal !== undefined) throw new Error(options.adoptRefusal)
      // The download lands the way a real one does: through the library, under the catalogue's
      // own slug, as a character that came from the network rather than from the user's files.
      // A slug that is already installed is refused for the same reason the real library refuses
      // it — the user's copy is theirs, and a second download would replace it.
      if (installed.some((entry) => entry.characterId === slug)) {
        throw new Error(`${slug} is already installed`)
      }
      const offered = (options.catalogue?.status === 'listed'
        ? options.catalogue.offers.find((offer) => offer.slug === slug)
        : undefined)
      downloaded += 1
      const entry: PetCharacterEntry = {
        characterId: slug,
        packName: offered?.name ?? slug,
        kind: 'remote',
        files: 'intact',
        installedAtMs: 1_700_000_100_000 + downloaded,
      }
      installed.push(entry)
      return entry
    },
  }
}
