/**
 * The pet's settings, in the dialog a user can actually open.
 *
 * Everything behind this section was built and tested first and reachable by nobody: the pages
 * were mounted by their own suites, the container by its own, and the dialog had no row that led
 * to any of them. So this file is about the *seam* rather than about the pages — the rail row,
 * the one element that mounts the section, the connection it is handed, and where a request from
 * the pet window lands.
 *
 * Three claims, and the third is the one that would otherwise be a paragraph:
 *
 *  - **Reachable.** The row exists, clicking it mounts the section, and the section reads the
 *    settings the host has.
 *  - **Functional, and only as far as the backend goes.** The master switch is not decoration:
 *    flipping it writes `general.enabled` through the real adapter, which is the command the Rust
 *    side turns into the pet's window (§5.1's 启用). The other half is an absence —
 *    `desktop_pet_tasks` has no backend, so nothing on this page may call it, and this suite
 *    drives the mounted section across every page and asserts the call is never made. A control
 *    that fails at the backend is the worst version of a gap the rest of this codebase states in
 *    words.
 *  - **What it costs the main window.** §7.1's isolation clause is asserted in one direction by
 *    `app/desktop-pet-entry.test.ts` (the pet window carries no application). Mounting this
 *    section is the other direction, and nothing was watching it: the care page takes
 *    `PetCarePanel` from the feature's public entry, and a barrel is one module — so the pet
 *    *window's* own surface (its root, its sprite, the rendering pipeline) joins the main
 *    window's source graph. The last suite walks that graph and writes down what joined it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp, type Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import SettingsPanel from './SettingsPanel.vue'
import {
  PET_SETTINGS_DEFAULTS,
  PET_SETTINGS_SCHEMA_VERSION,
  PET_SETTINGS_SECTION,
  type PetSettingsDomain,
} from '../../../platform/gateways/pet-contracts'
import type { SettingsOpenTarget } from '../types'
import { setLocale, t } from '../../../i18n'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const listenMock = vi.hoisted(() => vi.fn(async (): Promise<() => void> => () => {}))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

const getVersionMock = vi.hoisted(() => vi.fn(async () => '9.9.9'))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: getVersionMock }))

let mounted: VueApp[] = []

/**
 * The host, as this suite stands it up.
 *
 * It answers the three commands the settings half is served by and *nothing* answers
 * `desktop_pet_tasks` — which is the point: this is the same absence the real build has, where
 * the command is not in `lib.rs`'s handler list and Tauri refuses it by name.
 *
 * `stored` is what the store already holds, per domain. It is empty by default — the schema's own
 * defaults are what an untouched store answers — and one test sets it, because the master switch's
 * interesting transition is the one the host acts on: `general.enabled` off, then on.
 */
let stored: Partial<Record<PetSettingsDomain, Record<string, unknown>>> = {}

function answerHost(command: string, args?: unknown): unknown {
  switch (command) {
    case 'desktop_pet_capabilities':
      return []
    case 'desktop_pet_care_read':
      return { status: 'empty' }
    case 'desktop_pet_read_settings': {
      const domain = (args as { domain: PetSettingsDomain }).domain
      return {
        status: 'defaults',
        reason: 'absent',
        record: {
          domain,
          schemaVersion: PET_SETTINGS_SCHEMA_VERSION,
          revision: 0,
          values: { ...PET_SETTINGS_DEFAULTS[domain], ...(stored[domain] ?? {}) },
        },
      }
    }
    case 'desktop_pet_update_settings': {
      const write = (
        args as { write: { domain: PetSettingsDomain; revision: number; values: unknown } }
      ).write
      return {
        status: 'applied',
        record: { ...write, schemaVersion: PET_SETTINGS_SCHEMA_VERSION },
      }
    }
    default:
      // Every other command belongs to the app this dialog lives in and is not this file's
      // subject; an unanswered one is a shape the sections already handle.
      return undefined
  }
}

