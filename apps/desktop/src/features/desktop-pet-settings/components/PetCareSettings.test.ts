/**
 * The care page: the two settings it stores, what the ledger settled, and the sentence it has to
 * state when the ledger holds nothing.
 *
 * The ledger half is the one worth a test. D10's ledger settles levels, achievements and usage, and
 * this page is the surface that reads it — so the failures that matter are the two ways the read
 * can be misread. An empty ledger is answered with `empty` and must draw *no numbers at all* (a
 * level 0 is the invented figure §8 rules out, in the same words it uses for an unknown token
 * count), and a summary must arrive in the catalogue's words rather than in the panel's English
 * defaults. Both are asserted below, and so is the case in between: a host that refused the read is
 * neither of those, and the page says so instead of reporting "no progress".
 *
 * The wording lives in the catalogue, so the assertions pin the keys
 * (`settings.pet.care.progressEmpty`, `settings.pet.care.panel.*`) rather than the prose: a page
 * that stopped rendering a statement fails here, and a sentence that stops being true is the
 * catalogue's to fix — which is what happened twice already, first when D10 landed the ledger and
 * again when this page learned to read it.
 *
 * The session is the container's, so the context is built the way `DesktopPetSettings.vue`
 * builds it and the page is mounted the way its slot renders it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, shallowRef, type App as VueApp } from 'vue'
import PetCareSettings from './PetCareSettings.vue'
import { t, setLocale } from '../../../i18n'
import {
  PET_SETTINGS_DEFAULTS,
  PET_SETTINGS_SCHEMA_VERSION,
  type PetCareSummary,
} from '../../../platform/gateways/pet-contracts'
import { PET_CARE_PANEL_LABELS } from '../../desktop-pet'
import {
  createMemoryPetGateway,
  type MemoryPetGateway,
  type MemoryPetOptions,
} from '../../../platform/gateways/memory-pet'
import { PET_SETTINGS_DEBOUNCE_MS, usePetSettings } from '../composables/use-pet-settings'
import { petSettingsRecordFor, petSettingsWrite } from '../services/pet-settings-policy'
import { carePanelLabels } from './pet-care-labels'
import type { PetSettingsContext, PetSettingsSessions } from './DesktopPetSettings.vue'

let mounted: VueApp[] = []

/**
 * One settlement, as the ledger's read would hand it over: level 5 shown (the curve reaches
 * internal level 6 at 60·6·5 = 1800), three completions, a day whose usage nobody reported.
 */
const LEDGER: PetCareSummary = {
  schemaVersion: 1,
  revision: 3,
  xp: 2160,
  meals: 3,
  streakDays: 2,
  unlocked: [],
  days: [{ day: '2026-09-15', completions: 2, tokens: null }],
  reportedTokens: 4200,
  unreportedRuns: 2,
  lastSettledAt: 1_789_000_000_000,
}

/** One session per domain, under the domain it is a session of — the container's own shape. */
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

async function makeContext(options: MemoryPetOptions = {}): Promise<PetSettingsContext> {
  const gateway = createMemoryPetGateway(options)
  return {
    gateway,
    sessions: sessionsFor(gateway),
    capabilities: shallowRef(await gateway.capabilities()),
  }
}

/** Past the debounce window, with the microtasks behind it drained. */
async function tick(ms = PET_SETTINGS_DEBOUNCE_MS): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 3; i += 1) await vi.advanceTimersByTimeAsync(0)
}

async function settle(): Promise<void> {
  await nextTick()
  await vi.advanceTimersByTimeAsync(0)
  await nextTick()
}

async function mount(context: PetSettingsContext): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(PetCareSettings, { context })
  app.mount(host)
  mounted.push(app)
  await settle()
}

/** What the store holds for care, read the way a caller has to read it. */
async function storedCare(gateway: MemoryPetGateway): Promise<typeof PET_SETTINGS_DEFAULTS.care> {
  const loaded = await gateway.readSettings('care')
  if (loaded.status !== 'current') throw new Error(`expected current, got ${loaded.status}`)
  const record = petSettingsRecordFor(loaded.record, 'care')
  if (record === null) throw new Error('the store answered for another domain')
  return record.values
}

function toggle(selector: string, checked: boolean): void {
  const box = document.querySelector<HTMLInputElement>(selector)
  if (box === null) throw new Error(`${selector} is not on the page`)
  box.checked = checked
  box.dispatchEvent(new Event('change'))
}

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

