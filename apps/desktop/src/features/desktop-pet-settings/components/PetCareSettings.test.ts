/**
 * The care page: the two settings it stores, and the absence it has to state.
 *
 * The absence is the half worth a test. Levels, achievements and usage have no ledger in this
 * build (D10), and the failure this port's acceptance clause names is not a missing feature —
 * it is a page that shows something anyway, or a switch that looks like it does something. So
 * these assert that the statement is there, that the only controls are the two switches, and
 * that nothing renders a progress number.
 *
 * The session is the container's, so the context is built the way `DesktopPetSettings.vue`
 * builds it and the page is mounted the way its slot renders it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, shallowRef, type App as VueApp } from 'vue'
import PetCareSettings from './PetCareSettings.vue'
import { t, setLocale } from '../../../i18n'
import { PET_SETTINGS_DEFAULTS } from '../../../platform/gateways/pet-contracts'
import {
  createMemoryPetGateway,
  type MemoryPetGateway,
  type MemoryPetOptions,
} from '../../../platform/gateways/memory-pet'
import { PET_SETTINGS_DEBOUNCE_MS, usePetSettings } from '../composables/use-pet-settings'
import { petSettingsRecordFor, petSettingsWrite } from '../services/pet-settings-policy'
import type { PetSettingsContext, PetSettingsSessions } from './DesktopPetSettings.vue'

let mounted: VueApp[] = []

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

  it('states that nothing is settled rather than showing a progress number', async () => {
    const context = await makeContext()
    await context.sessions.care.load()
    await mount(context)

    expect(document.querySelector('[data-test="pet-care-progress"]')?.textContent?.trim()).toBe(
      t('settings.pet.care.progressUnavailable'),
    )
    // The only controls are the two switches: no level field, no reset-progress button, and
    // nothing that renders progress as a number or a bar.
    expect(document.querySelectorAll('input')).toHaveLength(2)
    expect(document.querySelectorAll('button')).toHaveLength(0)
    expect(document.querySelector('[role="progressbar"]')).toBeNull()
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
    const context = await makeContext({ storedSchemaVersion: 2 })
    await context.sessions.care.load()
    await mount(context)

    expect(document.querySelector('[data-test="pet-care-read-only"]')?.textContent?.trim()).toBe(
      t('settings.pet.readOnly'),
    )
    expect(document.querySelectorAll('input')).toHaveLength(0)
    expect(document.querySelector('[data-test="pet-care-status"]')).toBeNull()
    // The statement about what is missing is true of the build either way.
    expect(document.querySelector('[data-test="pet-care-progress"]')).not.toBeNull()
  })
})
