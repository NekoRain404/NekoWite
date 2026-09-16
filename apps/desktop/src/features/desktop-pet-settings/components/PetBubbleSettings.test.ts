/**
 * §5.1's 气泡与消息, driven through the real controls and read back out of the store.
 *
 * Two controls, and both are checked the way the acceptance asks: the theme is picked, the
 * duration is dragged, and each write is read out of the `message` domain it belongs to and found
 * again after the dialog is closed and reopened. What the page *cannot* offer is asserted too —
 * the ledger's other sixteen keys for this page are stated in words rather than drawn as controls,
 * because a row builder that saved nothing is exactly the failure this task is defined against.
 *
 * The page is mounted the way the app mounts it: as slot content of `DesktopPetSettings.vue`, with
 * the container's own `context` forwarded unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp } from 'vue'
import { t } from '../../../i18n'
import { createMemoryPetGateway, type MemoryPetGateway } from '../../../platform/gateways/memory-pet'
import { PET_SETTINGS_DEFAULTS, PET_SETTINGS_SCHEMA_VERSION } from '../../../platform/gateways/pet-contracts'
import type { PetSettingsDomain, PetSettingsWrite } from '../../../platform/gateways/pet-contracts'
import DesktopPetSettings from './DesktopPetSettings.vue'
import PetBubbleSettings from './PetBubbleSettings.vue'
import type { PetSettingsContext } from './DesktopPetSettings.vue'

let mounted: VueApp[] = []
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
  mounted = []
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
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  unmountAll()
  warnSpy.mockRestore()
  vi.useRealTimers()
})

function unmountAll(): void {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
}

function mount(gateway: MemoryPetGateway): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () =>
      h(
        DesktopPetSettings,
        { gateway, page: 'bubble' },
        {
          bubble: (slotProps: Record<string, unknown>) =>
            h(PetBubbleSettings, { context: slotProps.context as PetSettingsContext }),
        },
      ),
  })
  app.mount(host)
  mounted.push(app)
}

async function flush(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await nextTick()
}

const DEBOUNCE_PLUS = 600

function durationSlider(): HTMLInputElement {
  const slider = document.querySelector<HTMLInputElement>('[data-test="pet-bubble-duration"]')
  if (!slider) throw new Error('no duration slider')
  return slider
}

function themeButton(theme: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-test="pet-bubble-theme-${theme}"]`)
  if (!button) throw new Error(`no theme button ${theme}`)
  return button
}

/** The theme the control is showing, read off the segmented row the way a user reads it. */
function activeTheme(): string | null {
  for (const theme of ['light', 'dark', 'system']) {
    if (themeButton(theme).classList.contains('is-active')) return theme
  }
  return null
}

function press(dataTest: string): void {
  const button = document.querySelector<HTMLButtonElement>(`[data-test="${dataTest}"]`)
  if (!button) throw new Error(`no button ${dataTest}`)
  button.click()
}

function text(dataTest: string): string {
  return document.querySelector(`[data-test="${dataTest}"]`)?.textContent?.trim() ?? ''
}

async function storedValues(
  gateway: MemoryPetGateway,
  domain: PetSettingsDomain,
): Promise<Record<string, unknown>> {
  const loaded = await gateway.readSettings(domain)
  if (loaded.status === 'read-only') throw new Error(`read-only: ${domain}`)
  return loaded.record.values as unknown as Record<string, unknown>
}

/** Put a domain where a test needs it before the page ever reads it. */
async function seed(
  gateway: MemoryPetGateway,
  domain: PetSettingsDomain,
  values: Record<string, unknown>,
): Promise<void> {
  const loaded = await gateway.readSettings(domain)
  if (loaded.status === 'read-only') throw new Error(`read-only: ${domain}`)
  const outcome = await gateway.updateSettings({
    domain,
    revision: loaded.record.revision,
    values: { ...(await storedValues(gateway, domain)), ...values },
  } as PetSettingsWrite)
  if (outcome.status !== 'applied') throw new Error(`seed refused: ${outcome.status}`)
}

describe('the bubble theme', () => {
  it('starts on «follow the app», which is this schema’s default and not upstream’s «dark»', async () => {
    mount(createMemoryPetGateway())
    await flush()

    // §5.2 「默认跟随宿主主题」: the pet follows the app unless the user overrides it here, so the
    // third option names the app rather than the system NekoWite itself may already be following.
    expect(activeTheme()).toBe('system')
    expect(text('pet-bubble-status')).toBe('')
  })

  it('writes the theme it shows, and a reopened dialog reads it back', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    themeButton('dark').click()
    await flush(DEBOUNCE_PLUS)

    expect((await storedValues(gateway, 'message')).theme).toBe('dark')
    expect(activeTheme()).toBe('dark')
    expect(text('pet-bubble-status')).toBe(t('settings.pet.save.saved'))

    unmountAll()
    mount(gateway)
    await flush()
    expect(activeTheme()).toBe('dark')
  })
})

