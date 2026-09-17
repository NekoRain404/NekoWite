/**
 * Every control in the dialog writes through to the store it shows.
 *
 * The gap this closes: `typecheck`, `lint` and the other unit tests are all
 * blind to a two-way binding that renders correctly but drops its write. The
 * export section's model bindings were exactly that — `defineModel` left as a
 * bare call registers the model name as a *props* binding, so the template
 * compiled the change handler into `$props.frontmatter = value`. Vue refuses a
 * props write in development and drops it in production, so the checkbox moved
 * under the pointer and the store never changed. Nothing failed except the
 * e2e console sweep, which caught the dev warning rather than the dead control.
 *
 * So each case here drives the real control and then reads the store — the
 * assertion the warning is a proxy for — and the interactions are also required
 * to be free of Vue warnings, so a binding that silently detaches again fails
 * here rather than only in `e2e/console-clean.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import SettingsPanel from './SettingsPanel.vue'
import { t } from '../../../i18n'
import { useAiPermissionStore } from '../../../stores/ai-permission'
import { useSettingsStore } from '../../../stores/settings'
import { useAppearanceStore } from '../../../stores/appearance'
import {
  APPEARANCE_DEFAULTS,
  BODY_FONT_SIZE_MAX,
  BODY_FONT_SIZE_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
} from '../../../stores/appearance-schema'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const getVersionMock = vi.hoisted(() => vi.fn(async () => '9.9.9'))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: getVersionMock }))

let mounted: VueApp[] = []
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  localStorage.clear()
  setActivePinia(createPinia())
  globalThis.matchMedia = vi.fn(() => ({
    matches: false,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as never
  document.body.innerHTML = ''
  mounted = []
  // Vue reports the refused write through `console.warn`, not through a
  // component's `warnHandler` (the reactivity layer warns on its own), so the
  // console is where a detached binding shows up.
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
  warnSpy.mockRestore()
})

function mountPanel(): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(SettingsPanel, { onClose: vi.fn(), onSaved: vi.fn() } as never)
  app.mount(host)
  mounted.push(app)
}

const SECTIONS = ['general', 'appearance', 'editor', 'export', 'ai', 'plugins'] as const
type SectionId = (typeof SECTIONS)[number]

/** The section rails are labelled, and the ids are the order they render in. */
async function openSection(id: SectionId): Promise<void> {
  mountPanel()
  await nextTick()
  const nav = Array.from(document.querySelectorAll<HTMLElement>('.nav-row'))
  nav[SECTIONS.indexOf(id)]?.click()
  await nextTick()
  if (!document.querySelector('.settings-section')) {
    throw new Error(`no section rendered for ${id}`)
  }
}

/** The control inside the labelled field, e.g. the checkbox of "include frontmatter". */
function fieldControl<T extends HTMLElement>(label: string, selector: string): T {
  const field = Array.from(document.querySelectorAll<HTMLElement>('.settings-section label'))
    .find((candidate) => candidate.textContent?.includes(label))
  const control = field?.querySelector<T>(selector)
  if (!control) throw new Error(`no ${selector} labelled "${label}"`)
  return control
}

/** The dropdown inside the labelled field. It is reached through the same
 *  `label` wrapper the native select sat in, so the association this suite is
 *  about is still the thing under test. */
function fieldMenu(label: string): HTMLElement {
  return fieldControl<HTMLElement>(label, '[role="combobox"]')
}

function toggle(control: HTMLInputElement): void {
  control.click()
}

/** The rows live in the popup, which is teleported to `<body>`. */
function optionRows(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.select-option')]
}

async function openMenu(trigger: HTMLElement): Promise<void> {
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await nextTick()
}

/** Take the row carrying `value`, the way a user does: open, then pick. */
async function choose(trigger: HTMLElement, value: string): Promise<void> {
  if (trigger.getAttribute('aria-expanded') !== 'true') await openMenu(trigger)
  const row = optionRows().find((candidate) => candidate.dataset.value === value)
  if (!row) throw new Error(`no option ${value}`)
  row.click()
  await nextTick()
}

/** Take any row other than the chosen one, and say which it was. */
async function chooseOther(trigger: HTMLElement): Promise<string> {
  if (trigger.getAttribute('aria-expanded') !== 'true') await openMenu(trigger)
  const row = optionRows().find((candidate) => candidate.getAttribute('aria-selected') === 'false')
  if (!row) throw new Error('no unselected option to take')
  row.click()
  await nextTick()
  return row.dataset.value ?? ''
}

function vueWarnings(): string[] {
  return warnSpy.mock.calls
    .map((args) => String(args[0]))
    .filter((message) => message.includes('[Vue warn]'))
}

