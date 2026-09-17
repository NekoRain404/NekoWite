/**
 * The catalogue browser: the four states it can be in, what a download looks like while it runs,
 * and what is left on screen when one fails.
 *
 * Three things are asserted, and the last two are the ones a gallery is usually wrong about:
 *
 *  - **Every state has a sentence, and no two share one.** `unasked`, `unconfigured`,
 *    `unreachable`, `unreadable` and `empty` are five different things to tell a user, and the
 *    defect the vocabulary exists for is collapsing them — upstream's `loadCatalog` returns `[]`
 *    on every failure (`catalog.ts:24-30`, ledger §7.5).
 *  - **A failed download does not take the list with it.** A banner appears, the rows stay, and the
 *    button is usable again: a failure that blanked the gallery would take away the user's ability
 *    to pick a different character over one bad row.
 *  - **An offer that states no terms is installable and is marked.** The maintainer's ruling is
 *    「许可我们最后解决，能接的全部接入」, and every entry of every catalogue available today states
 *    none — so a browser that blocked on that would offer four thousand rows none of which works,
 *    and one that stayed silent would be hiding the question rather than deferring it.
 *
 * The double answers a scripted reading and a scripted refusal, which is what makes the failure
 * half reachable: a real download can only fail by being made to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef, type App as VueApp } from 'vue'
import PetCatalogueBrowser from './PetCatalogueBrowser.vue'
import { t, setLocale } from '../../../i18n'
import type {
  PetCatalogueOffer,
  PetCatalogueReading,
  PetCharacterEntry,
} from '../../../platform/gateways/pet-contracts'
import {
  createMemoryPetGateway,
  type MemoryPetGateway,
  type MemoryPetOptions,
} from '../../../platform/gateways/memory-pet'
import { usePetSettings } from '../composables/use-pet-settings'
import type { PetSettingsContext, PetSettingsSessions } from './DesktopPetSettings.vue'

let mounted: VueApp[] = []

function sessionsFor(gateway: MemoryPetGateway): PetSettingsSessions {
  return {
    general: usePetSettings({ authority: gateway, domain: 'general' }),
    character: usePetSettings({ authority: gateway, domain: 'character' }),
    view: usePetSettings({ authority: gateway, domain: 'view' }),
    message: usePetSettings({ authority: gateway, domain: 'message' }),
    notification: usePetSettings({ authority: gateway, domain: 'notification' }),
    care: usePetSettings({ authority: gateway, domain: 'care' }),
    project: usePetSettings({ authority: gateway, domain: 'project' }),
  }
}

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

const LISTED: PetCatalogueReading = {
  status: 'listed',
  offers: [
    offer(),
    offer({ slug: 'sukuna', name: 'Sukuna', kind: 'character', author: null }),
    offer({ slug: 'desk', name: 'Desk Lamp', kind: null, terms: 'CC0-1.0' }),
  ],
  skipped: 4,
}

interface Mounted {
  gateway: MemoryPetGateway
  installed: string[]
}

/**
 * Mount the browser over a scripted double.
 *
 * `settled: false` leaves the read in flight, which is the one state a caller cannot reach by
 * waiting — so it is a parameter here rather than a second `createApp` below, which would also be a
 * second component in this file for no reason a reader could see.
 */
