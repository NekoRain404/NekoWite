/**
 * §5.1's 常规与交互, driven through the real controls.
 *
 * The page writes two domains and this suite checks that each control reaches the one it
 * belongs to: a switch that renders correctly and drops its write is the failure
 * `SettingsPanel.controls.test.ts` exists for, and a *second* one lives here — a roaming mode
 * offered where §7.2 says this machine cannot run it.
 *
 * Two of the page's claims are about the *pair* of window switches rather than about either one,
 * and each is asserted as the thing it is: that 显示悬浮球 and 显示角色窗口 are peers, and that
 * `general.enabled`, which the store derives from them, is written beside them by the page — a
 * page that wrote only the switch it was handed would leave the draft disagreeing with every
 * record the store answers with. The third is that no state of the page draws either switch
 * disabled, because a disabled control is what the user reported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, h, nextTick, type App as VueApp } from 'vue'
import { t } from '../../../i18n'
import { createMemoryPetGateway, type MemoryPetGateway } from '../../../platform/gateways/memory-pet'
import {
  PET_NUMBER_RULES,
  PET_SETTINGS_DEFAULTS,
  type PetCapabilityFinding,
  type PetSettingsDomain,
  type PetSettingsWrite,
} from '../../../platform/gateways/pet-contracts'
import DesktopPetSettings from './DesktopPetSettings.vue'

let mounted: VueApp[] = []
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // The container's preview draws in this *window's* appearance as well as the pet's own settings
  // (§1's 「保留现有主题、强调色」): its stage carries the same four axes the app's root does, read from
  // the appearance store. A suite that mounts the container therefore provides the store's world the
  // same way it provides a gateway — a Pinia.
  setActivePinia(createPinia())

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

/** Everything this machine was verified to do, for the tests that are not about §7.2. */
const ALL_AVAILABLE: { [C in 'always-on-top' | 'pointer-follow' | 'window-climb']?: PetCapabilityFinding } = {
  'always-on-top': { status: 'available' },
  'pointer-follow': { status: 'available' },
  'window-climb': { status: 'available' },
}

function mount(gateway: MemoryPetGateway): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(() => h(DesktopPetSettings, { gateway, page: 'general' }))
  app.mount(host)
  mounted.push(app)
}

async function flush(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await nextTick()
}

const DEBOUNCE_PLUS = 600

function fieldControl<T extends HTMLElement>(label: string, selector: string): T {
  const field = [...document.querySelectorAll<HTMLElement>('.settings-section label')]
    .find((candidate) => candidate.textContent?.includes(label))
  const control = field?.querySelector<T>(selector)
  if (!control) throw new Error(`no ${selector} labelled "${label}"`)
  return control
}

/** The ball's diameter slider, the control the second half of this page's acceptance is about. */
function ballSlider(): HTMLInputElement {
  const slider = document.querySelector<HTMLInputElement>('[data-test="pet-general-ball-size"]')
  if (!slider) throw new Error('no ball size slider')
  return slider
}

async function dragBallTo(px: number): Promise<void> {
  const slider = ballSlider()
  slider.value = String(px)
  slider.dispatchEvent(new Event('input', { bubbles: true }))
  await flush(DEBOUNCE_PLUS)
}

async function choose(trigger: HTMLElement, value: string): Promise<void> {
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await nextTick()
  const row = [...document.querySelectorAll<HTMLElement>('.select-option')]
    .find((candidate) => candidate.dataset.value === value)
  if (!row) throw new Error(`no option ${value}`)
  row.click()
  await nextTick()
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
  const current = await storedValues(gateway, domain)
  const outcome = await gateway.updateSettings({
    domain,
    revision: loaded.record.revision,
    values: { ...current, ...values },
  } as PetSettingsWrite)
  if (outcome.status !== 'applied') throw new Error(`seed refused: ${outcome.status}`)
}

