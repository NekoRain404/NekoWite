/**
 * §5.1's 角色与动画, driven through the real controls and read back out of the store.
 *
 * The acceptance is 「原控件映射完整，尺寸/动画/词句保存与回显」, and for this page the half that can
 * be verified today is the size: the slider is moved, the write goes through D6's session into the
 * real double (revision check included), the store is read, and the dialog is closed and reopened
 * to find the value again. A control that renders and drops its write, or one that writes where
 * nothing reads, is the failure this file exists to catch — so every case here ends at the store
 * or at a reopened page, never at the component's own state.
 *
 * The page is mounted the way the app mounts it: as slot content of `DesktopPetSettings.vue`,
 * with the container's own `context` forwarded unchanged (that file's suite documents the wiring
 * as the contract D7b and D7c build against). Mounting the page directly would test a context
 * nobody hands it in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp } from 'vue'
import { t } from '../../../i18n'
import { createMemoryPetGateway, type MemoryPetGateway } from '../../../platform/gateways/memory-pet'
import { PET_SETTINGS_DEFAULTS, PET_SETTINGS_SCHEMA_VERSION } from '../../../platform/gateways/pet-contracts'
import type { PetSettingsDomain, PetSettingsWrite } from '../../../platform/gateways/pet-contracts'
import DesktopPetSettings from './DesktopPetSettings.vue'
import PetCharacterSettings from './PetCharacterSettings.vue'
import type { PetSettingsContext } from './DesktopPetSettings.vue'

let mounted: VueApp[] = []
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers()
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
        { gateway, page: 'character' },
        {
          // The slot hands the page the container's own sessions, which is the whole wiring a
          // page needs and the only context it can be given.
          character: (slotProps: Record<string, unknown>) =>
            h(PetCharacterSettings, { context: slotProps.context as PetSettingsContext }),
        },
      ),
  })
  app.mount(host)
  mounted.push(app)
}

/** Let the host's promises settle, the debounce window pass, and Vue render the result. */
async function flush(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await nextTick()
}

const DEBOUNCE_PLUS = 600

/** The slider, which is the control this page's acceptance is about. */
function sizeSlider(): HTMLInputElement {
  const slider = document.querySelector<HTMLInputElement>('[data-test="pet-character-size"]')
  if (!slider) throw new Error('no size slider')
  return slider
}

async function dragTo(px: number): Promise<void> {
  const slider = sizeSlider()
  slider.value = String(px)
  slider.dispatchEvent(new Event('input', { bubbles: true }))
  await flush(DEBOUNCE_PLUS)
}

function press(dataTest: string): void {
  const button = document.querySelector<HTMLButtonElement>(`[data-test="${dataTest}"]`)
  if (!button) throw new Error(`no button ${dataTest}`)
  button.click()
}

function text(dataTest: string): string {
  return document.querySelector(`[data-test="${dataTest}"]`)?.textContent?.trim() ?? ''
}

/** One domain as the store now holds it, read the way any other caller has to read it. */
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

describe('the size on screen', () => {
  it('draws the slider from the schema’s own rule, in the unit the store holds', async () => {
    mount(createMemoryPetGateway())
    await flush()

    // §5.3 「界面和后端使用同一规则」: the ends are `PET_NUMBER_RULES`, not numbers picked here.
    expect(sizeSlider().min).toBe('64')
    expect(sizeSlider().max).toBe('320')
    expect(sizeSlider().value).toBe('160')
  })

  it('writes what it shows, and the value is still there when the dialog is reopened', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    await dragTo(208)
    expect((await storedValues(gateway, 'character')).size).toBe(208)
    expect(text('pet-character-status')).toBe(t('settings.pet.save.saved'))

    // 「重开保留」, on the store rather than on the component: a fresh dialog reads it back.
    unmountAll()
    mount(gateway)
    await flush()
    expect(sizeSlider().value).toBe('208')
  })

  it('offers upstream’s S/M/L presets at the schema’s default scale', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    // Upstream's presets are 80/100/125% of the size it calls 100% (`settings.html:132`); the
    // schema's default is that size, so the presets are those percentages of it.
    press('pet-character-preset-125')
    await flush(DEBOUNCE_PLUS)
    expect((await storedValues(gateway, 'character')).size).toBe(200)

    press('pet-character-preset-80')
    await flush(DEBOUNCE_PLUS)
    expect((await storedValues(gateway, 'character')).size).toBe(128)
    expect(sizeSlider().value).toBe('128')
  })

  it('cannot submit a size outside the rule, even when the input is set past its ends', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    // What this pins is the guarantee, not the layer: the input's own ends come from the same
    // `PET_NUMBER_RULES` entry and stop a gesture before the handler sees it, so which of the two
    // refuses here is not observable — the store's value is.
    await dragTo(5)
    expect((await storedValues(gateway, 'character')).size).toBe(64)

    await dragTo(900)
    expect((await storedValues(gateway, 'character')).size).toBe(320)
  })
})