describe('SettingsPanel control bindings', () => {
  it('writes the export section controls through to the settings store', async () => {
    await openSection('export')
    const settings = useSettingsStore()
    expect(settings.exportIncludeFrontmatter).toBe(true)

    toggle(fieldControl<HTMLInputElement>(t('settings.export.frontmatter'), 'input'))
    await nextTick()
    expect(settings.exportIncludeFrontmatter).toBe(false)

    await choose(fieldMenu(t('settings.export.pageSize')), 'Letter')
    await choose(fieldMenu(t('settings.export.orientation')), 'landscape')
    await nextTick()
    expect(settings.exportPdfPageSize).toBe('Letter')
    expect(settings.exportPdfOrientation).toBe('landscape')

    // The toggled checkbox has to show the new value on a second pass, which is
    // what makes the store the single source rather than a side effect.
    toggle(fieldControl<HTMLInputElement>(t('settings.export.frontmatter'), 'input'))
    await nextTick()
    expect(settings.exportIncludeFrontmatter).toBe(true)

    expect(vueWarnings()).toEqual([])
  })

  it('writes the AI section controls through to the settings store', async () => {
    await openSection('ai')
    const settings = useSettingsStore()
    expect(settings.allowPrivate).toBe(true)

    toggle(fieldControl<HTMLInputElement>(t('aiSettings.allowPrivate'), 'input'))
    await nextTick()
    expect(settings.allowPrivate).toBe(false)

    toggle(fieldControl<HTMLInputElement>(t('aiSettings.systemPrompt'), 'input'))
    await nextTick()
    expect(settings.systemPromptOn).toBe(true)

    await choose(fieldMenu(t('aiSettings.effort')), 'high')
    await nextTick()
    expect(settings.reasoningEffort).toBe('high')

    // The models-URL override is the field the "refresh finds no models" report
    // needed; a binding that renders but drops its write would leave the escape
    // hatch inert, which is exactly the failure this suite exists to catch.
    const modelsUrl = fieldControl<HTMLInputElement>(t('aiSettings.modelsUrl'), 'input')
    modelsUrl.value = 'https://tokenflux.dev/v1/models'
    modelsUrl.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(settings.modelsUrl).toBe('https://tokenflux.dev/v1/models')

    expect(vueWarnings()).toEqual([])
  })

  it('writes the AI permission controls through to the permission store', async () => {
    await openSection('ai')
    const permissions = useAiPermissionStore()
    const enabledBefore = permissions.enabled

    toggle(fieldControl<HTMLInputElement>(t('aiperm.enabled'), 'input'))
    await nextTick()
    expect(permissions.enabled).toBe(!enabledBefore)

    const other = await chooseOther(fieldMenu(t('aiperm.policy')))
    expect(other).toBeTruthy()
    await nextTick()
    expect(permissions.policy).toBe(other)

    expect(vueWarnings()).toEqual([])
  })

  it('offers the typography range the store holds those settings to, not a copy of it', async () => {
    // The two fields used to write their own bounds a third time — `min="12" max="20"` beside a
    // `Math.min(20, Math.max(12, …))` around the value — so the range was declared in
    // `appearance-schema.ts`, again in `stores/appearance.ts`'s setter and again in the template,
    // and nothing kept the three in step. Widening `BODY_FONT_SIZE_MAX` would have left this control
    // offering the old ceiling to a user while `setBodyFontSize` accepted the new one.
    //
    // It cannot diverge *today* — the setter now walks the schema's rule — so this case is pinned to
    // the relationship rather than to a defect: the field's own ends are the store's own constants,
    // imported rather than restated, and the largest number the spinner can reach is a value the
    // store keeps. A literal edited back in fails the first pair the moment the schema moves, which
    // is the day it would have mattered.
    await openSection('appearance')
    const fields = [
      ...document.querySelectorAll<HTMLInputElement>('.settings-section input[type="number"]'),
    ]
    expect(fields.length, 'the appearance section has exactly these two numeric fields').toBe(2)
    // The order is `AppearanceSettings.vue`'s mark-up: the body size, then the leading. Checked
    // rather than assumed, because the labels carry each field's *current* value and a reorder would
    // otherwise make this case assert one field's range against the other's — which is green.
    const [size, leading] = fields
    const appearance = useAppearanceStore()
    expect(size.value).toBe(String(appearance.bodyFontSize))
    expect(leading.value).toBe(String(appearance.lineHeight))

    expect(size.min).toBe(String(BODY_FONT_SIZE_MIN))
    expect(size.max).toBe(String(BODY_FONT_SIZE_MAX))
    expect(leading.min).toBe(String(LINE_HEIGHT_MIN))
    expect(leading.max).toBe(String(LINE_HEIGHT_MAX))
    // The step is the leading's own: the range is a bound and not a rounding, which is why neither
    // field's value goes through `clampInt`.
    expect(leading.step).toBe('0.1')

    // The two doors, at the ends: the number the field offers at its own ceiling is a value the
    // store keeps, and so is the smallest at its floor. A field offering a range the store refused
    // would show one number and store another.
    for (const [field, ceiling, floor, stored] of [
      [size, BODY_FONT_SIZE_MAX, BODY_FONT_SIZE_MIN, () => appearance.bodyFontSize],
      [leading, LINE_HEIGHT_MAX, LINE_HEIGHT_MIN, () => appearance.lineHeight],
    ] as const) {
      field.value = field.max
      field.dispatchEvent(new Event('change', { bubbles: true }))
      await nextTick()
      expect(stored()).toBe(ceiling)
      field.value = field.min
      field.dispatchEvent(new Event('change', { bubbles: true }))
      await nextTick()
      expect(stored()).toBe(floor)
    }

    // An emptied field is the one thing the template still decides (a fact about the widget, not
    // about the setting): it lands on the store's own fallback rather than on 0, which is what the
    // schema's `clampBodyFontSize` would have made of it.
    size.value = ''
    size.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    expect(appearance.bodyFontSize).toBe(APPEARANCE_DEFAULTS.bodyFontSize)

    expect(vueWarnings()).toEqual([])
  })
})