describe('every control writes the domain it belongs to', () => {
  it('reaches general for the motion policy and view for the window', async () => {
    const gateway = createMemoryPetGateway({ capabilities: ALL_AVAILABLE })
    mount(gateway)
    await flush()

    await choose(fieldControl<HTMLElement>(t('settings.pet.general.motion'), '[role="combobox"]'), 'reduced')
    await flush(DEBOUNCE_PLUS)

    expect(await storedValues(gateway, 'general')).toEqual({
      enabled: true,
      motion: 'reduced',
      // The two window switches are on this page too and this case never touched them: a write is
      // the whole domain, so what a page does not edit keeps the value it was read with.
      ball: true,
      characterWindow: true,
      ballSize: 56,
    })

    // The window behaviour this page owns is `view.alwaysOnTop`, and it is the same kind of check
    // as the two above: the control the page writes is the domain the store reads.
    fieldControl<HTMLInputElement>(t('settings.pet.general.alwaysOnTop'), 'input').click()
    await flush(DEBOUNCE_PLUS)
    expect((await storedValues(gateway, 'view')).alwaysOnTop).toBe(false)
  })

  it('reaches the ball’s own switch, which is the one and only thing that decides the ball', async () => {
    const gateway = createMemoryPetGateway({ capabilities: ALL_AVAILABLE })
    mount(gateway)
    await flush()

    const ball = fieldControl<HTMLInputElement>(t('settings.pet.general.ball'), 'input')
    expect(ball.checked).toBe(true)
    expect(ball.disabled).toBe(false)
    ball.click()
    await flush(DEBOUNCE_PLUS)

    expect((await storedValues(gateway, 'general')).ball).toBe(false)
    // The character window's switch is untouched: the two are one `general` record and two
    // decisions, which is the whole point of the pair — a user who wants the character and not
    // the ball.
    expect((await storedValues(gateway, 'general')).enabled).toBe(true)
  })

  it('reaches the character window’s own switch, which is what makes 只开悬浮球 writable', async () => {
    const gateway = createMemoryPetGateway({ capabilities: ALL_AVAILABLE })
    mount(gateway)
    await flush()

    const characterWindow = fieldControl<HTMLInputElement>(
      t('settings.pet.general.characterWindow'),
      'input',
    )
    expect(characterWindow.checked).toBe(true)
    expect(characterWindow.disabled).toBe(false)
    characterWindow.click()
    await flush(DEBOUNCE_PLUS)

    // 「只开悬浮球」: the two switches are peers and each is stored on its own, so the ball's being
    // on is not a consequence of the character window's being on. `enabled` is derived *from* the
    // pair, and the store recomputes it on every read — so the page writes it beside them, or the
    // draft would differ from every record the store answers with.
    expect(await storedValues(gateway, 'general')).toEqual({
      enabled: true,
      motion: 'system',
      ball: true,
      characterWindow: false,
      ballSize: 56,
    })
  })

  it('takes the derived master down with the last window, and writes that too', async () => {
    const gateway = createMemoryPetGateway({ capabilities: ALL_AVAILABLE })
    mount(gateway)
    await flush()

    fieldControl<HTMLInputElement>(t('settings.pet.general.ball'), 'input').click()
    fieldControl<HTMLInputElement>(t('settings.pet.general.characterWindow'), 'input').click()
    await flush(DEBOUNCE_PLUS)

    // A page that only wrote the switch it was handed would leave `enabled` at true here, and the
    // host — which reads the derived value — would answer false for ever after.
    expect(await storedValues(gateway, 'general')).toEqual({
      enabled: false,
      motion: 'system',
      ball: false,
      characterWindow: false,
      ballSize: 56,
    })
  })

  it('brings the derived master back with either switch, from a store where both were off', async () => {
    const gateway = createMemoryPetGateway({ capabilities: ALL_AVAILABLE })
    await seed(gateway, 'general', { enabled: false, ball: false, characterWindow: false })
    mount(gateway)
    await flush()

    const ball = fieldControl<HTMLInputElement>(t('settings.pet.general.ball'), 'input')
    expect(ball.checked).toBe(false)
    ball.click()
    await flush(DEBOUNCE_PLUS)

    const stored = await storedValues(gateway, 'general')
    expect(stored.ball).toBe(true)
    // The other half of the same rule, from the other direction: the switch that came back on is
    // the one that has to raise the master, and only the page can say so in the draft.
    expect(stored.enabled).toBe(true)
  })

  it('never draws a disabled window switch, in any state the page can render', async () => {
    const gateway = createMemoryPetGateway({ capabilities: ALL_AVAILABLE })
    mount(gateway)
    await flush()

    const boxes = (): HTMLInputElement[] => [
      fieldControl<HTMLInputElement>(t('settings.pet.general.ball'), 'input'),
      fieldControl<HTMLInputElement>(t('settings.pet.general.characterWindow'), 'input'),
    ]
    for (const box of boxes()) expect(box.disabled).toBe(false)

    // Both windows off — the state the removed 显示桌宠 row used to disable this pair in, and the
    // state the user reported: a switch that cannot be operated is not a control.
    for (const box of boxes()) box.click()
    await flush(DEBOUNCE_PLUS)
    for (const box of boxes()) expect(box.disabled).toBe(false)
    expect((await storedValues(gateway, 'general')).enabled).toBe(false)

    // And the same again from the state that follows: one switch off, the other still operable.
    fieldControl<HTMLInputElement>(t('settings.pet.general.ball'), 'input').click()
    await flush(DEBOUNCE_PLUS)
    for (const box of boxes()) expect(box.disabled).toBe(false)
    expect((await storedValues(gateway, 'general')).enabled).toBe(true)
  })
})