/** Whether the window this panel is in has a host. Without it the composition answers `null`. */
function setHost(present: boolean): void {
  const scope = window as { __TAURI_INTERNALS__?: unknown }
  if (present) scope.__TAURI_INTERNALS__ = {}
  else delete scope.__TAURI_INTERNALS__
}

/** The pet commands the host was asked for, in order. */
function petCommands(): string[] {
  return invokeMock.mock.calls
    .map(([command]) => String(command))
    .filter((command) => command.startsWith('desktop_pet'))
}

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (command: string, args?: unknown) => answerHost(command, args))
  stored = {}
  listenMock.mockClear()
  getVersionMock.mockClear()
  localStorage.clear()
  setLocale('en')
  setActivePinia(createPinia())
  setHost(false)
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
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

/** A frame of the dialog's life rather than a tick: the section swap is a cross-fade, and a
 *  settings write is debounced by `PET_SETTINGS_DEBOUNCE_MS`, so both need the clock to move. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return
    await vi.advanceTimersByTimeAsync(20)
    await nextTick()
  }
  throw new Error(`the dialog never reached: ${label}`)
}

/**
 * Mount the real dialog, optionally with a target that changes while it is open.
 *
 * The wrapper reads the ref inside a render function, which is what makes a target assigned after
 * the mount reach the panel as a prop update rather than as a value read once.
 */
function mountPanel(target?: Ref<SettingsOpenTarget | null>): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(() =>
    h(SettingsPanel, {
      target: target ? target.value : null,
      onClose: vi.fn(),
      onSaved: vi.fn(),
    }),
  )
  app.mount(host)
  mounted.push(app)
}

/** The section's own rail row, found by the label the navigation renders. */
function petRow(): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>('.nav-row')].find((candidate) =>
    candidate.textContent?.includes('Desktop Pet'),
  )
  if (!row) throw new Error('the pet row is not in the settings navigation')
  return row
}

function activePetPage(): string | null {
  const tab = document.querySelector('.pet-settings__tab[aria-selected="true"]')
  return tab?.getAttribute('data-page') ?? null
}

function masterSwitch(): HTMLInputElement {
  const label = [...document.querySelectorAll<HTMLElement>('.pet-settings label')].find((candidate) =>
    candidate.textContent?.includes('Show the desktop pet'),
  )
  const input = label?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!input) throw new Error('the master switch is not on the general page')
  return input
}

