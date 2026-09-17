/**
 * The preview, as §5.3 states it: 「试调外观即时预览」 — it follows the *draft*, not the store.
 *
 * That distinction is the whole suite. A preview that read the store would be a second consumer
 * of the same domain and would lag the control by its debounce window; a preview that wrote
 * anything would be a second author. So each case here edits through the real control and then
 * looks at the stage *before* the write happens, and the last one watches a value the page
 * cannot change at all — the bubble's life — to show the stage is reading the setting rather
 * than a number of its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, h, nextTick, type App as VueApp } from 'vue'
import { t } from '../../../i18n'
import { createMemoryPetGateway, type MemoryPetGateway } from '../../../platform/gateways/memory-pet'
import { PET_NUMBER_RULES } from '../../../platform/gateways/pet-contracts'
import type { PetSettingsDomain, PetSettingsWrite } from '../../../platform/gateways/pet-contracts'
import DesktopPetSettings from './DesktopPetSettings.vue'
import type { PetSettingsContext } from './DesktopPetSettings.vue'
import PetBubbleSettings from './PetBubbleSettings.vue'

let mounted: VueApp[] = []
let warnSpy: ReturnType<typeof vi.spyOn>
/** What `prefers-reduced-motion` answers. Replaced per test before anything mounts. */
let systemReducedMotion = false