async function mount(
  options: MemoryPetOptions = {},
  behavior: { settled?: boolean } = {},
): Promise<Mounted> {
  const gateway = createMemoryPetGateway(options)
  const context: PetSettingsContext = {
    gateway,
    sessions: sessionsFor(gateway),
    capabilities: shallowRef([]),
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const installed: string[] = []
  // The inline root the sibling page tests use: one component per file is the rule, and a test
  // that mounts a page has no business defining a second one.
  const app = createApp({
    render: () =>
      h(PetCatalogueBrowser, {
        context,
        onInstalled: (entry: PetCharacterEntry) => installed.push(entry.characterId),
      }),
  })
  app.mount(host)
  mounted.push(app)
  if (behavior.settled !== false) await settle()
  return { gateway, installed }
}

async function settle(): Promise<void> {
  await nextTick()
  await vi.advanceTimersByTimeAsync(0)
  await nextTick()
}

const text = (selector: string): string =>
  document.querySelector(`[data-test="${selector}"]`)?.textContent?.trim() ?? ''

const rows = (): Element[] => [...document.querySelectorAll('[data-test^="pet-catalogue-row-"]')]

beforeEach(() => {
  vi.useFakeTimers()
  setLocale('zh')
  mounted = []
  document.body.innerHTML = ''
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('the catalogue browser', () => {
  it('draws one sentence per state, and never the same sentence twice', async () => {
    const seen = new Set<string>()
    for (const reading of [
      { status: 'unconfigured' },
      { status: 'unreachable', detail: 'the host answered 503' },
      { status: 'unreadable', detail: 'not JSON' },
      { status: 'empty', skipped: 0 },
    ] satisfies PetCatalogueReading[]) {
      document.body.innerHTML = ''
      mounted = []
      await mount({ catalogue: reading })
      const sentence = text('pet-catalogue-state')
      expect(sentence, reading.status).not.toBe('')
      // The status word is drawn from the arm the host sent, so the two cannot drift: a page that
      // said "unreachable" for an unreadable catalogue is the defect this whole file is about.
      expect(
        document.querySelector('[data-test="pet-catalogue-state"]')?.getAttribute('data-status'),
        reading.status,
      ).toBe(reading.status)
      seen.add(sentence)
    }
    expect(seen.size).toBe(4)
  })

  it('says nothing about the catalogue until the host has answered', async () => {
    // `unasked` is a state the page is in for one tick, and a page that drew "no catalogue is
    // configured" during it would be making a claim it had to take back.
    await mount({ catalogue: LISTED }, { settled: false })
    expect(document.querySelector('[data-test="pet-catalogue-state"]')).toBeNull()

    await settle()
    // And then it is `listed`, so the state line is absent for a reason and not by accident: the
    // search box only exists in that arm.
    expect(document.querySelector('[data-test="pet-catalogue-state"]')).toBeNull()
    expect(document.querySelector('[data-test="pet-catalogue-list"]')).not.toBeNull()
  })

  it('shows the host diagnostic under the sentence, and offers to ask again', async () => {
    await mount({ catalogue: { status: 'unreachable', detail: 'the host answered 503' } })
    expect(text('pet-catalogue-detail')).toContain('503')
    const reload = document.querySelector<HTMLButtonElement>('[data-test="pet-catalogue-reload"]')
    expect(reload).not.toBeNull()
    // An unreachable catalogue is the one state a user can do something about, so it is the one
    // state with a control — and it is a real request, not a control that saves a value.
    expect(reload?.disabled).toBe(false)
  })

  it('lists the offers, states how many matched and how many this build cannot install', async () => {
    await mount({ catalogue: LISTED })
    expect(rows()).toHaveLength(3)
    expect(text('pet-catalogue-count')).toContain('3')
    expect(text('pet-catalogue-skipped')).toContain('4')
  })

  it('narrows the list by search and by category without a round trip', async () => {
    await mount({ catalogue: LISTED })
    const search = document.querySelector<HTMLInputElement>('[data-test="pet-catalogue-search"]')
    expect(search).not.toBeNull()

    search!.value = 'suk'
    search!.dispatchEvent(new Event('input'))
    await settle()
    expect(rows()).toHaveLength(1)

    search!.value = 'zzz'
    search!.dispatchEvent(new Event('input'))
    await settle()
    expect(rows()).toHaveLength(0)
    expect(text('pet-catalogue-no-matches')).not.toBe('')
  })

  it('marks an offer that states no terms and leaves it installable', async () => {
    await mount({ catalogue: LISTED })
    const bare = document.querySelector('[data-test="pet-catalogue-row-boba"]')
    const stated = document.querySelector('[data-test="pet-catalogue-row-desk"]')
    expect(bare?.getAttribute('data-terms')).toBe('unstated')
    expect(stated?.getAttribute('data-terms')).toBe('stated')
    expect(bare?.textContent).toContain(t('settings.pet.character.catalogue.termsUnstated'))
    expect(stated?.textContent).toContain('CC0-1.0')

    // And the button is there: deferring the licence question means not blocking on it.
    const button = document.querySelector<HTMLButtonElement>(
      '[data-test="pet-catalogue-install-boba"]',
    )
    expect(button).not.toBeNull()
    expect(button?.disabled).toBe(false)
  })

  it('installs an offer and hands the character up, which is where the selection happens', async () => {
    const { installed } = await mount({ catalogue: LISTED })
    document
      .querySelector<HTMLButtonElement>('[data-test="pet-catalogue-install-boba"]')
      ?.click()
    await settle()

    expect(installed).toEqual(['boba'])
    // The library is the page's above, not this component's: what it does with the character is
    // its own business, and a browser that also wrote a selection would be a second author of it.
    expect(document.querySelector('[data-test="pet-catalogue-failure"]')).toBeNull()
  })

  it('keeps the list on screen when a download is refused, and says what refused', async () => {
    const { installed } = await mount({
      catalogue: LISTED,
      adoptRefusal: 'boba is not the catalogue’s own host; this build downloads only from it',
    })
    document
      .querySelector<HTMLButtonElement>('[data-test="pet-catalogue-install-boba"]')
      ?.click()
    await settle()

    expect(installed).toEqual([])
    // §8's rules refuse *before* a request is made, so this is a sentence rather than a timeout —
    // and the sentence is the host's, naming the check that refused.
    expect(text('pet-catalogue-failure')).toContain('downloads only from')
    expect(rows()).toHaveLength(3)
    // And the button is usable again: the failure is about one offer and not about the catalogue.
    expect(
      document.querySelector<HTMLButtonElement>('[data-test="pet-catalogue-install-boba"]')
        ?.disabled,
    ).toBe(false)
  })

  it('refuses a second download while one is running, and allows one after it', async () => {
    const { gateway, installed } = await mount({ catalogue: LISTED })
    let release: (value: unknown) => void = () => {}
    const held = new Promise((resolve) => {
      release = resolve
    })
    const original = gateway.adoptCharacter.bind(gateway)
    gateway.adoptCharacter = async (slug: string) => {
      await held
      return original(slug)
    }

    document
      .querySelector<HTMLButtonElement>('[data-test="pet-catalogue-install-boba"]')
      ?.click()
    await settle()

    // While the transfer is in flight, every row's button is disabled — one transfer at a time,
    // because a second is a second download of something the user asked for once.
    for (const row of rows()) {
      expect(row.querySelector('button')?.disabled, row.getAttribute('data-test') ?? '').toBe(true)
    }
    release(undefined)
    await settle()
    expect(installed).toEqual(['boba'])
  })
})
