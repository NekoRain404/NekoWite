/**
 * The container's contract, as the two things another task and the acceptance both depend on.
 *
 * For D7b and D7c: a page is *slot content*, it is offered only when it exists, and the object
 * it is handed carries the container's own sessions — so the page that shows a value and the
 * preview that draws it cannot be reading two different drafts.
 *
 * For §10's acceptance: 「主开关/通知/预览真实生效、重开保留」. The switch is driven here through
 * the real control, read back out of the store, and then found again after the dialog is closed
 * and reopened — which is the only version of "it persists" that is about the store rather than
 * about the component's own state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { t } from '../../../i18n'
import { createMemoryPetGateway, type MemoryPetGateway } from '../../../platform/gateways/memory-pet'
import type { PetSettingsDomain } from '../../../platform/gateways/pet-contracts'
import DesktopPetSettings from './DesktopPetSettings.vue'

let mounted: VueApp[] = []
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
  mounted = []
  // happy-dom exposes no `matchMedia`; the preview reads one query through it.
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

/**
 * A slot fill, as the container renders it.
 *
 * It takes props: §5.1's slot content is handed the container's own context — the sessions the
 * page and the preview have to share — so a fill declared as a no-argument function is a fill
 * that cannot be handed anything. That declaration is what the checker was reading when it
 * refused the fill below, and the runtime had been handing the props over all along.
 */
type SlotFill = (slotProps: { context: Record<string, unknown> }) => unknown

function mount(properties: Record<string, unknown>, slots?: Record<string, SlotFill>): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(() => h(DesktopPetSettings, properties, slots))
  app.mount(host)
  mounted.push(app)
}

/** Let the host's promises settle, the debounce window pass, and Vue render the result. */
async function flush(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await nextTick()
}

const DEBOUNCE_PLUS = 600

function tabs(): (string | undefined)[] {
  return [...document.querySelectorAll<HTMLElement>('.pet-settings__tab')].map((el) => el.dataset.page)
}

