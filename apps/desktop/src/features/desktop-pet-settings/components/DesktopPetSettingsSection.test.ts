/**
 * The pet's settings section, as one element (§5.1, §10.1).
 *
 * What this suite is for: the five slot fills and the two built-in pages have to add up to §5.1's
 * seven, and every one of them has to be *reachable* through the rail — because the container's
 * own rule is that a page with no component behind it is not offered at all (「不显示可点击但无效果的
 * 控件」). Before this file existed, five of the seven were reported rather than wired: the container
 * offered `general` and `notification` and printed the names of the pages that had no component
 * yet. That sentence no longer appearing is the assertion.
 *
 * Mounted the way this feature's other component suites mount (a real `createApp` and DOM queries,
 * no test-utils): the point is what a user can reach, and the DOM is where that is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp } from 'vue'
import { PET_SETTINGS_PAGES, type PetGateway } from '../../../platform/gateways/pet-contracts'
import { createMemoryPetGateway } from '../../../platform/gateways/memory-pet'
import DesktopPetSettingsSection from './DesktopPetSettingsSection.vue'

let mounted: VueApp[] = []

beforeEach(() => {
  document.body.innerHTML = ''
  mounted = []
  // happy-dom exposes no `matchMedia`; the container's preview reads one query through it.
  globalThis.matchMedia = vi.fn(() => ({
    matches: false,
    media: '',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as never
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

/** Mount the section the way a settings panel would: one element, one gateway prop. */
async function mountSection(properties: { gateway: PetGateway | null; page?: string }): Promise<VueApp> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(() => h(DesktopPetSettingsSection, properties))
  app.mount(host)
  mounted.push(app)
  await nextTick()
  return app
}

/** The tabs the rail offers, in the order it draws them. */
function rail(): string[] {
  return [...document.querySelectorAll('.pet-settings__tab')].map(
    (tab) => tab.getAttribute('data-page') ?? '',
  )
}

function active(): string | null {
  return document.querySelector('.pet-settings__tab.active')?.getAttribute('data-page') ?? null
}

async function open(page: string): Promise<void> {
  document.querySelector<HTMLElement>(`.pet-settings__tab[data-page="${page}"]`)?.click()
  await nextTick()
  await nextTick()
}

function section(page?: string): { gateway: PetGateway; page?: string } {
  return page
    ? { gateway: createMemoryPetGateway({ visible: true }), page }
    : { gateway: createMemoryPetGateway({ visible: true }) }
}

describe('every page of §5.1 is reachable through this one element', () => {
  it('offers all seven, in the contract’s order', async () => {
    await mountSection(section())

    expect(rail()).toEqual([...PET_SETTINGS_PAGES])
  })

  it('says nothing about pages that have not landed, because none are missing', async () => {
    await mountSection(section())

    // The container renders this sentence when a page has no component behind it, and five pages
    // were in it until this file filled the slots. A suite that only counted rail rows would pass
    // again if one of the five went away and a row stayed behind for something else.
    expect(document.querySelector('.pet-settings__pending')).toBeNull()
  })

  it.each(['character', 'bubble', 'care', 'project', 'advanced'])(
    'opens %s from its own rail row and draws something',
    async (page) => {
      await mountSection(section())

      await open(page)

      expect(active()).toBe(page)
      // A slot that was not filled renders as an empty comment, so "the rail moved" is not the
      // claim — the content area having text is.
      const content = document.querySelector('.pet-settings__content')
      expect(content?.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    },
  )

  it('arrives on the page a deep link named', async () => {
    // §5.1: the pet's right-click names a page. Before the pages were wired a request for `care`
    // landed on `general` — correctly, because the page did not exist in this build.
    await mountSection(section('care'))

    expect(active()).toBe('care')
  })

  it('reports the page a user moved to, so a host can follow', async () => {
    const moved: string[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(() =>
      h(DesktopPetSettingsSection, {
        ...section(),
        'onUpdate:page': (page: string) => moved.push(page),
      }),
    )
    app.mount(host)
    mounted.push(app)
    await nextTick()

    await open('project')

    // `v-model:page` is how a mounting host keeps its own idea of the page in step, which is what
    // a remembered position needs — and the container's own emit is what this must not swallow.
    expect(moved).toEqual(['project'])
    expect(active()).toBe('project')
  })

  it('states a missing host instead of drawing a page of defaults', async () => {
    await mountSection({ gateway: null })

    // The gateway prop is required and nullable: unwired is a state with a sentence, not a form
    // full of numbers nobody chose.
    expect(document.querySelector('.pet-settings__rail')).toBeNull()
    expect(document.querySelector('.pet-settings__absence')?.textContent?.trim().length ?? 0).toBeGreaterThan(0)
  })
})
