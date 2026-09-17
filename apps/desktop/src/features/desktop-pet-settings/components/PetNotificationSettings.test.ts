/**
 * §5.1's 通知与声音: the switches §6.2 lets a user choose, and the rule that this page is not a
 * second notifier.
 *
 * The interesting assertions here are the negative ones. §11's settings cases include
 * 「预览不发真实通知」, and the way that is enforced is structural — the gateway has no delivery
 * method, so the only thing a page *can* reach is a settings read or write — which means the
 * test has to walk a real interaction and then show that nothing else on the host was touched.
 * A reminder that appeared from a settings page would be the second authority §6.3 rules out.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, h, nextTick, type App as VueApp } from 'vue'
import { t } from '../../../i18n'
import { createMemoryPetGateway, type MemoryPetGateway } from '../../../platform/gateways/memory-pet'
import {
  PET_SETTINGS_SCHEMA_VERSION,
  type PetSettingsDomain,
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

function mount(gateway: MemoryPetGateway): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(() => h(DesktopPetSettings, { gateway, page: 'notification' }))
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

function notes(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.settings-section .settings-note')]
    .map((note) => note.textContent ?? '')
}

async function storedValues(
  gateway: MemoryPetGateway,
  domain: PetSettingsDomain,
): Promise<Record<string, unknown>> {
  const loaded = await gateway.readSettings(domain)
  if (loaded.status === 'read-only') throw new Error(`read-only: ${domain}`)
  return loaded.record.values as unknown as Record<string, unknown>
}

/**
 * Every gateway method that is not a settings read or write, so the page's reach is assertable.
 *
 * The six have six signatures, and the type they are collected under says so: `Mock<Procedure>`
 * — what `ReturnType<typeof vi.fn>` names — is a mock of *some* procedure, and Vitest's
 * `MockInstance<T>` is not assignable to it, because a mock of a specific signature is not a
 * value that can be re-declared for any other one. The parameter list is the widest a function of
 * these signatures can be read as, and the assertions below only ever ask whether one was called.
 */
function watchTheRest(gateway: MemoryPetGateway): MockInstance<(...args: never[]) => unknown>[] {
  return [
    vi.spyOn(gateway, 'feature'),
    vi.spyOn(gateway, 'setVisible'),
    vi.spyOn(gateway, 'tasks'),
    vi.spyOn(gateway, 'subscribe'),
    vi.spyOn(gateway, 'openSettings'),
    vi.spyOn(gateway, 'capabilities'),
  ]
}

describe('the switches', () => {
  it('writes each ending to the notification domain, and finds them where they were left', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    fieldControl<HTMLInputElement>(t('settings.pet.notification.onFailed'), 'input').click()
    fieldControl<HTMLInputElement>(t('settings.pet.notification.sound'), 'input').click()
    await flush(DEBOUNCE_PLUS)

    expect(await storedValues(gateway, 'notification')).toEqual({
      onTurnFinished: true,
      onStopped: true,
      onFailed: false,
      onWaitingInput: true,
      sound: false,
      doNotDisturb: false,
      showTaskTitle: false,
    })

    unmountAll()
    mount(gateway)
    await flush()
    expect(fieldControl<HTMLInputElement>(t('settings.pet.notification.onFailed'), 'input').checked).toBe(false)
    expect(fieldControl<HTMLInputElement>(t('settings.pet.notification.sound'), 'input').checked).toBe(false)
    expect(fieldControl<HTMLInputElement>(t('settings.pet.notification.onWaitingInput'), 'input').checked).toBe(true)
  })
})

describe('the reminder preview', () => {
  it('is drawn here, follows the switches, and never touches the host', async () => {
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()
    const others = watchTheRest(gateway)

    const card = document.querySelector('.pet-reminder')
    expect(card?.querySelector('.pet-reminder__title')?.textContent?.trim())
      .toBe(t('settings.pet.notification.sampleTitle'))
    expect(notes().some((note) => note.includes(t('settings.pet.notification.sampleShown')))).toBe(true)
    // The one sentence that has to be on screen whatever the switches say.
    expect(notes().some((note) => note.includes(t('settings.pet.notification.sampleNote')))).toBe(true)

    // §6.3's privacy default: off, so the sample carries no task name.
    fieldControl<HTMLInputElement>(t('settings.pet.notification.showTaskTitle'), 'input').click()
    await nextTick()
    expect(document.querySelector('.pet-reminder__title')?.textContent?.trim())
      .toBe(t('settings.pet.notification.sampleTitleNamed'))

    fieldControl<HTMLInputElement>(t('settings.pet.notification.doNotDisturb'), 'input').click()
    await nextTick()
    expect(notes().some((note) => note.includes(t('settings.pet.notification.sampleSilent')))).toBe(true)

    fieldControl<HTMLInputElement>(t('settings.pet.notification.doNotDisturb'), 'input').click()
    fieldControl<HTMLInputElement>(t('settings.pet.notification.onTurnFinished'), 'input').click()
    await nextTick()
    expect(notes().some((note) => note.includes(t('settings.pet.notification.sampleQuiet')))).toBe(true)

    await flush(DEBOUNCE_PLUS)
    // §11 「预览不发真实通知」: the whole interaction reached the settings and nothing else. No
    // window was shown, no task list was read, and no page was opened.
    for (const spy of others) expect(spy).not.toHaveBeenCalled()
  })

  it('says the desktop cannot raise one, in the host’s own words', async () => {
    mount(
      createMemoryPetGateway({
        capabilities: {
          'system-notification': {
            status: 'unavailable',
            fallback: 'unread-list',
            detail: 'no notification portal is running on this desktop',
          },
        },
      }),
    )
    await flush()

    // §7.2's third column, in the host's words rather than as an error code (`platform.ts`
    // makes `detail` the user-facing half of a finding).
    expect(notes().some((note) => note.includes('no notification portal is running on this desktop'))).toBe(true)
  })

  it('says nothing has been checked when the host reported nothing', async () => {
    const gateway = createMemoryPetGateway()
    vi.spyOn(gateway, 'capabilities').mockResolvedValue([])
    mount(gateway)
    await flush()
    expect(notes().some((note) => note.includes(t('settings.pet.capabilityUnknown')))).toBe(true)
  })
})

describe('a store written by a newer build', () => {
  it('drops the form rather than showing this build’s defaults as the user’s settings', async () => {
    mount(createMemoryPetGateway({ storedSchemaVersion: PET_SETTINGS_SCHEMA_VERSION + 1 }))
    await flush()

    expect(notes().some((note) => note.includes(t('settings.pet.readOnly')))).toBe(true)
    expect(document.querySelector('.settings-section .settings-toggle')).toBeNull()
    // The stage goes with it: a pet drawn from defaults the user never chose is the same claim.
    expect(document.querySelector('.pet-preview__stage')).toBeNull()
    expect(notes().concat([...document.querySelectorAll<HTMLElement>('.pet-preview .settings-note')]
      .map((note) => note.textContent ?? ''))
      .some((note) => note.includes(t('settings.pet.readOnly')))).toBe(true)
  })
})