beforeEach(() => {
  // The preview draws in this *window's* appearance as well as the pet's own settings (§1's
  // 「保留现有主题、强调色」): its stage carries the same four axes the app's root does, read from the
  // appearance store. So a suite that mounts it provides the store's world the same way it
  // provides a gateway — a Pinia, installed on the app under test.
  setActivePinia(createPinia())
  localStorage.clear()
  vi.useFakeTimers()
  document.body.innerHTML = ''
  mounted = []
  systemReducedMotion = false
  globalThis.matchMedia = vi.fn(() => ({
    matches: systemReducedMotion,
    media: '(prefers-reduced-motion: reduce)',
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
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
  warnSpy.mockRestore()
  vi.useRealTimers()
})

function mount(gateway: MemoryPetGateway): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(() => h(DesktopPetSettings, { gateway, page: 'general' }))
  app.mount(host)
  mounted.push(app)
}

/**
 * The same container, opened on the bubble page and given that page's component as slot content.
 *
 * The bubble's controls are another task's page (`PetBubbleSettings.vue`), and the container
 * offers a page only when something is behind it — so a test that wants to *move* the opacity
 * control has to supply it, which is also how the app mounts it.
 */
function mountOnBubblePage(gateway: MemoryPetGateway): void {
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
  await nextTick()
}

function figure(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.pet-preview__figure')
  if (!el) throw new Error('no preview figure')
  return el
}

/** The stage, which is the element the appearance is selected on. */
function stage(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.pet-preview__stage')
}

function previewNotes(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.pet-preview .settings-note')]
    .map((note) => note.textContent ?? '')
}

function askForBubble(): void {
  const ask = document.querySelector<HTMLButtonElement>('.pet-preview__ask')
  if (!ask) throw new Error('no bubble button')
  ask.click()
}

/**
 * The alpha the stage's bubble is drawn at.
 *
 * Read off the custom property the surface carries rather than off `style.background`: the
 * background is a `color-mix()` expression the *stylesheet* owns (the colour is the theme's, the
 * alpha is the setting's), and the binding is what this component decides.
 */
function bubbleAlpha(): string {
  return bubbleProperty('--pet-bubble-alpha')
}

/**
 * The size the stage's bubble declares, read off the same custom property the *desktop's* bubble
 * carries (`PetBubble.vue`'s `--pet-bubble-size`, which `message.fontSize` reaches it through).
 *
 * The binding is what this component decides and what happy-dom can see; whether the stylesheet
 * *consumes* it is measured in a real engine by `e2e/desktop-pet-appearance.spec.ts`, which compares
 * this surface's computed size against the pet window's.
 */
function bubbleSize(): string {
  return bubbleProperty('--pet-bubble-size')
}

function bubbleProperty(name: string): string {
  const el = document.querySelector<HTMLElement>('.pet-preview__bubble')
  if (!el) throw new Error('no preview bubble')
  return el.style.getPropertyValue(name)
}

/** A file beside this one, as text — for the assertions that are about a *declaration*. */
function source(relative: string): string {
  return readFileSync(resolve(__dirname, relative), 'utf8')
}

async function storedValues(
  gateway: MemoryPetGateway,
  domain: PetSettingsDomain,
): Promise<Record<string, unknown>> {
  const loaded = await gateway.readSettings(domain)
  if (loaded.status === 'read-only') throw new Error(`read-only: ${domain}`)
  return loaded.record.values as unknown as Record<string, unknown>
}

/** Put a domain where a test needs it before anything reads it. */
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

describe('the stage follows the draft', () => {
  it('moves the bubble with the opacity slider before anything is written', async () => {
    const gateway = createMemoryPetGateway()
    const write = vi.spyOn(gateway, 'updateSettings')
    mountOnBubblePage(gateway)
    await flush()

    // The stage draws the bubble on request (§6.3 keeps a bubble from appearing on its own), and
    // it opens on the schema's default alpha.
    askForBubble()
    await flush()
    expect(bubbleAlpha()).toBe('92%')

    const slider = document.querySelector<HTMLInputElement>('#pet-bubble-opacity')
    if (!slider) throw new Error('no opacity slider')
    slider.value = '70'
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    // Still inside the debounce window: nothing has been saved, and the stage has moved — on the
    // *bubble*, which is the surface the setting is about. The figure keeps the character's size
    // and is not dimmed, because upstream's alpha is `--bubble-bg`'s and nothing else's.
    expect(write).not.toHaveBeenCalled()
    expect(bubbleAlpha()).toBe('70%')
    expect(figure().style.opacity).toBe('')
  })

  it('draws the bubble at the size the setting names, before anything is written', async () => {
    // The size half of the same claim the alpha half makes above, and the one the stage used to get
    // wrong in the way nobody checks a decoration for: `.pet-preview__bubble` declared a fixed
    // `font-size: 11px` while the desktop's bubble draws `message.fontSize` — the setting this very
    // page offers as three buttons. So the stage showed a bubble size the user could not reach by
    // clicking, which is a preview lying about the one thing it exists for.
    //
    // Read off the custom property the *desktop's* bubble carries, not off a second number: the same
    // binding, so the two surfaces cannot be given different sizes by this component.
    const gateway = createMemoryPetGateway()
    const largest = PET_NUMBER_RULES['message.fontSize'].max
    const smallest = PET_NUMBER_RULES['message.fontSize'].min
    await seed(gateway, 'message', { fontSize: largest })
    mountOnBubblePage(gateway)
    await flush()

    askForBubble()
    await flush()
    expect(bubbleSize()).toBe(`${largest}px`)

    // Moved through the page's own control, and read before the write lands — the stage follows the
    // draft, so a preview that only moved after a save would be showing the old size while the user
    // is choosing the new one.
    const button = document.querySelector<HTMLButtonElement>(`[data-test="pet-bubble-font-size-${smallest}"]`)
    if (!button) throw new Error('no font-size button')
    button.click()
    await nextTick()
    expect(bubbleSize()).toBe(`${smallest}px`)
  })

  it('draws the desktop’s own bubble, not a second one built out of its parts', async () => {
    // The three rounds of this defect, and this case is what closes the family of them. **1** colour:
    // the stage answered Light and Dark with a pair of literals the app draws nowhere. **2** size:
    // it declared `font-size: 11px` while the desktop draws `message.fontSize` — the setting this
    // page offers as three buttons. **3** the box, which the first two fixes left: `padding: 5px
    // 8px`, `line-height: 1.4`, `var(--app-radius-lg)` and no shadow or family, beside the desktop's
    // `6px 8px`, `1.5`, `var(--app-radius)`, `var(--app-shadow-card)` and `var(--app-font)`.
    //
    // Each of the first two was fixed by making a declaration in this file agree with one in
    // `PetBubble.vue` — which is why there was a third. The stage now renders `PetBubble` itself, so
    // there is one declaration and nothing to keep in step. That is asserted structurally here
    // because happy-dom has no cascade (what the box *resolves to* is measured in two engines by
    // `e2e/desktop-pet-appearance.spec.ts` and `e2e/webkit/pet-probe.mjs`), and structurally it is a
    // real claim: the element carries the class `PetBubble.vue`'s own stylesheet is scoped to, and
    // the sentence inside it is the bubble's `line`.
    const gateway = createMemoryPetGateway()
    mountOnBubblePage(gateway)
    await flush()
    askForBubble()
    await flush()

    const bubble = document.querySelector<HTMLElement>('.pet-preview__bubble')
    expect(bubble, 'the stage drew a bubble').not.toBeNull()
    // The scoping class, read out of that file rather than spelled: a rename there has to fail here
    // rather than leave this passing on an element nothing styles.
    expect(source('../../desktop-pet/components/PetBubble.vue')).toContain('.pet-bubble {')
    expect(bubble?.classList.contains('pet-bubble')).toBe(true)
    expect(bubble?.querySelector('.pet-bubble__line')?.textContent?.trim()).toBe(
      t('settings.pet.preview.bubbleText'),
    )
  })

  it('declares no box of its own for the bubble', () => {
    // The other half of the case above, and the half a future edit would break: `.pet-preview__bubble`
    // is the hook this component *adds* to the surface `PetBubble` renders (Vue merges a parent's
    // class onto a child component's root), and a class is not a licence to restate the box. Any
    // declaration at all in that rule is a second bubble, so the rule must be empty or absent —
    // comments stripped first, since the one above it names every property it is about.
    const css = source('PetSettingsPreview.vue')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const block = css.match(/\.pet-preview__bubble\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(block.replace(/\s/g, '')).toBe('')
  })

  it('takes the bubble away after the setting’s own life, not a number of its own', async () => {
    const gateway = createMemoryPetGateway()
    await seed(gateway, 'message', { bubbleSeconds: 2 })
    mount(gateway)
    await flush()

    askForBubble()
    await flush(1500)
    expect(document.querySelector('.pet-preview__bubble')).not.toBeNull()

    await flush(1200)
    expect(document.querySelector('.pet-preview__bubble')).toBeNull()
  })
})

describe('the stage says what it cannot show', () => {
  it('names the missing character and reports the size, scaled with the reason given', async () => {
    const gateway = createMemoryPetGateway()
    await seed(gateway, 'character', { size: 320 })
    mount(gateway)
    await flush()

    // 320px of figure in a 176px column: drawn to fit, and the caption is the real number.
    expect(figure().style.width).toBe('132px')
    expect(previewNotes().some((note) => note.includes('320 px'))).toBe(true)
    expect(previewNotes().some((note) => note.includes('41%'))).toBe(true)
    expect(previewNotes().some((note) => note.includes(t('settings.pet.preview.noCharacter')))).toBe(true)
  })

  it('draws no pet at all while both of the pet’s windows are off', async () => {
    const gateway = createMemoryPetGateway()
    // Seeded through the pair rather than through `enabled`: the master is derived from the two
    // switches, so `enabled` alone is not a state the store can hold — a record saying `false`
    // while a window's switch is on is a record this build re-derives as *on*.
    await seed(gateway, 'general', { enabled: false, ball: false, characterWindow: false })
    mount(gateway)
    await flush()

    expect(document.querySelector('.pet-preview__figure')).toBeNull()
    expect(document.querySelector('.pet-preview__notice')?.textContent)
      .toContain(t('settings.pet.preview.off'))
  })
})

describe('reduced motion is never turned back on', () => {
  it('holds still when the system asked, even with the setting on “follow the system”', async () => {
    systemReducedMotion = true
    const gateway = createMemoryPetGateway()
    mount(gateway)
    await flush()

    expect(figure().dataset.reduced).toBe('true')
    expect(previewNotes().some((note) => note.includes(t('settings.pet.preview.reduced')))).toBe(true)
    // §5.3 keeps the *stored* value alone: the pet is more conservative, it does not rewrite
    // what the user chose, so the same preference still means "follow the system" elsewhere.
    expect((await storedValues(gateway, 'general')).motion).toBe('system')
  })

  it('holds still when the setting says so, with the system asking for nothing in particular', async () => {
    const gateway = createMemoryPetGateway()
    await seed(gateway, 'general', { motion: 'reduced' })
    mount(gateway)
    await flush()

    expect(figure().dataset.reduced).toBe('true')
  })

  it('animates only when neither the system nor the setting asked it to stop', async () => {
    mount(createMemoryPetGateway())
    await flush()

    expect(figure().dataset.reduced).toBe('false')
  })
})

describe('the bubble’s theme', () => {
  it('is the app’s palette by default and the bubble’s own override where one was set', async () => {
    const host = createMemoryPetGateway()
    mount(host)
    await flush()
    askForBubble()
    await flush()
    // §5.2's default is `system`, which follows the *app* — and this runner's engine states no
    // preference while the app's own theme is `system` too, so the stage names the light palette.
    // The name and not the absence of the attribute: an element inside another page's root has to
    // say which palette it is drawing (`palettes.css` answers `[data-theme="light"]`, which is what
    // the light half's second selector is for).
    expect(stage()?.getAttribute('data-theme')).toBe('light')
    expect(stage()?.getAttribute('data-color-scheme')).toBe('default')
    expect(stage()?.getAttribute('data-accent')).toBe('ink')
    expect(stage()?.getAttribute('data-contrast')).toBe('normal')

    document.body.innerHTML = ''
    mounted.forEach((app) => app.unmount())
    mounted = []

    const overridden = createMemoryPetGateway()
    await seed(overridden, 'message', { theme: 'dark' })
    mount(overridden)
    await flush()
    askForBubble()
    await flush()
    expect(stage()?.getAttribute('data-theme')).toBe('dark')
  })

  it('owns no colour of its own, which is the whole of what was wrong with it', () => {
    // The preview used to answer Light and Dark with `#f7f7f5` / `#23211f` — two colours this
    // application draws nowhere: the app's own `--app-elevated` is `#fffefb` in light and `#24241f`
    // in dark. A user sets a bubble colour by looking at this stage, so a table of its own is a
    // preview that lies about the one thing it exists for. The four axes go on the stage and every
    // colour comes from `palettes.css`; this is that stated as a fact about the file, because a
    // later edit adding one hex back would pass every other case in this suite.
    const source = readFileSync(resolve(__dirname, 'PetSettingsPreview.vue'), 'utf8')
      // Comments are stripped first: prose about a colour declares nothing, and the comment that
      // explains this rule names the two literals it is about.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })
})