describe('the care page', () => {
  it('shows the stored settings and writes a change through the container\'s session', async () => {
    const context = await makeContext()
    await context.gateway.updateSettings(
      petSettingsWrite('care', 1, { enabled: true, restReminders: false }),
    )
    // The container loads the domain when the page becomes active; the page never does.
    await context.sessions.care.load()
    await mount(context)

    expect(document.querySelector<HTMLInputElement>('[data-test="pet-care-enabled"]')?.checked).toBe(
      true,
    )
    expect(
      document.querySelector<HTMLInputElement>('[data-test="pet-care-rest-reminders"]')?.checked,
    ).toBe(false)

    toggle('[data-test="pet-care-rest-reminders"]', true)
    await nextTick()
    expect(document.querySelector('[data-test="pet-care-status"]')?.textContent).toBe(
      t('settings.pet.save.pending'),
    )

    await tick()
    expect(await storedCare(context.gateway)).toEqual({
      ...PET_SETTINGS_DEFAULTS.care,
      restReminders: true,
    })
    expect(document.querySelector('[data-test="pet-care-status"]')?.textContent).toBe(
      t('settings.pet.save.saved'),
    )
  })

  it('reads nothing by itself: a domain the container has not loaded stays unread', async () => {
    // The session is not loaded here, which is what the container leaves when the page is not
    // the active one. A page that read on its own would show values the session never read.
    const context = await makeContext()
    const read = vi.spyOn(context.gateway, 'readSettings')
    await mount(context)

    expect(read).not.toHaveBeenCalled()
    expect(document.querySelector('[data-test="pet-care-status"]')?.textContent).toBe(
      t('settings.pet.save.loading'),
    )
  })

  it('states that nothing has settled yet rather than drawing a zero', async () => {
    const context = await makeContext()
    await context.sessions.care.load()
    await mount(context)

    // The host answers `empty` for a ledger nothing settled into, and the page's answer is a
    // sentence: level 0, 0 completed and an empty bar are what a summary of zeroes would have put
    // on screen for a user who has completed five hundred runs (§8).
    expect(document.querySelector('[data-test="pet-care-progress-note"]')?.textContent?.trim()).toBe(
      t('settings.pet.care.progressEmpty'),
    )
    expect(document.querySelector('[data-test="pet-care-panel"]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/[0-9]/)
    // The only controls are the two switches: no level field, no reset-progress button, and
    // nothing that renders progress as a number or a bar.
    expect(document.querySelectorAll('input')).toHaveLength(2)
    expect(document.querySelectorAll('button')).toHaveLength(0)
    expect(document.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('draws what the ledger settled, in this page’s wording rather than the panel’s', async () => {
    const context = await makeContext({ care: LEDGER })
    await context.sessions.care.load()
    await mount(context)

    const wording = carePanelLabels()
    expect(document.querySelector('[data-test="pet-care-panel"]')).not.toBeNull()
    // The catalogue's sentences reach the panel: the level row is the page's wording with the
    // panel's own slot filling, and the stage is the vocabulary word for the displayed level.
    // A page that passed no labels would show `PET_CARE_PANEL_LABELS` instead, which is the
    // failure this assertion is for — the panel defaults are English and the locale here is not.
    expect(document.querySelector('[data-test="pet-care-level"]')?.textContent?.trim()).toBe(
      wording.level.replace('{level}', '5'),
    )
    expect(document.querySelector('[data-test="pet-care-stage"]')?.textContent?.trim()).toBe(
      wording.stages.companion,
    )
    expect(wording.level).not.toBe(PET_CARE_PANEL_LABELS.level)
    // The statement is replaced by the numbers, not shown beside them.
    expect(document.querySelector('[data-test="pet-care-progress-note"]')).toBeNull()
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50')
  })

  it('says the read was refused, which is not the same as nothing having settled', async () => {
    const context = await makeContext()
    await context.sessions.care.load()
    vi.spyOn(context.gateway, 'care').mockRejectedValue(new Error('the host did not answer'))
    await mount(context)

    // "Nothing is recorded" and "I could not ask" look identical on a blank page, and they call
    // for different things from the user — so the page shows the host's own words.
    expect(document.querySelector('[data-test="pet-care-progress-note"]')?.textContent).toContain(
      'the host did not answer',
    )
    expect(document.querySelector('[data-test="pet-care-progress-note"]')?.textContent?.trim()).toBe(
      t('settings.pet.care.progressUnreadable', { msg: 'the host did not answer' }),
    )
    expect(document.querySelector('[data-test="pet-care-panel"]')).toBeNull()
  })

  it('shows a failed write as failed, and retries it with the values it failed on', async () => {
    const context = await makeContext({ writeFailures: 1 })
    await context.sessions.care.load()
    await mount(context)

    toggle('[data-test="pet-care-enabled"]', false)
    await tick()

    expect(document.querySelector('[data-test="pet-care-status"]')?.textContent).toBe(
      t('settings.pet.save.failed'),
    )
    expect(await storedCare(context.gateway)).toEqual(PET_SETTINGS_DEFAULTS.care)

    document.querySelector<HTMLButtonElement>('[data-test="pet-care-retry"]')?.click()
    await settle()

    expect(await storedCare(context.gateway)).toEqual({
      ...PET_SETTINGS_DEFAULTS.care,
      enabled: false,
    })
    expect(document.querySelector('[data-test="pet-care-status"]')?.textContent).toBe(
      t('settings.pet.save.saved'),
    )
    expect(document.querySelector('[data-test="pet-care-retry"]')).toBeNull()
  })

  it('draws no controls at all for a store a newer build wrote', async () => {
    // §10.2: the session answers a refused read with *this build's* defaults, so a form here
    // would be showing numbers the user never chose and offering to save them back.
    const context = // One past this build's own: a literal `2` was "newer" only while the build wrote 1.
    await makeContext({ storedSchemaVersion: PET_SETTINGS_SCHEMA_VERSION + 1 })
    await context.sessions.care.load()
    await mount(context)

    expect(document.querySelector('[data-test="pet-care-read-only"]')?.textContent?.trim()).toBe(
      t('settings.pet.readOnly'),
    )
    expect(document.querySelectorAll('input')).toHaveLength(0)
    expect(document.querySelector('[data-test="pet-care-status"]')).toBeNull()
    // The statement about what is recorded is true of the ledger either way — this page reads it
    // through the host, not through the settings store the newer build wrote.
    expect(document.querySelector('[data-test="pet-care-progress-note"]')).not.toBeNull()
  })
})
