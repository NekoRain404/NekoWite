/**
 * The integration page, which is where this port's acceptance clause is decided:
 * 「未验证网络能力明确不可用」 — an unverified capability must read as unavailable, and never as an
 * off switch that says it could be on.
 *
 * Three things are asserted, and the third is the one a careless page would fail:
 *
 *  - every capability of D1's vocabulary is on the page, with the status the host reported and —
 *    where it cannot be used — the fallback and the host's own words;
 *  - the online, external and system features this build does not have are listed with reasons;
 *  - **the page has no controls at all.** Not disabled ones, not greyed ones: absent. A disabled
 *    switch still asserts that the feature exists, which is exactly the belief a render-only
 *    control creates (`PetIntegrationSettings.vue`'s header, §7.2 「不伪装已支持」).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, shallowRef, type App as VueApp } from 'vue'
import PetIntegrationSettings from './PetIntegrationSettings.vue'
import { t, setLocale } from '../../../i18n'
import { PET_CAPABILITIES } from '../../../platform/gateways/pet-contracts'
import type { PetCapabilityReport } from '../../../platform/gateways/pet-contracts'
import {
  createMemoryPetGateway,
  type MemoryPetGateway,
  type MemoryPetOptions,
} from '../../../platform/gateways/memory-pet'
import { usePetSettings } from '../composables/use-pet-settings'
import type { PetSettingsContext, PetSettingsSessions } from './DesktopPetSettings.vue'

/** The rows §5.2 puts on this page, and the ledger's §3 review of the four upstream plugins. */
const ROW_IDS = [
  'catalog',
  'care-sync',
  'external-monitor',
  'update',
  'autostart',
  'process',
  'import-export',
] as const

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

/**
 * The container's context, with the capability report it carries. It is passed in rather than
 * only read from the gateway, because "the host has not answered" and "the host reported a
 * capability that cannot be used" are two different states of one page.
 */
async function makeContext(
  options: MemoryPetOptions = {},
  capabilities?: PetCapabilityReport[],
): Promise<PetSettingsContext> {
  const gateway = createMemoryPetGateway(options)
  const sessions = sessionsFor(gateway)
  return {
    gateway,
    sessions,
    capabilities: shallowRef(capabilities ?? (await gateway.capabilities())),
  }
}

async function settle(): Promise<void> {
  await nextTick()
  await vi.advanceTimersByTimeAsync(0)
  await nextTick()
}

async function mount(context: PetSettingsContext): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(PetIntegrationSettings, { context })
  app.mount(host)
  mounted.push(app)
  await settle()
}

const rowText = (capability: string): string =>
  document.querySelector(`[data-test="pet-capability-${capability}"]`)?.textContent ?? ''

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

