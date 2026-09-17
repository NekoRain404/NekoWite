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
import {
  PET_NUMBER_RULES,
  PET_SETTINGS_DEFAULTS,
  PET_SETTINGS_SCHEMA_VERSION,
} from '../../../platform/gateways/pet-contracts'
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

function opacitySlider(): HTMLInputElement {
  const slider = document.querySelector<HTMLInputElement>('[data-test="pet-bubble-opacity"]')
  if (!slider) throw new Error('no opacity slider')
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
  it('starts on «system», which is this schema’s default and not upstream’s «dark»', async () => {
    mount(createMemoryPetGateway())
    await flush()

    // §5.2 「默认跟随宿主主题」: the pet takes the palette of the page it is drawn in unless the user
    // overrides it here — the machine's preference on the desktop, the app's in the preview above —
    // so the third option is named after neither and says what it is.
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

/**
 * The bubble's own text size and the state dot's style.
 *
 * Both were stored and read by nobody until they crossed the appearance read (`pet-appearance.ts` →
 * `usePetWindow` → `DesktopPetRoot.vue` → `PetBubble.vue`), so what is asserted here is the half
 * this page owns: the control writes the value, and a reopened dialog reads it back. The other half
 * — that the window draws it — is `desktop-pet-root.test.ts`, the Chromium case in
 * `e2e/desktop-pet-bubble.spec.ts` and the WebKitGTK probe.
 */
describe('the bubble’s text size and dot style', () => {
  it('offers upstream’s three sizes, drawn from the schema’s own rule', async () => {
    mount(createMemoryPetGateway())
    await flush()

    const rule = PET_NUMBER_RULES['message.fontSize']
    for (const size of [rule.min, rule.fallback, rule.max]) {
      expect(document.querySelector(`[data-test="pet-bubble-font-size-${size}"]`)).not.toBeNull()
    }
    // The schema's default is the one marked, not one this file picked.
    expect(
      document
        .querySelector(`[data-test="pet-bubble-font-size-${PET_SETTINGS_DEFAULTS.message.fontSize}"]`)
        ?.classList.contains('is-active'),
    ).toBe(true)
  })

  it('writes the size and the dot style it shows, and reads both back on reopen', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    const largest = PET_NUMBER_RULES['message.fontSize'].max
    press(`pet-bubble-font-size-${largest}`)
    press('pet-bubble-dot-claude')
    await flush(DEBOUNCE_PLUS)

    const written = await storedValues(gateway, 'message')
    expect(written.fontSize).toBe(largest)
    expect(written.dot).toBe('claude')
    expect(text('pet-bubble-status')).toBe(t('settings.pet.save.saved'))

    unmountAll()
    mount(gateway)
    await flush()
    expect(
      document
        .querySelector(`[data-test="pet-bubble-font-size-${largest}"]`)
        ?.classList.contains('is-active'),
    ).toBe(true)
    expect(
      document
        .querySelector('[data-test="pet-bubble-dot-claude"]')
        ?.classList.contains('is-active'),
    ).toBe(true)
  })
})

/**
 * The bubble's own background alpha.
 *
 * These assertions were `PetGeneralSettings.test.ts`'s until the field moved: it used to be filed
 * as a *window* opacity, which upstream never had and this build has no engine call for, so the
 * control wrote a value nothing read. Upstream's `ap_opacity` is the bubble's `--bubble-bg` alpha,
 * drawn on this page (`windows/settings.html:172-173`), and the check follows the control.
 */
describe('how opaque the bubble’s background is', () => {
  it('starts the opacity slider and its ends at the schema’s own rule', async () => {
    mount(createMemoryPetGateway())
    await flush()

    expect(opacitySlider().value).toBe('92')
    // §5.3 「界面和后端使用同一规则」: the ends are `PET_NUMBER_RULES`, not numbers picked here, and
    // the rule holds upstream's own percent slider — 60 to 100 — as the fraction the alpha is.
    expect(opacitySlider().min).toBe('60')
    expect(opacitySlider().max).toBe('100')
    expect(PET_SETTINGS_DEFAULTS.message.opacity).toBe(0.92)
  })

  it('writes the fraction the percentage stands for, and cannot leave the rule', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    opacitySlider().value = '70'
    opacitySlider().dispatchEvent(new Event('input', { bubbles: true }))
    await flush(DEBOUNCE_PLUS)
    expect((await storedValues(gateway, 'message')).opacity).toBeCloseTo(0.7)

    // Past the ends, which the input's own `min`/`max` already refuse for a gesture: what this
    // pins is that the submit path applies the same rule rather than trusting the element.
    opacitySlider().value = '10'
    opacitySlider().dispatchEvent(new Event('input', { bubbles: true }))
    await flush(DEBOUNCE_PLUS)
    expect((await storedValues(gateway, 'message')).opacity).toBeCloseTo(0.6)

    opacitySlider().value = '150'
    opacitySlider().dispatchEvent(new Event('input', { bubbles: true }))
    await flush(DEBOUNCE_PLUS)
    expect((await storedValues(gateway, 'message')).opacity).toBeCloseTo(1)
  })

  it('reads the stored alpha back when the dialog is reopened', async () => {
    const gateway = createMemoryPetGateway()
    await seed(gateway, 'message', { opacity: 0.75 })
    mount(gateway)
    await flush()

    expect(opacitySlider().value).toBe('75')

    unmountAll()
    mount(gateway)
    await flush()
    expect(opacitySlider().value).toBe('75')
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

describe('the row layout and the phrases, which used to be a paragraph', () => {
  /**
   * **This is the defect, as assertions.** Both blocks below were a sentence saying the settings
   * could hold these values and that the bubble took no layout from them — which was accurate, and
   * was this project's signature failure: `PetBubble` had taken a `layout` prop since it was
   * written, and no product code passed one. The sentence is gone, and every control that replaced
   * it is driven here and read back out of the store, because a control that can be clicked and
   * does nothing is the thing §5.2 forbids.
   */
  it('writes every layout field the page draws a control for', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    press('pet-bubble-mode-compact')
    press('pet-bubble-grouping-flat')
    press('pet-bubble-filter-attention')
    press('pet-bubble-separator-arrow')
    await flush(DEBOUNCE_PLUS)

    const values = await storedValues(gateway, 'message')
    expect(values.layoutMode).toBe('compact')
    expect(values.grouping).toBe('flat')
    expect(values.filter).toBe('attention')
    expect(values.separator).toBe('arrow')
  })

  it('writes the row cap through the schema’s own rule', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    const slider = document.querySelector<HTMLInputElement>('[data-test="pet-bubble-rows"]')
    if (!slider) throw new Error('no row slider')
    slider.value = '99'
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    await flush(DEBOUNCE_PLUS)

    expect((await storedValues(gateway, 'message')).layoutMaxRows).toBe(10)
  })

  it('writes a whole field list, in the renderer’s own order', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    const elapsed = document.querySelector<HTMLInputElement>('[data-test="pet-bubble-token-elapsed"]')
    if (!elapsed) throw new Error('no elapsed checkbox')
    // The stored list is empty, which means the renderer's *preset* — so the box is unchecked and
    // the write is the whole list rather than a patch of one entry.
    expect(elapsed.checked).toBe(false)
    elapsed.checked = true
    elapsed.dispatchEvent(new Event('change', { bubbles: true }))
    await flush(DEBOUNCE_PLUS)

    const written = (await storedValues(gateway, 'message')).tokens as {
      token: string
      visible: boolean
    }[]
    expect(written.map((entry) => entry.token)).toEqual([
      'dot',
      'agent',
      'session',
      'separator',
      'message',
      'stateLabel',
      'elapsed',
    ])
    expect(written.filter((entry) => entry.visible).map((entry) => entry.token)).toEqual([
      'dot',
      'agent',
      'session',
      'separator',
      'message',
      'elapsed',
    ])
  })

  it('writes the lines the user typed, one phrase per line and blanks dropped', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    const box = document.querySelector<HTMLTextAreaElement>('[data-test="pet-bubble-phrases"]')
    if (!box) throw new Error('no phrase box')
    // The blank line is dropped *here* rather than stored, because the schema refuses a blank
    // member and a list field is all-or-nothing: a submission carrying one is refused whole.
    box.value = '先喝口水\n\n  整理一下引用  '
    box.dispatchEvent(new Event('change', { bubbles: true }))
    await flush(DEBOUNCE_PLUS)

    expect((await storedValues(gateway, 'message')).quickBubbles).toEqual([
      '先喝口水',
      '整理一下引用',
    ])
  })

  it('writes the idle switch', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    const idle = document.querySelector<HTMLInputElement>('[data-test="pet-bubble-idle"]')
    if (!idle) throw new Error('no idle switch')
    expect(idle.checked).toBe(true)
    idle.checked = false
    idle.dispatchEvent(new Event('change', { bubbles: true }))
    await flush(DEBOUNCE_PLUS)

    expect((await storedValues(gateway, 'message')).idle).toBe(false)
  })

  it('states what is still unwired, in words, rather than drawing a dead control', async () => {
    mount(createMemoryPetGateway())
    await flush()

    // §5.2 「不可用选项要说明原因，不显示可点击但无效果的控件」: the one key left with no surface is
    // the per-engine icon list, which needs the agent registry this window does not have. It is
    // asserted as catalogue text, so a page that lost its words fails here rather than rendering a
    // raw key.
    expect(text('pet-bubble-unwired')).toBe(t('settings.pet.bubble.agentsUnavailable'))
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