describe('the pet’s settings are reachable from the dialog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setHost(true)
  })
  afterEach(() => vi.useRealTimers())

  it('opens the section from a row in the rail', async () => {
    mountPanel()
    await nextTick()

    expect(petRow().textContent).toContain('Desktop Pet')
    expect(document.querySelector('.pet-settings')).toBeNull()

    petRow().click()
    await until(() => document.querySelector('.pet-settings') !== null, 'the pet section')
    // The container's own sub-rail is what proves the *container* mounted rather than a fragment:
    // it is the one element only `DesktopPetSettings.vue` draws, and it is filled by the five
    // slot pages this section composes.
    expect(document.querySelector('.pet-settings__rail')).not.toBeNull()
    expect(activePetPage()).toBe('general')
  })

  it('reads the settings the host has, through the real adapter', async () => {
    mountPanel()
    await nextTick()
    petRow().click()
    await until(() => petCommands().includes('desktop_pet_read_settings'), 'the settings read')

    // §10.1's assembly point decided the connection: these are the adapter's own command names,
    // so a section mounted against a double — the failure `desktop-pet-composition.ts` exists to
    // prevent — could not produce them.
    expect(petCommands()).toContain('desktop_pet_capabilities')
    // The four preview domains are read before any page is opened, which is the container's
    // documented read policy rather than this file's claim.
    expect(petCommands().filter((c) => c === 'desktop_pet_read_settings')).toHaveLength(4)
  })

  it('states a capability report that never arrived instead of crashing on the answer', async () => {
    // The browser build answers every command its stub does not know with `undefined`, and the e2e
    // stub has no case for `desktop_pet_capabilities` — which is how this was found: a fixed
    // `console-clean` walk reached the pet section and the page threw while rendering. A report
    // this build did not receive is *not* a capability reported missing (§7.2, and
    // `unavailability`'s own comment), so the page must render and say the first thing rather than
    // treat the host's silence as a finding.
    invokeMock.mockImplementation(async (command: string, args?: unknown) =>
      command === 'desktop_pet_capabilities' ? undefined : answerHost(command, args),
    )
    mountPanel()
    await nextTick()
    petRow().click()
    await until(() => document.querySelector('.pet-settings') !== null, 'the pet section')
    await vi.advanceTimersByTimeAsync(50)
    await nextTick()

    // The page rendered at all, which is the half that used to throw.
    const roam = [...document.querySelectorAll<HTMLElement>('.pet-settings label')].find((label) =>
      label.textContent?.includes('Roaming'),
    )
    expect(roam, 'the roaming control is on the general page').not.toBeUndefined()

    // And it said the *right* thing: the "nobody has looked" sentence, never the "reported
    // unavailable" one — a host that said nothing has no finding and no detail to give, and
    // presenting one as the other is what §7.2 forbids. The stem is read off the catalogue rather
    // than written here, so this assertion cannot drift from the wording it is about.
    const body = document.querySelector('.pet-settings')?.textContent ?? ''
    expect(body).toContain(t('settings.pet.capabilityUnknown'))
    expect(body).not.toContain(t('settings.pet.unavailable', { detail: 'X' }).split('X')[0])
  })

  it('asks this host for four things and never for the one with no backend', async () => {
    mountPanel()
    await nextTick()
    petRow().click()
    await until(() => petCommands().includes('desktop_pet_capabilities'), 'the container')

    // Every page, including the ones a click mounts: whatever any of them draws must live inside
    // this list. `desktop_pet_tasks` is deliberately not in it — `task_projection.rs` has no
    // managed state and `lib.rs` says so — so a page that called it would put Tauri's own
    // "command not found" in a user's face, which is the failing version of a gap this codebase
    // states in words everywhere else.
    for (const tab of document.querySelectorAll<HTMLElement>('.pet-settings__tab')) {
      tab.click()
      await vi.advanceTimersByTimeAsync(50)
      await nextTick()
    }
    await vi.advanceTimersByTimeAsync(1000)

    const allowed = new Set([
      'desktop_pet_capabilities',
      'desktop_pet_care_read',
      'desktop_pet_read_settings',
      'desktop_pet_update_settings',
      // The character page's picker, which reads what the library holds so there is something to
      // choose between. It is a *read*: installing a character is the import button's call
      // (`desktop_pet_import_character`), and it is not made until the user clicks it.
      'desktop_pet_library',
      // §8's online catalogue, read when the character page opens — the same shape as the picker
      // above, and read for the same reason: there has to be something to browse before there is
      // something to click.
      'desktop_pet_catalogue',
      // And the click. Not observed by this case, which mounts pages and does not press their
      // buttons; it is here so that the day one of them does, the command it reaches for is one
      // this list already says is allowed to exist rather than a surprise this case reports.
      'desktop_pet_adopt_character',
    ])
    expect([...new Set(petCommands())].filter((command) => !allowed.has(command))).toEqual([])
  })

  it('writes the master switch through the command that opens the pet’s window', async () => {
    // A user who switched the pet off: the switch renders what the store holds rather than the
    // schema's default, and the transition below is the one `apply_feature_switch` acts on.
    stored = { general: { enabled: false } }
    mountPanel()
    await nextTick()
    petRow().click()
    await until(() => document.querySelector('.pet-settings__rail') !== null, 'the section')

    const toggle = masterSwitch()
    expect(toggle.checked).toBe(false)
    toggle.checked = true
    toggle.dispatchEvent(new Event('change'))

    await until(
      () => petCommands().includes('desktop_pet_update_settings'),
      'the switch to be written',
    )
    const write = invokeMock.mock.calls.find(
      ([command]) => command === 'desktop_pet_update_settings',
    )
    // The whole write, not a field of it: `general.enabled` is the value the Rust side reads to
    // open the pet's window, and a page that wrote it into another domain would save a setting
    // nothing acts on.
    expect((write?.[1] as { write: unknown }).write).toMatchObject({
      domain: 'general',
      values: { enabled: true },
    })
  })

  it('states the absence rather than drawing controls where there is no host', async () => {
    setHost(false)
    mountPanel()
    await nextTick()
    petRow().click()
    await until(() => document.querySelector('.pet-settings') !== null, 'the pet section')

    // A browser build, and a test runner: the composition answers `null` rather than handing over
    // D1's double, so the section says so — and asks no backend for anything.
    expect(document.querySelector('.pet-settings__rail')).toBeNull()
    expect(document.querySelector('.pet-settings')?.textContent).toContain('no connection')
    expect(petCommands()).toEqual([])
  })
})

