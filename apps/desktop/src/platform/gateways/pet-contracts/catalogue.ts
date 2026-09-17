/**
 * The catalogue, as the host read it (§8's 在线角色库).
 *
 * A part of `../pet-contracts` because it moves for its own reason: the library, the settings and
 * the tasks are unchanged by a new way of fetching a character. What is here is the *wire* — the
 * shapes `desktop_pet_catalogue` answers with, field for field — and not a second policy:
 * `features/desktop-pet/services/pet-catalogue.ts` is what turns these into states, plans and
 * filtered rows, and it is a separate file so that a page cannot form its own opinion about what a
 * catalogue is.
 *
 * **No address crosses this boundary in either direction.** An offer carries a slug, a name, a
 * byline and a category, and the address it would be downloaded from is resolved on the host side
 * from a catalogue the host itself read. That is §7.1's shape — "a caller names a character, never
 * a window" — one layer over, and it is why {@link PetGateway.adoptCharacter} takes a slug and
 * there is no method anywhere in this contract that would accept a URL.
 */

/** One offer, as the host listed it. */
export interface PetCatalogueOffer {
  slug: string
  name: string
  /** The catalogue's own byline (`submittedBy`), or null when it states none. Not a rights grant. */
  author: string | null
  /** The catalogue's own category word, or null. The vocabulary is the catalogue's, not ours. */
  kind: string | null
  /**
   * The terms the catalogue stated, or null when it stated none.
   *
   * Null is a fact about the catalogue and not about the character — see the feature module's
   * header. It does not block an install: the row is marked and the page says what is missing.
   */
  terms: string | null
}

/**
 * What one catalogue read answered.
 *
 * Five arms and none of them is an empty list standing in for a failure, which is the defect §3.1
 * records against the upstream client's `catalog.ts`: 「区分离线、空库、损坏」.
 *
 * `unconfigured` is a build with no endpoint (a real build: §10.1 makes an endpoint a reviewed
 * change to the repository). A page that has not asked yet holds no reading at all rather than
 * this arm, which is why there is no `unasked` here — the host is never in that state.
 */
export type PetCatalogueReading =
  /** No catalogue endpoint is configured in this build. */
  | { status: 'unconfigured' }
  /** No request completed, or none was made. `detail` is the host's own diagnostic. */
  | { status: 'unreachable'; detail: string }
  /** A response arrived and is not a catalogue. */
  | { status: 'unreadable'; detail: string }
  /** A catalogue answered, and nothing in it can be installed. */
  | { status: 'empty'; skipped: number }
  | { status: 'listed'; offers: readonly PetCatalogueOffer[]; skipped: number }

/**
 * Whether a value off the IPC boundary is one of those arms.
 *
 * Written out rather than assumed, the way {@link isPetAppearance} is: the answer is discarded by
 * the adapter and re-read from the host on the next call, so a frame that fails this is dropped
 * rather than drawn, and a page then says the catalogue could not be read — which is true.
 */
export function isPetCatalogueReading(value: unknown): value is PetCatalogueReading {
  if (typeof value !== 'object' || value === null) return false
  const reading = value as { status?: unknown; offers?: unknown; skipped?: unknown; detail?: unknown }
  switch (reading.status) {
    case 'unconfigured':
      return true
    case 'unreachable':
    case 'unreadable':
      return typeof (value as { detail?: unknown }).detail === 'string'
    case 'empty':
      return typeof (value as { skipped?: unknown }).skipped === 'number'
    case 'listed':
      return (
        typeof reading.skipped === 'number' &&
        Array.isArray(reading.offers) &&
        reading.offers.every(isPetCatalogueOffer)
      )
    default:
      return false
  }
}

/** Whether one entry of a listing is an offer this build can draw a row for. */
function isPetCatalogueOffer(value: unknown): value is PetCatalogueOffer {
  if (typeof value !== 'object' || value === null) return false
  const offer = value as Record<string, unknown>
  if (typeof offer.slug !== 'string' || typeof offer.name !== 'string') return false
  return (['author', 'kind', 'terms'] as const).every((field) => {
    const found = offer[field]
    return found === null || found === undefined || typeof found === 'string'
  })
}