function fieldControl<T extends HTMLElement>(label: string, selector: string): T {
  const field = [...document.querySelectorAll<HTMLElement>('.settings-section label')]
    .find((candidate) => candidate.textContent?.includes(label))
  const control = field?.querySelector<T>(selector)
  if (!control) throw new Error(`no ${selector} labelled "${label}"`)
  return control
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

describe('which pages the container offers', () => {
  it('offers the pages it can render, and names the ones that have not landed', async () => {
    mount({ gateway: createMemoryPetGateway() })
    await flush()

    // §5.2 forbids a control that leads nowhere, so a page with no component is not a row.
    expect(tabs()).toEqual(['general', 'notification'])
    const pending = document.querySelector('.pet-settings__pending')?.textContent ?? ''
    for (const page of ['character', 'bubble', 'care', 'project', 'advanced'] as const) {
      expect(pending).toContain(t(`settings.pet.page.${page}`))
    }
    expect(warnSpy.mock.calls.filter((call) => String(call[0]).includes('[Vue warn]'))).toEqual([])
  })

  it('hosts a page another task fills in, and hands it the container’s own sessions', async () => {
    // What the container handed the slot, in a container of its own: a `let` assigned inside the
    // stub's `setup` and read after `mount` is one control-flow analysis still reads as its
    // initial value, so `captured?.sessions` below would be a property read of `never`.
    const captured: { context?: { sessions?: Record<string, unknown> } } = {}
    const SlotStub = defineComponent({
      props: { context: { type: Object, required: true } },
      setup(pageProps) {
        captured.context = pageProps.context
        return () => h('div', { class: 'slot-stub' })
      },
    })
    // The filler forwards the slot's own `context`, which is the whole wiring a slot page
    // needs — and a filler that forgets it is loud rather than silent: the page's `context`
    // prop is required, so Vue names the missing prop.
    mount({ gateway: createMemoryPetGateway() }, {
      character: (slotProps) => h(SlotStub, slotProps),
    })
    await flush()

    expect(tabs()).toContain('character')
    document.querySelector<HTMLElement>('[data-page="character"]')?.click()
    await flush()
    expect(document.querySelector('.slot-stub')).not.toBeNull()
    // Not a context of its own: the page reads the same session the preview will.
    expect(Object.keys(captured.context?.sessions ?? {}).sort()).toEqual([
      'care',
      'character',
      'general',
      'message',
      'notification',
      'project',
      'view',
    ])
  })

  it('states the missing host connection instead of drawing a form over defaults', async () => {
    mount({})
    await flush()

    const absence = document.querySelector('.pet-settings__absence')?.textContent ?? ''
    expect(absence).toContain(t('settings.pet.noGateway'))
    expect(tabs()).toEqual([])
    expect(document.querySelector('.settings-section')).toBeNull()
    expect(document.querySelector('.pet-preview__stage')).toBeNull()
  })

  it('opens on the page it was asked for, and lands on a real one when asked for a missing page', async () => {
    const onPage = vi.fn()
    mount({ gateway: createMemoryPetGateway(), page: 'notification', 'onUpdate:page': onPage })
    await flush()
    expect(document.querySelector('.pet-reminder')).not.toBeNull()
    expect(document.querySelector('#pet-general-motion')).toBeNull()

    document.querySelector<HTMLElement>('[data-page="general"]')?.click()
    await flush()
    expect(onPage).toHaveBeenCalledWith('general')
    expect(document.querySelector('#pet-general-motion')).not.toBeNull()

    // §5.1's deep link names a page; a page this build cannot render must not be a blank pane.
    unmountAll()
    mount({ gateway: createMemoryPetGateway(), page: 'care' })
    await flush()
    expect(document.querySelector('#pet-general-motion')).not.toBeNull()
  })

  it('reads the preview’s domains and the open page’s, and no others', async () => {
    const gateway = createMemoryPetGateway()
    const read = vi.spyOn(gateway, 'readSettings')
    mount({ gateway })
    await flush()

    expect([...new Set(read.mock.calls.map((call) => call[0]))].sort()).toEqual([
      'character',
      'general',
      'message',
      'view',
    ])

    document.querySelector<HTMLElement>('[data-page="notification"]')?.click()
    await flush()
    expect([...new Set(read.mock.calls.map((call) => call[0]))].sort()).toEqual([
      'character',
      'general',
      'message',
      'notification',
      'view',
    ])
  })
})

describe('the master switch, end to end', () => {
  it('writes the general domain and is still off after the dialog is closed and reopened', async () => {
    const gateway = createMemoryPetGateway()
    mount({ gateway })
    await flush()

    const box = fieldControl<HTMLInputElement>(t('settings.pet.general.enabled'), 'input')
    expect(box.checked).toBe(true)
    box.click()
    await flush(DEBOUNCE_PLUS)

    expect((await storedValues(gateway, 'general')).enabled).toBe(false)
    // 「预览真实生效」: the stage follows the switch rather than describing it.
    expect(document.querySelector('.pet-preview__notice')?.textContent)
      .toContain(t('settings.pet.preview.off'))

    unmountAll()
    mount({ gateway })
    await flush()

    expect(fieldControl<HTMLInputElement>(t('settings.pet.general.enabled'), 'input').checked).toBe(false)
    expect(document.querySelector('.pet-preview__notice')).not.toBeNull()
  })

  it('says so instead of pretending to save when the store refuses the write', async () => {
    const gateway = createMemoryPetGateway({ writeFailures: 1 })
    mount({ gateway })
    await flush()

    fieldControl<HTMLInputElement>(t('settings.pet.general.enabled'), 'input').click()
    await flush(DEBOUNCE_PLUS)

    // §5.3: the store did not persist it, so the switch stays where the user put it and the
    // store still holds the old value — a switch that snapped back would be claiming success.
    expect((await storedValues(gateway, 'general')).enabled).toBe(true)
    expect(fieldControl<HTMLInputElement>(t('settings.pet.general.enabled'), 'input').checked).toBe(false)
  })
})