describe('the pet window’s 设置 lands where it asked', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // A host, because the page the request names is only visible in the container's own rail —
    // an unwired section states the absence instead, and has no sub-page to read.
    setHost(true)
  })
  afterEach(() => vi.useRealTimers())

  it('opens the dialog on the section and page the caller named', async () => {
    const target = ref<SettingsOpenTarget | null>({ section: PET_SETTINGS_SECTION, page: 'care' })
    mountPanel(target)
    await until(() => document.querySelector('.pet-settings') !== null, 'the pet section')

    expect(activePetPage()).toBe('care')
  })

  it('moves a dialog that is already open, rather than being read once and forgotten', async () => {
    const target = ref<SettingsOpenTarget | null>(null)
    mountPanel(target)
    await nextTick()
    // Opened by the gear: `general`, as it has always been.
    expect(document.querySelector('.pet-settings')).toBeNull()
    expect(document.querySelector('.settings-section')).not.toBeNull()

    // §5.1's right-click arrives while the dialog is up. Nothing was read in `setup`, so the
    // second request is answered the same way as the first.
    target.value = { section: PET_SETTINGS_SECTION, page: 'character' }
    await until(() => document.querySelector('.pet-settings') !== null, 'the pet section')
    expect(activePetPage()).toBe('character')
  })
})

/**
 * The three files that name the section, checked against the one spelling of it.
 *
 * D1's comment says the constant exists so the pet never spells it out itself, and a literal here
 * is the failure it warns about: a rail row that opens nothing, because the panel's `v-else-if`
 * compares a string nobody else uses. Read as text, because that is what the mistake is.
 */