describe('how long a bubble stays', () => {
  it('draws the slider from the schema’s own rule and writes the whole seconds it shows', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    // §5.3 「界面和后端使用同一规则」: the ends are `PET_NUMBER_RULES`, not numbers picked here.
    expect(durationSlider().min).toBe('1')
    expect(durationSlider().max).toBe('60')
    expect(durationSlider().value).toBe('6')

    durationSlider().value = '12'
    durationSlider().dispatchEvent(new Event('input', { bubbles: true }))
    await flush(DEBOUNCE_PLUS)
    expect((await storedValues(gateway, 'message')).bubbleSeconds).toBe(12)

    unmountAll()
    mount(gateway)
    await flush()
    expect(durationSlider().value).toBe('12')
  })

  it('cannot submit a duration outside the rule, even when the input is set past its ends', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    // What this pins is the guarantee, not the layer: the input's own ends come from the same
    // `PET_NUMBER_RULES` entry and stop a gesture before the handler sees it, so which of the two
    // refuses here is not observable — the store's value is.
    durationSlider().value = '0'
    durationSlider().dispatchEvent(new Event('input', { bubbles: true }))
    await flush(DEBOUNCE_PLUS)
    expect((await storedValues(gateway, 'message')).bubbleSeconds).toBe(1)

    durationSlider().value = '99'
    durationSlider().dispatchEvent(new Event('input', { bubbles: true }))
    await flush(DEBOUNCE_PLUS)
    expect((await storedValues(gateway, 'message')).bubbleSeconds).toBe(60)
  })
})

describe('what this page cannot offer, and says so', () => {
  it('states the row layout and the word lists instead of drawing dead controls', async () => {
    mount(createMemoryPetGateway())
    await flush()

    // §5.2 「不可用选项要说明原因，不显示可点击但无效果的控件」. Both are asserted as catalogue text,
    // so a page that lost its words fails here rather than rendering a raw key.
    expect(text('pet-bubble-layout')).toBe(t('settings.pet.bubble.layoutUnavailable'))
    expect(text('pet-bubble-phrases')).toBe(t('settings.pet.bubble.phrasesUnavailable'))
  })

  it('renders no message key it did not get from the catalogue', async () => {
    mount(createMemoryPetGateway())
    await flush()

    const body = document.querySelector('.settings-section')?.textContent ?? ''
    expect(body).not.toContain('settings.pet.')
  })
})

describe('a write that did not happen', () => {
  it('says it failed, keeps the draft, and writes it again on retry', async () => {
    const gateway = createMemoryPetGateway({ writeFailures: 1 })
    mount(gateway)
    await flush()

    themeButton('light').click()
    await flush(DEBOUNCE_PLUS)

    // §5.3: the store did not persist it, so nothing reads as saved and the store keeps the old
    // value while the control stays where the user put it.
    expect(text('pet-bubble-status')).toBe(t('settings.pet.save.failed'))
    expect((await storedValues(gateway, 'message')).theme).toBe('system')
    expect(activeTheme()).toBe('light')

    press('pet-bubble-retry')
    await flush(DEBOUNCE_PLUS)
    expect((await storedValues(gateway, 'message')).theme).toBe('light')
    expect(text('pet-bubble-status')).toBe(t('settings.pet.save.saved'))
  })

  it('flushes the last edit when the dialog closes inside the debounce window', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    // §5.3 「防抖写入不得丢掉关闭设置前最后一次修改」.
    durationSlider().value = '20'
    durationSlider().dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    unmountAll()
    await flush(DEBOUNCE_PLUS)

    expect((await storedValues(gateway, 'message')).bubbleSeconds).toBe(20)
  })
})

describe('a store this build must not write', () => {
  it('replaces the controls with the notice when a newer build wrote them', async () => {
    mount(createMemoryPetGateway({ storedSchemaVersion: PET_SETTINGS_SCHEMA_VERSION + 1 }))
    await flush()

    // §10.2: the session answers a refused read with this build's defaults, so a form here would
    // show choices the user never made and offer to save them.
    expect(text('pet-bubble-read-only')).toBe(t('settings.pet.readOnly'))
    expect(document.querySelector('[data-test="pet-bubble-duration"]')).toBeNull()
    expect(document.querySelector('[data-test="pet-bubble-theme-dark"]')).toBeNull()
  })
})

describe('restoring this page', () => {
  it('returns the message domain to its defaults, and writes no other domain', async () => {
    const gateway = createMemoryPetGateway()
    await seed(gateway, 'message', { theme: 'dark', bubbleSeconds: 30 })
    const write = vi.spyOn(gateway, 'updateSettings')
    mount(gateway)
    await flush()
    write.mockClear()

    press('pet-bubble-reset')
    await flush(DEBOUNCE_PLUS)

    // The schema's own defaults, not a literal: the message domain grew in D7d, and a
    // reset that returned "the two fields this page draws" would leave the rest of the
    // domain wherever the user had put it.
    expect(await storedValues(gateway, 'message')).toEqual(PET_SETTINGS_DEFAULTS.message)
    // §5.3 「恢复本页默认只影响当前域」: the view domain the sibling page writes is not touched.
    expect([...new Set(write.mock.calls.map((call) => call[0].domain))]).toEqual(['message'])
  })
})