describe('the chosen character', () => {
  it('shows a selection, and clears it the way upstream’s deselect does', async () => {
    const gateway = createMemoryPetGateway()
    await seed(gateway, 'character', { characterId: 'neko-default' })
    mount(gateway)
    await flush()

    expect(text('pet-character-current')).toBe(
      t('settings.pet.character.selected', { id: 'neko-default' }),
    )

    press('pet-character-clear')
    await flush(DEBOUNCE_PLUS)
    expect((await storedValues(gateway, 'character')).characterId).toBeNull()

    unmountAll()
    mount(gateway)
    await flush()
    expect(text('pet-character-current')).toBe(t('settings.pet.character.none'))
    // Upstream's `pet-deselect` is hidden when there is nothing to clear; so is this one, so it
    // is never a button that writes the value it already holds.
    expect(document.querySelector('[data-test="pet-character-clear"]')).toBeNull()
  })
})

describe('the character library, and what is still only stated', () => {
  it('offers the installed characters, and what choosing one writes', async () => {
    const gateway = createMemoryPetGateway({
      characters: [
        { characterId: 'kitty', packName: 'Kitty', kind: 'imported', files: 'intact', installedAtMs: 1 },
        {
          characterId: 'broken',
          packName: 'Broken',
          kind: 'imported',
          files: 'damaged',
          installedAtMs: 2,
        },
      ],
    })
    mount(gateway)
    await flush()

    // A damaged character is listed and cannot be chosen (§8/D8's rule: it is the user's, and
    // hiding it would make one that needs attention look like one that was never installed).
    const row = document.querySelector<HTMLButtonElement>('[data-test="pet-character-row-kitty"]')
    expect(row?.textContent).toContain('Kitty')
    const broken = document.querySelector<HTMLButtonElement>('[data-test="pet-character-row-broken"]')
    expect(broken?.disabled).toBe(true)
    expect(broken?.title).toBe(t('settings.pet.character.damaged'))

    row?.click()
    await flush(DEBOUNCE_PLUS)
    // The write goes through the session to the store, which is what the pet window reads: a row
    // that lit up without writing would be a choice that never reaches the character.
    expect((await storedValues(gateway, 'character')).characterId).toBe('kitty')
  })

  it('offers a character whose id and name are Chinese, and writes it back unchanged', async () => {
    // The library holds what the filesystem holds, so an id is a folder name and a Chinese folder
    // is a character like any other (D8's `resources::is_path_component`, and the gap a Chinese
    // folder name used to meet). The page's half of that is *not* to have an opinion: the id it
    // draws is the id it writes, byte for byte, because the value in the settings is how the pet
    // window finds the directory again.
    const gateway = createMemoryPetGateway({
      characters: [
        {
          characterId: '喵喵',
          packName: '喵喵',
          kind: 'imported',
          files: 'intact',
          installedAtMs: 1,
        },
      ],
    })
    mount(gateway)
    await flush()

    const row = document.querySelector<HTMLButtonElement>('[data-test="pet-character-row-喵喵"]')
    expect(row?.textContent).toContain('喵喵')
    expect(row?.disabled).toBe(false)

    row?.click()
    await flush(DEBOUNCE_PLUS)

    expect((await storedValues(gateway, 'character')).characterId).toBe('喵喵')
  })

  it('imports a character and selects what arrived', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()
    expect(text('pet-character-notice-no-characters')).toBe(
      t('settings.pet.character.notice.no-characters'),
    )

    press('pet-character-import')
    await flush()
    await flush(DEBOUNCE_PLUS)

    expect((await storedValues(gateway, 'character')).characterId).toBe('imported-1')
    expect(document.querySelector('[data-test="pet-character-row-imported-1"]')).not.toBeNull()
  })

  it('says what an import refused, in the host\'s words', async () => {
    const gateway = createMemoryPetGateway({ importRefusal: 'the pack holds no spritesheet' })
    mount(gateway)
    await flush()

    press('pet-character-import')
    await flush()

    expect(text('pet-character-import-error')).toBe(
      t('settings.pet.character.importFailed', { msg: 'the pack holds no spritesheet' }),
    )
  })

  it('states the animation mapping rather than drawing a control that acts on nothing', async () => {
    mount(createMemoryPetGateway())
    await flush()

    // §5.2 「不可用选项要说明原因，不显示可点击但无效果的控件」. The reason this one is still only a
    // sentence is the page's own: the pet draws from these values now, and the controls that would
    // set them do not exist yet. Asserted as catalogue text, so a page that lost its words fails
    // here rather than rendering a raw key.
    expect(text('pet-character-animations')).toBe(t('settings.pet.character.animationsUnavailable'))
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

    await dragTo(240)
    // §5.3: the store did not persist it, so nothing reads as saved and the store still holds
    // the old value.
    expect(text('pet-character-status')).toBe(t('settings.pet.save.failed'))
    expect((await storedValues(gateway, 'character')).size).toBe(160)
    // The draft stays where the user put it, which is what makes the retry the right write.
    expect(sizeSlider().value).toBe('240')

    press('pet-character-retry')
    await flush(DEBOUNCE_PLUS)
    expect((await storedValues(gateway, 'character')).size).toBe(240)
    expect(text('pet-character-status')).toBe(t('settings.pet.save.saved'))
  })

  it('flushes the last edit when the dialog closes inside the debounce window', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    // §5.3 「防抖写入不得丢掉关闭设置前最后一次修改」: an edit made and a dialog closed before the
    // debounce fires is still an edit the user made.
    const slider = sizeSlider()
    slider.value = '224'
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    unmountAll()
    await flush(DEBOUNCE_PLUS)

    expect((await storedValues(gateway, 'character')).size).toBe(224)
  })
})

