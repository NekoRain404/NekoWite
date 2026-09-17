/**
 * The catalogue's pure half: which offers a page draws, and what it says about their terms.
 *
 * The states and the adoption plan have cases next door in `pet-library-policy.test.ts`, where the
 * library and the catalogue meet. What is here is the part a four-thousand-row gallery is actually
 * made of — narrowing and marking — because a page that filtered wrongly would offer a user a
 * character that is not there, and one that marked wrongly would tell them the catalogue said
 * something it did not.
 */
import { describe, expect, it } from 'vitest'
import {
  catalogueKinds,
  filterCatalogueOffers,
  statesTerms,
  type PetCatalogueOffer,
} from './pet-catalogue'

function offer(overrides: Partial<PetCatalogueOffer> = {}): PetCatalogueOffer {
  return {
    slug: 'boba',
    name: 'Boba',
    author: 'railly',
    kind: 'creature',
    terms: null,
    ...overrides,
  }
}

describe('filtering a catalogue', () => {
  const offers = [
    offer({ slug: 'boba', name: 'Boba', kind: 'creature' }),
    offer({ slug: 'sukuna', name: 'Sukuna', kind: 'character' }),
    offer({ slug: 'lulu-capybara-2', name: '噜噜', kind: 'creature' }),
    offer({ slug: 'desk', name: 'Desk Lamp', kind: null }),
  ]

  it('matches on the name or the id, case-insensitively', () => {
    expect(filterCatalogueOffers(offers, 'BOB', null).map((entry) => entry.slug)).toEqual(['boba'])
    expect(filterCatalogueOffers(offers, 'sukuna', null).map((entry) => entry.slug)).toEqual([
      'sukuna',
    ])
    // The id as well as the name: a user who half-remembers a slug has to be able to find it, and
    // `capybara` is in the id of a row whose name is not in Latin script at all.
    expect(filterCatalogueOffers(offers, 'capybara', null).map((entry) => entry.slug)).toEqual([
      'lulu-capybara-2',
    ])
  })

  it('treats a blank search as the absence of a filter and not as a filter matching nothing', () => {
    expect(filterCatalogueOffers(offers, '', null)).toHaveLength(4)
    expect(filterCatalogueOffers(offers, '   ', null)).toHaveLength(4)
  })

  it('filters by a category word and by nothing else', () => {
    expect(filterCatalogueOffers(offers, '', 'creature').map((entry) => entry.slug)).toEqual([
      'boba',
      'lulu-capybara-2',
    ])
    // An offer that states no category is not in any category: null is "the catalogue did not say",
    // and matching it against a word the user picked would put it in a group it never claimed.
    expect(filterCatalogueOffers(offers, '', 'character').map((entry) => entry.slug)).toEqual([
      'sukuna',
    ])
  })

  it('combines the search and the category rather than choosing one of them', () => {
    expect(filterCatalogueOffers(offers, 'lamp', 'creature')).toHaveLength(0)
    expect(filterCatalogueOffers(offers, 'lamp', null).map((entry) => entry.slug)).toEqual(['desk'])
  })

  it('offers the category words the offers actually use, each once', () => {
    expect(catalogueKinds(offers)).toEqual(['creature', 'character'])
    // From the data and not from a list here: a catalogue that grows a sixth word gets a sixth
    // button, and one whose words are all different does not lose rows to a vocabulary this build
    // fixed in advance.
    expect(catalogueKinds([offer({ kind: 'western' }), offer({ kind: 'asian' })])).toEqual([
      'western',
      'asian',
    ])
    expect(catalogueKinds([offer({ kind: null })])).toEqual([])
  })
})

describe('terms', () => {
  it('reports an offer that states none as stating none, and never as consent', () => {
    // The distinction the row exists to draw. Null is a fact about the catalogue; an empty string
    // is a stated field with nothing in it, and a page that drew "the catalogue states: " over one
    // would be putting words in its mouth.
    expect(statesTerms(offer({ terms: null }))).toBe(false)
    expect(statesTerms(offer({ terms: '' }))).toBe(false)
    expect(statesTerms(offer({ terms: '   ' }))).toBe(false)
    expect(statesTerms(offer({ terms: 'CC0-1.0' }))).toBe(true)
  })
})