describe('the ball’s own size', () => {
  it('draws the slider from the contract’s rule, in the unit the store holds', async () => {
    mount(createMemoryPetGateway({ capabilities: ALL_AVAILABLE }))
    await flush()

    // §5.3 「界面和后端使用同一规则」: the ends are `PET_NUMBER_RULES`, not numbers picked here.
    expect(ballSlider().min).toBe(String(PET_NUMBER_RULES['general.ballSize'].min))
    expect(ballSlider().max).toBe(String(PET_NUMBER_RULES['general.ballSize'].max))
    expect(ballSlider().value).toBe(String(PET_SETTINGS_DEFAULTS.general.ballSize))
  })

  it('writes the diameter it shows, and shows it in the stored unit', async () => {
    const gateway = createMemoryPetGateway({ capabilities: ALL_AVAILABLE })
    mount(gateway)
    await flush()

    await dragBallTo(96)
    expect((await storedValues(gateway, 'general')).ballSize).toBe(96)

    const labels = [...document.querySelectorAll<HTMLElement>('.settings-section .settings-label')]
      .map((element) => element.textContent ?? '')
    expect(labels.some((label) => label.includes(t('settings.pet.general.ballSize', { px: 96 })))).toBe(true)

    // 「重开保留」, on the store rather than on the component: a fresh dialog reads it back.
    unmountAll()
    mount(gateway)
    await flush()
    expect(ballSlider().value).toBe('96')
  })

  it('cannot submit a diameter outside the rule, even when the input is set past its ends', async () => {
    const gateway = createMemoryPetGateway({ capabilities: ALL_AVAILABLE })
    mount(gateway)
    await flush()

    // What this pins is the guarantee, not the layer: the input's own ends come from the same
    // `PET_NUMBER_RULES` entry and stop a gesture before the handler sees it, so which of the two
    // refuses here is not observable — the store's value is.
    await dragBallTo(5)
    expect((await storedValues(gateway, 'general')).ballSize)
      .toBe(PET_NUMBER_RULES['general.ballSize'].min)

    await dragBallTo(900)
    expect((await storedValues(gateway, 'general')).ballSize)
      .toBe(PET_NUMBER_RULES['general.ballSize'].max)
  })
})