describe('the integration page', () => {
  it('reports every capability of the vocabulary, with an unverified one read as unverified', async () => {
    // Nothing has been measured on the double's host, so every finding is `unverified` — the
    // honest default (§12), and the state most likely to be dressed up as available.
    await mount(await makeContext())

    for (const capability of PET_CAPABILITIES) {
      const row = document.querySelector(`[data-test="pet-capability-${capability}"]`)
      expect(row, capability).not.toBeNull()
      expect(row?.getAttribute('data-status'), capability).toBe('unverified')
      expect(rowText(capability), capability).toContain(
        t('settings.pet.capabilityStatus.unverified'),
      )
    }
    // The two the brief keeps naming: climbing has no Linux implementation at all, and a system
    // notification whose delivery has not been measured leaves the unread list.
    expect(rowText('window-climb')).toContain(t('settings.pet.capabilityFallback.not-offered'))
    expect(rowText('system-notification')).toContain(
      t('settings.pet.capabilityFallback.unread-list'),
    )
  })

  it('states what happens instead, in the host\'s own words, when a capability is unavailable', async () => {
    const detail = 'no XDG notification portal on this desktop'
    await mount(
      await makeContext({
        capabilities: {
          'notification-actions': { status: 'unavailable', fallback: 'unread-list', detail },
        },
      }),
    )

    const row = document.querySelector('[data-test="pet-capability-notification-actions"]')
    expect(row?.getAttribute('data-status')).toBe('unavailable')
    expect(rowText('notification-actions')).toContain(
      t('settings.pet.capabilityStatus.unavailable'),
    )
    expect(rowText('notification-actions')).toContain(
      t('settings.pet.capabilityFallback.unread-list'),
    )
    expect(rowText('notification-actions')).toContain(detail)
  })

  it('states an available capability without inventing a fallback for it', async () => {
    await mount(
      await makeContext({ capabilities: { 'always-on-top': { status: 'available' } } }),
    )

    const row = document.querySelector('[data-test="pet-capability-always-on-top"]')
    expect(row?.getAttribute('data-status')).toBe('available')
    expect(rowText('always-on-top')).toContain(t('settings.pet.capabilityStatus.available'))
    expect(rowText('always-on-top')).not.toContain('改用')
  })

  it('keeps "nothing was reported" apart from "this machine cannot do it"', async () => {
    // A host that reported nothing, and a host that reported one capability and stayed silent
    // about the rest: neither is a claim that those capabilities are missing.
    await mount(await makeContext({}, []))
    expect(document.querySelector('[data-test="pet-integration-no-report"]')?.textContent?.trim())
      .toBe(t('settings.pet.integration.capabilities.noReport'))
    expect(document.querySelectorAll('[data-test^="pet-capability-"]')).toHaveLength(0)

    document.body.innerHTML = ''
    mounted.forEach((app) => app.unmount())
    mounted = []
    await mount(await makeContext({}, [{ capability: 'drag', finding: { status: 'available' } }]))
    expect(document.querySelector('[data-test="pet-capability-drag"]')?.getAttribute('data-status'))
      .toBe('available')
    expect(document.querySelector('[data-test="pet-capability-drag"]')?.textContent).not.toContain(
      t('settings.pet.capabilityUnknown'),
    )
    // The one the host said nothing about is unchecked, not unavailable.
    expect(rowText('window-climb')).toContain(t('settings.pet.capabilityUnknown'))
    expect(
      document.querySelector('[data-test="pet-capability-window-climb"]')?.getAttribute(
        'data-status',
      ),
    ).toBe('unreported')
  })

  it('lists the features this build does not have, each with its reason', async () => {
    await mount(await makeContext())

    for (const id of ROW_IDS) {
      const row = document.querySelector(`[data-test="pet-integration-row-${id}"]`)
      expect(row, id).not.toBeNull()
      expect(row?.textContent, id).toContain(t(`settings.pet.integration.rows.${id}.name`))
      expect(row?.textContent, id).toContain(t(`settings.pet.integration.rows.${id}.reason`))
    }
    expect(document.querySelector('[data-test="pet-integration-online"]')).not.toBeNull()
    expect(document.querySelector('[data-test="pet-integration-system"]')).not.toBeNull()
    expect(document.querySelector('[data-test="pet-integration-not-offered"]')?.textContent?.trim())
      .toBe(t('settings.pet.integration.notOfferedNote'))
  })

  it('gives an unavailable or unverified capability no control to click', async () => {
    await mount(
      await makeContext({
        capabilities: {
          'pointer-passthrough': {
            status: 'unavailable',
            fallback: 'compact-window',
            detail: 'no compositor input region here',
          },
          'system-notification': {
            status: 'degraded',
            fallback: 'unread-list',
            detail: 'the portal answered without actions',
          },
        },
      }),
    )

    // The page's whole surface is text. A switch here — even a disabled one — would say the
    // capability exists and is merely switched off, which is the claim being refused.
    expect(document.querySelectorAll('input')).toHaveLength(0)
    expect(document.querySelectorAll('button')).toHaveLength(0)
    expect(document.querySelector('[role="switch"], [role="checkbox"], [role="radio"]')).toBeNull()
    for (const capability of PET_CAPABILITIES) {
      expect(
        document
          .querySelector(`[data-test="pet-capability-${capability}"]`)
          ?.querySelector('input, button, select, [role="switch"]'),
        capability,
      ).toBeNull()
    }
    for (const id of ROW_IDS) {
      expect(
        document
          .querySelector(`[data-test="pet-integration-row-${id}"]`)
          ?.querySelector('input, button, select, [role="switch"]'),
        id,
      ).toBeNull()
    }
  })
})
