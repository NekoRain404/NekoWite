/**
 * The double's character library, and the appearance a window would draw from it.
 *
 * The reads `appearance()` answers are the ones the real host joins: what the library holds, what
 * the `character` domain names, and the three facts that ride the read from the domains a pet
 * window may not read for itself (`general`'s `motion` and `ballSize`, `message`'s `bubbleOpacity`).
 * Keeping them here — rather than letting a test hand in a pre-built appearance — is what makes the
 * *flow* reachable from a test: a page writes `characterId` through the double's settings, and the
 * next `appearance()` read is the state that follows. A double that answered a canned appearance
 * could not show a character being chosen at all, which is the one thing this read exists for.
 *
 * Split out of `../memory-pet` for the reason `./settings` is: it is a part of the double with its
 * own subject, and the composition next door is left as the surface a test reads.
 */
import { PET_MOTION_DEFAULT, PET_SETTINGS_DEFAULTS } from '../pet-contracts'
import type {
  PetAppearance,
  PetCatalogueReading,
  PetCharacterEntry,
  PetMotion,
  PetSettingsValues,
} from '../pet-contracts'
import type { MemoryPetSettings } from './settings'

export interface MemoryPetCharacters {
  /** Every character the double's library holds. */
  library(): PetCharacterEntry[]
  /** What a pet window would draw, derived from the library and the stored settings. */
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
   * One of this file's four casts, and all four are for the same reason: a record's `values` is
   * the union of all seven domains' shapes, and TypeScript cannot narrow it by a variable domain
   * (the same limitation `./settings` records for its write path). Each read below is for one
   * literal domain, so what comes back is that domain's shape and the cast says so.
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

  /**
   * The `general` record's motion policy, as the host reads it into every appearance arm.
   *
   * `Motion::of`'s own rule (`desktop_pet/character_view.rs`): `reduced` is the only value that
   * asks for less, and everything else — an absent member, a value nothing wrote, and a `general`
   * record from a build this one may not read — is the schema's default. That last arm answers
   * where {@link storedCharacter} throws for the same case, and the difference is the host's: the
   * character record decides whether there is a character to draw at all, while the policy rides
   * every arm, a fresh install's included.
   */
  function storedMotion(): PetMotion {
    const load = settings.read('general')
    if (load.status === 'read-only') return PET_MOTION_DEFAULT
    const values = load.record.values as PetSettingsValues['general']
    return values.motion === 'reduced' ? 'reduced' : PET_MOTION_DEFAULT
  }

  /**
   * The `message` record's bubble alpha, as the host reads it into every appearance arm.
   *
   * `BubbleOpacity::of`'s rule: a member that is not a number takes the schema's default (0.92,
   * upstream's `ap_opacity` and the value the bubble was drawn with before the field existed),
   * and a `message` record this build may not read takes it too — a transparency the user never
   * chose is a change to what they see, not a default. What is *in range* is not this function's
   * question: the rule is the schema's own and the drawing side applies it (`petBubbleOpacityOf`),
   * exactly as the host's store normalizes the record before the command reads it.
   */
  function storedBubbleOpacity(): number {
    const load = settings.read('message')
    if (load.status === 'read-only') return PET_SETTINGS_DEFAULTS.message.opacity
    const values = load.record.values as PetSettingsValues['message']
    return typeof values.opacity === 'number'
      ? values.opacity
      : PET_SETTINGS_DEFAULTS.message.opacity
  }

  /**
   * The `general` record's ball diameter, as the host reads it into every appearance arm.
   *
   * `stored_ball_size`'s rule (`window_host.rs`): a member that is not a number takes the schema's
   * default (upstream's `--ball-size`, and the size this build's ball was drawn at before the field
   * existed), and a `general` record this build may not read takes it too — a size the user never
   * chose is a change to what they see, not a default. What is *in range* is not this function's
   * question, and deliberately: the rule is the schema's own and the drawing side applies it
   * (`petBallSizeOf`), exactly as the host's store normalizes the record before the command reads
   * it — the host's own read doesn't clamp either.
   */
  function storedBallSize(): number {
    const load = settings.read('general')
    if (load.status === 'read-only') return PET_SETTINGS_DEFAULTS.general.ballSize
    const values = load.record.values as PetSettingsValues['general']
    return typeof values.ballSize === 'number'
      ? values.ballSize
      : PET_SETTINGS_DEFAULTS.general.ballSize
  }

  return {
    library() {
      return [...installed]
    },

    appearance(): PetAppearance {
      const { selected, values } = storedCharacter()
      // The three facts that are not the character's, read once and carried on every arm — a fresh
      // install's ball still moves, is still drawn, and is still an orb of some size, so an
      // appearance that only arrived with a chosen character would leave the one surface this build
      // has that moves unreduced, the bubble at whatever the window's own constant said, and the
      // orb at whatever size the page's own default was.
      const motion = storedMotion()
      const bubbleOpacity = storedBubbleOpacity()
      const ballSize = storedBallSize()
      if (selected === null) return { status: 'unset', motion, bubbleOpacity, ballSize }
      const entry = installed.find((candidate) => candidate.characterId === selected)
      if (entry === undefined) {
        return {
          status: 'missing',
          characterId: selected,
          detail: 'it is not installed in the character library',
          motion,
          bubbleOpacity,
          ballSize,
        }
      }
      if (entry.files === 'damaged') {
        return {
          status: 'missing',
          characterId: selected,
          detail: 'its files are not what the library recorded',
          motion,
          bubbleOpacity,
          ballSize,
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
        motion,
        bubbleOpacity,
        ballSize,
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