describe('§7.2 decides which window behaviours are offered', () => {
  it('disables a roaming mode this machine was not verified to have, and quotes the finding', async () => {
    mount(
      createMemoryPetGateway({
        capabilities: {
          'pointer-follow': { status: 'available' },
          'window-climb': {
            status: 'unavailable',
            fallback: 'not-offered',
            detail: 'this desktop exposes no window list',
          },
        },
      }),
    )
    await flush()

    const trigger = fieldControl<HTMLElement>(t('settings.pet.general.roam'), '[role="combobox"]')
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await nextTick()

    const rows = [...document.querySelectorAll<HTMLElement>('.select-option')]
    const byValue = (value: string): HTMLElement | undefined =>
      rows.find((row) => row.dataset.value === value)
    // `off` and `stay` need nothing; the two that need the desktop are gated.
    expect(byValue('off')?.getAttribute('aria-disabled')).toBeNull()
    expect(byValue('stay')?.getAttribute('aria-disabled')).toBeNull()
    expect(byValue('follow-pointer')?.getAttribute('aria-disabled')).toBeNull()
    expect(byValue('climb')?.getAttribute('aria-disabled')).toBe('true')

    const notes = [...document.querySelectorAll<HTMLElement>('.settings-section .settings-note')]
      .map((note) => note.textContent ?? '')
    expect(notes.some((note) => note.includes('this desktop exposes no window list'))).toBe(true)
  })

  it('quotes the host for a capability that was reported and not verified', async () => {
    mount(createMemoryPetGateway())
    await flush()

    const notes = [...document.querySelectorAll<HTMLElement>('.settings-section .settings-note')]
      .map((note) => note.textContent ?? '')
    // The default host reports `unverified`, which is not the same claim as `unavailable` —
    // §7.2 forbids presenting one as the other, so the host's own sentence is what is shown.
    expect(notes.some((note) => note.includes('not verified on this host yet'))).toBe(true)
    expect(notes.some((note) => note.includes(t('settings.pet.capabilityUnknown')))).toBe(false)
  })

  it('says nothing has been checked when the host reported nothing at all', async () => {
    const gateway = createMemoryPetGateway()
    vi.spyOn(gateway, 'capabilities').mockResolvedValue([])
    mount(gateway)
    await flush()

    const notes = [...document.querySelectorAll<HTMLElement>('.settings-section .settings-note')]
      .map((note) => note.textContent ?? '')
    expect(notes.some((note) => note.includes(t('settings.pet.capabilityUnknown')))).toBe(true)
  })

  it('keeps a stored mode this machine cannot run instead of rewriting it', async () => {
    const gateway = createMemoryPetGateway()
    await seed(gateway, 'view', { roam: 'climb' })
    mount(gateway)
    await flush()

    // §5.3 keeps the choice as a preference that follows the user between machines; §7.2
    // disables the *modes*, not the value. The control shows it and the store still holds it.
    const value = document.querySelector<HTMLElement>('#pet-general-roam .select-value')
    expect(value?.textContent?.trim()).toBe(t('settings.pet.general.roamClimb'))
    expect((await storedValues(gateway, 'view')).roam).toBe('climb')
  })

  it('says the mode reaches no window, which is the state the setting is in', async () => {
    // **The claim this page owes a reader, and the one §7.2's notes cannot make.** Those refuse
    // the modes a capability was not verified for; this one is about the value itself — the engine
    // it is written for (`features/desktop-pet/motion/`) is imported by no page, so every mode that
    // survives the gate above behaves the same today. A control with no effect that looks live is
    // the defect, and the note is the fix; the case is here so the note cannot be dropped while the
    // wiring is still missing. It is *not* the instrument that catches the wiring: the day the
    // engine is imported from the character window's root, `app/desktop-pet-entry.test.ts`'s graph
    // list refuses the new imports, and this note and this case are what that change deletes.
    mount(createMemoryPetGateway({ capabilities: ALL_AVAILABLE }))
    await flush()

    const note = document.querySelector<HTMLElement>('[data-test="pet-general-roam-not-wired"]')
    expect(note?.textContent?.trim()).toBe(t('settings.pet.general.roamNote'))
    // Drawn after the control it is about and inside the same section, rather than somewhere else
    // on the page: a note that drifted away from its row would be a sentence about nothing. The
    // capability is reported available here, so no restriction note sits between the two and the
    // order is the control's own.
    const trigger = document.querySelector<HTMLElement>('#pet-general-roam')
    expect(trigger).not.toBeNull()
    expect(trigger!.compareDocumentPosition(note!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(note?.closest('.settings-section')).toBe(trigger?.closest('.settings-section'))
  })

  it('leaves always-on-top alone where the desktop was not verified to keep a window above', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    const box = fieldControl<HTMLInputElement>(t('settings.pet.general.alwaysOnTop'), 'input')
    expect(box.disabled).toBe(true)
    box.click()
    await flush(DEBOUNCE_PLUS)
    // Clicking a disabled control is not a write, and the stored preference is untouched.
    expect((await storedValues(gateway, 'view')).alwaysOnTop).toBe(true)
  })
})

describe('restoring this page', () => {
  it('returns both of this page’s domains to their defaults, and writes nothing else', async () => {
    const gateway = createMemoryPetGateway({ capabilities: ALL_AVAILABLE })
    const write = vi.spyOn(gateway, 'updateSettings')
    mount(gateway)
    await flush()

    fieldControl<HTMLInputElement>(t('settings.pet.general.ball'), 'input').click()
    await dragBallTo(96)
    fieldControl<HTMLInputElement>(t('settings.pet.general.alwaysOnTop'), 'input').click()
    await flush(DEBOUNCE_PLUS)
    // Both of this page's domains are dirty before the reset, so what follows is the reset and
    // not an absence of change.
    expect((await storedValues(gateway, 'view')).alwaysOnTop).toBe(false)
    write.mockClear()

    const reset = [...document.querySelectorAll<HTMLButtonElement>('.settings-section button')]
      .find((button) => button.textContent?.includes(t('settings.pet.reset')))
    if (!reset) throw new Error('no reset button')
    reset.click()
    await flush(DEBOUNCE_PLUS)

    expect(await storedValues(gateway, 'general')).toEqual({
      enabled: true,
      motion: 'system',
      ball: true,
      characterWindow: true,
      ballSize: 56,
    })
    expect((await storedValues(gateway, 'view')).alwaysOnTop).toBe(true)
    // §5.3 「恢复本页默认只影响当前域」: the reset reached this page's two domains and no others,
    // which is what keeps it from clearing the character library or care progress.
    expect([...new Set(write.mock.calls.map((call) => call[0].domain))].sort()).toEqual(['general', 'view'])
  })
})
