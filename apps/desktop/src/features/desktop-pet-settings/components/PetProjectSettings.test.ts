/**
 * The project page: the character cap, which is real, and the library binding, which is not in
 * this build.
 *
 * The cap's test is about what cannot be entered, not only about what is saved: the control is
 * a list over D1's own rule, so an out-of-range value has no representation and the store never
 * has to refuse one. The binding's test is the other half — §5.2 keeps the entry and forbids the
 * dead control (「不显示可点击但无效果的控件」), so the assertion is that the page states the gap
 * and that the row holds no control at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, shallowRef, type App as VueApp } from 'vue'
import PetProjectSettings from './PetProjectSettings.vue'
import { t, setLocale } from '../../../i18n'
import {
  PET_NUMBER_RULES,
  PET_SETTINGS_DEFAULTS,
  PET_SETTINGS_SCHEMA_VERSION,
} from '../../../platform/gateways/pet-contracts'
import {
  createMemoryPetGateway,
  type MemoryPetGateway,
  type MemoryPetOptions,
} from '../../../platform/gateways/memory-pet'
import { PET_SETTINGS_DEBOUNCE_MS, usePetSettings } from '../composables/use-pet-settings'
import { petSettingsRecordFor } from '../services/pet-settings-policy'
import type { PetSettingsContext, PetSettingsSessions } from './DesktopPetSettings.vue'

const CAP_RULE = PET_NUMBER_RULES['project.maxCharacters']

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

async function makeContext(options: MemoryPetOptions = {}): Promise<PetSettingsContext> {
  const gateway = createMemoryPetGateway(options)
  return {
    gateway,
    sessions: sessionsFor(gateway),
    capabilities: shallowRef(await gateway.capabilities()),
  }
}

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
  const app = createApp(PetProjectSettings, { context })
  app.mount(host)
  mounted.push(app)
  await settle()
}

async function storedProject(
  gateway: MemoryPetGateway,
): Promise<typeof PET_SETTINGS_DEFAULTS.project> {
  const loaded = await gateway.readSettings('project')
  if (loaded.status !== 'current') throw new Error(`expected current, got ${loaded.status}`)
  const record = petSettingsRecordFor(loaded.record, 'project')
  if (record === null) throw new Error('the store answered for another domain')
  return record.values
}

/** Open the themed select and take the row whose value is `value`. */
async function pick(value: number): Promise<void> {
  document.querySelector<HTMLButtonElement>('.select-trigger')?.click()
  await nextTick()
  const option = document.querySelector<HTMLButtonElement>(`.select-option[data-value="${value}"]`)
  if (option === null) throw new Error(`${value} is not one of the offered values`)
  option.click()
  await nextTick()
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

describe('the project page', () => {
  it('offers exactly the rule\'s range, so a value the store would refuse is unreachable', async () => {
    const context = await makeContext()
    await context.sessions.project.load()
    await mount(context)
    document.querySelector<HTMLButtonElement>('.select-trigger')?.click()
    await nextTick()

    const offered = [...document.querySelectorAll<HTMLButtonElement>('.select-option')].map((row) =>
      Number(row.dataset.value),
    )
    expect(CAP_RULE.integer).toBe(true)
    expect(offered).toEqual(
      Array.from({ length: CAP_RULE.max - CAP_RULE.min + 1 }, (_, i) => CAP_RULE.min + i),
    )
    // Nothing to type into: a free field is the only way an unacceptable number gets in.
    expect(document.querySelectorAll('input')).toHaveLength(0)
  })

  it('stores the cap it was given, through the revision-checked write', async () => {
    const context = await makeContext()
    await context.sessions.project.load()
    await mount(context)

    expect(document.querySelector('.select-value')?.textContent?.trim()).toBe(
      String(PET_SETTINGS_DEFAULTS.project.maxCharacters),
    )
    await pick(5)
    await tick()

    expect(await storedProject(context.gateway)).toEqual({ maxCharacters: 5 })
    expect(document.querySelector('[data-test="pet-project-status"]')?.textContent).toBe(
      t('settings.pet.save.saved'),
    )
  })

  it('states that the binding does not exist, and offers no control for it', async () => {
    const context = await makeContext()
    await context.sessions.project.load()
    await mount(context)

    const binding = document.querySelector('[data-test="pet-project-binding"]')
    expect(binding?.textContent?.trim()).toBe(t('settings.pet.project.bindingUnavailable'))
    expect(binding?.querySelector('input, button')).toBeNull()

    // The page's whole control surface is the cap: one trigger, no switch for the binding, and
    // nothing to recall characters with before a multi-character window exists.
    const buttons = [...document.querySelectorAll('button')]
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.classList.contains('select-trigger')).toBe(true)
  })

  it('draws no controls at all for a store a newer build wrote', async () => {
    const context = await makeContext({ storedSchemaVersion: PET_SETTINGS_SCHEMA_VERSION + 1 })
    await context.sessions.project.load()
    await mount(context)

    expect(document.querySelector('[data-test="pet-project-read-only"]')?.textContent?.trim()).toBe(
      t('settings.pet.readOnly'),
    )
    expect(document.querySelectorAll('button')).toHaveLength(0)
    expect(document.querySelector('[data-test="pet-project-binding"]')).not.toBeNull()
  })
})