describe('the section is named once', () => {
  it('uses the pet’s constant and never the literal', () => {
    for (const file of ['../types.ts', './SettingsNavigation.vue', './SettingsPanel.vue']) {
      const source = readFileSync(resolve(__dirname, file), 'utf8')
      expect(source, `${file} spells the section id out`).not.toMatch(/['"]desktop-pet['"]/)
      expect(source, `${file} does not use the pet’s constant`).toMatch(/PET_SETTINGS_SECTION/)
    }
    expect(PET_SETTINGS_SECTION).toBe('desktop-pet')
  })
})

// ---- What mounting the section costs the main window ----------------------
//
// §7.1's isolation clause is a claim about an *import graph*, and it is asserted for the pet
// window by `app/desktop-pet-entry.test.ts`. The direction that test does not cover is this one:
// the dialog is in the main window, and the moment it mounts the pet's section it carries
// whatever that section reaches. The walk below is that test's technique on purpose — the two
// lists together are the whole edge.

const SRC = resolve(__dirname, '..', '..', '..')
const PANEL = resolve(__dirname, 'SettingsPanel.vue')

/** Comments are stripped before the specifier scan: prose about a module is not an import of it. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Every script block of a `.vue` file: five of the pet's pages carry two. */
function scriptOf(file: string, raw: string): string {
  if (!file.endsWith('.vue')) return raw
  const blocks = [...raw.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1])
  if (blocks.length === 0) throw new Error(`${file} has no <script> block`)
  return blocks.join('\n')
}

const SPECIFIER =
  /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm

/** The specifiers left after compilation: `import type` names nothing that reaches a window. */
function specifiersOf(file: string): string[] {
  const code = stripComments(scriptOf(file, readFileSync(file, 'utf8'))).replace(
    /\b(?:import|export)\s+type\s[\s\S]*?\bfrom\s*['"][^'"]+['"]/g,
    '',
  )
  const found = new Set<string>()
  for (const match of code.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? match[2] ?? match[3]
    if (specifier) found.add(specifier)
  }
  return [...found]
}

function resolveRelative(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.vue`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  throw new Error(`${relative(SRC, from)} imports ${specifier}, which resolves to nothing`)
}

function reachableFrom(entry: string): string[] {
  const seen = new Set<string>([entry])
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift() as string
    for (const specifier of specifiersOf(file)) {
      const target = resolveRelative(file, specifier)
      if (target && !seen.has(target)) {
        seen.add(target)
        queue.push(target)
      }
    }
  }
  seen.delete(entry)
  return [...seen].map((file) => relative(SRC, file).split(sep).join('/')).sort()
}

describe('the dialog carries the pet’s pages, and what comes with them', () => {
  it('reaches the pet’s settings pages and the pet window’s own surface', () => {
    const reachable = reachableFrom(PANEL)
    const settings = reachable.filter((file) => file.startsWith('features/desktop-pet-settings/'))
    const surface = reachable.filter(
      (file) =>
        file.startsWith('features/desktop-pet/') &&
        !file.startsWith('features/desktop-pet-settings/'),
    )

    // The section and its pages: the mount point's own subject, and the reason this file exists.
    expect(settings).toEqual([
      'features/desktop-pet-settings/components/DesktopPetSettings.vue',
      'features/desktop-pet-settings/components/DesktopPetSettingsSection.vue',
      'features/desktop-pet-settings/components/PetBubbleSettings.vue',
      'features/desktop-pet-settings/components/PetCareSettings.vue',
      // §8's catalogue browser, which the character page renders. Its own component, so that
      // the page that picks a character and the document written by strangers are not one file.
      'features/desktop-pet-settings/components/PetCatalogueBrowser.vue',
      'features/desktop-pet-settings/components/PetCharacterSettings.vue',
      'features/desktop-pet-settings/components/PetGeneralSettings.vue',
      'features/desktop-pet-settings/components/PetIntegrationSettings.vue',
      'features/desktop-pet-settings/components/PetNotificationSettings.vue',
      'features/desktop-pet-settings/components/PetProjectSettings.vue',
      'features/desktop-pet-settings/components/PetSettingsPreview.vue',
      'features/desktop-pet-settings/components/pet-care-labels.ts',
      'features/desktop-pet-settings/composables/use-pet-settings.ts',
      'features/desktop-pet-settings/index.ts',
      'features/desktop-pet-settings/services/pet-capability-report.ts',
      'features/desktop-pet-settings/services/pet-settings-policy.ts',
      'features/desktop-pet-settings/services/pet-settings-values.ts',
    ])

    // And then the part that is a cost rather than a feature. `PetCareSettings.vue` takes
    // `PetCarePanel` from `features/desktop-pet/index.ts` — §13.11 sends it through the public
    // entry, and the entry's own doc says why — but a barrel is one module: every `export … from`
    // in it is linked, so the pet *window's* root, sprite, rendering pipeline and lifecycle come
    // with it. None of them is mounted in this window, and nothing was measuring that until this
    // list. The fix, if it is ever wanted, is in `features/desktop-pet/index.ts` (a care-only
    // entry, or a deep import with its reason written at the import) rather than here.
    //
    // **Ten more modules joined it when the window's own wiring landed**, and they are three
    // different costs worth telling apart:
    //   - `services/pet-library-policy.ts` and `services/pet-catalogue.ts` are the *character
    //     page's* — the picker reads the library through `readPetLibrary`, which this entry
    //     re-exports for it. That is the barrel doing its job, and the two modules are a policy
    //     and a catalogue constant.
    //   - the rest came with `DesktopPetRoot.vue`, which the entry re-exports and this window
    //     links: the root now draws the task surface (`PetBubble.vue`, `PetTaskList.vue`,
    //     `PetTaskRow.vue`, `PetContextMenu.vue`), reads its appearance (`pet-appearance.ts`,
    //     `use-pet-window.ts`) and derives its mood (`pet-task-view.ts`, `pet-bubble-layout.ts`).
    //     None of it is mounted here — the settings window has no character — so this is the
    //     pre-existing barrel cost, grown. If it ever matters, the seam is the same one named
    //     above: nothing in this window needs `DesktopPetRoot`, and the export that carries it is
    //     what makes the extra modules reachable.
    //
    //   - `composables/use-pet-click-through.ts` is the same cost again, one module over: it is the
    //     pet window's input-region rule (§7.2's 鼠标穿透), it is reached through that same
    //     `DesktopPetRoot` export, and this window neither mounts it nor needs it.
    //
    //   - `services/pet-ball-platform.ts` is the newest of them and the *thinnest*: the ball
    //     window's drag adapter, carried because the composition imports it for that window's
    //     resolver. It holds one call and reaches `platform/window.ts`, which is in this window's
    //     graph already.
    expect(surface).toEqual([
      'features/desktop-pet/components/DesktopPetRoot.vue',
      'features/desktop-pet/components/PetBubble.vue',
      'features/desktop-pet/components/PetCarePanel.vue',
      'features/desktop-pet/components/PetContextMenu.vue',
      'features/desktop-pet/components/PetSprite.vue',
      'features/desktop-pet/components/PetTaskList.vue',
      'features/desktop-pet/components/PetTaskRow.vue',
      'features/desktop-pet/composables/use-pet-click-through.ts',
      'features/desktop-pet/composables/use-pet-drawing-failure.ts',
      'features/desktop-pet/composables/use-pet-lifecycle.ts',
      'features/desktop-pet/composables/use-pet-window.ts',
      'features/desktop-pet/index.ts',
      'features/desktop-pet/rendering/animation-bindings.ts',
      'features/desktop-pet/rendering/sprite-hit-test.ts',
      'features/desktop-pet/rendering/sprite-player.ts',
      'features/desktop-pet/rendering/sprite-sheet.ts',
      'features/desktop-pet/rendering/sprite-slicer.ts',
      'features/desktop-pet/services/pet-appearance.ts',
      'features/desktop-pet/services/pet-ball-platform.ts',
      'features/desktop-pet/services/pet-bubble-layout.ts',
      'features/desktop-pet/services/pet-care-rules.ts',
      'features/desktop-pet/services/pet-catalogue.ts',
      'features/desktop-pet/services/pet-context-menu.ts',
      'features/desktop-pet/services/pet-library-policy.ts',
      'features/desktop-pet/services/pet-menu-actions.ts',
      'features/desktop-pet/services/pet-message-template.ts',
      'features/desktop-pet/services/pet-task-view.ts',
    ])
  })

  it('never carries the pet’s test double', () => {
    // The same rule `desktop-pet-entry.test.ts` holds the pet's window to: `memory-pet.ts` is a
    // fixture, and a settings page mounted against it would look exactly like a working one.
    const reachable = reachableFrom(PANEL)
    expect(reachable.filter((file) => file.includes('memory-pet'))).toEqual([])
  })
})