describe('a store this build must not write', () => {
  it('replaces the controls with the notice when a newer build wrote them', async () => {
    mount(createMemoryPetGateway({ storedSchemaVersion: PET_SETTINGS_SCHEMA_VERSION + 1 }))
    await flush()

    // §10.2: the session answers a refused read with this build's defaults, so a form here would
    // show numbers the user never chose and offer to save them.
    expect(text('pet-character-read-only')).toBe(t('settings.pet.readOnly'))
    expect(document.querySelector('[data-test="pet-character-size"]')).toBeNull()
    expect(document.querySelector('[data-test="pet-character-reset"]')).toBeNull()
  })
})

describe('restoring this page', () => {
  it('returns the character domain to its defaults, and writes no other domain', async () => {
    const gateway = createMemoryPetGateway()
    await seed(gateway, 'character', { characterId: 'neko-default', size: 240 })
    const write = vi.spyOn(gateway, 'updateSettings')
    mount(gateway)
    await flush()
    write.mockClear()

    press('pet-character-reset')
    await flush(DEBOUNCE_PLUS)

    // The schema's own defaults, not a literal: the character domain grew in D7d, and a
    // reset that returned "the two fields this page draws" would leave the rest of the
    // domain wherever the user had put it.
    expect(await storedValues(gateway, 'character')).toEqual(PET_SETTINGS_DEFAULTS.character)
    // §5.3 「恢复本页默认只影响当前域」: one domain, so the character library and care progress
    // this page does not own cannot be cleared by it.
    expect([...new Set(write.mock.calls.map((call) => call[0].domain))]).toEqual(['character'])
  })
})
