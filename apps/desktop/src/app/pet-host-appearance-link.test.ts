/**
 * The app publishing what it is drawing, without a pet window and without a shell.
 *
 * The three things that can be wrong are the three the module's header names: a value published
 * from the raw settings rather than from the resolved ones (so the pet follows an accent the user
 * cannot see), a publish that waits for a change (so a pet opened before the first touch draws the
 * defaults for ever), and an axis left behind by a partial republish. The platform adapter is
 * mocked rather than the Tauri API: `publishPetHostAppearance` has its own shape to keep, and this
 * file is about what the shell publishes and when.
 *
 * The store is the real one over `localStorage`, for the reason `pet-task-link.test.ts` gives: the
 * claim is "the pet is told what this window draws", and a hand-built stub of the store would
 * assert a rule this file wrote instead of the rule the store keeps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useAppearanceStore } from '../stores/appearance'
import { attachPetHostAppearanceLink } from './pet-host-appearance-link'
import type { PetHostAppearanceWrite } from '../platform/pet-host-appearance'

const platform = vi.hoisted(() => ({ publishPetHostAppearance: vi.fn() }))
vi.mock('../platform/pet-host-appearance', () => ({
  publishPetHostAppearance: platform.publishPetHostAppearance,
}))

let mounted: VueApp[] = []
let pinia: Pinia

/** happy-dom has no `matchMedia`, and the store reads it for a `system` theme. */
const matchMediaMock = vi.fn(() => ({
  matches: false,
  media: '(prefers-color-scheme: dark)',
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
}))

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  localStorage.clear()
  globalThis.matchMedia = matchMediaMock as never
  mounted = []
  platform.publishPetHostAppearance.mockReset()
  platform.publishPetHostAppearance.mockResolvedValue(undefined)
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
})

/** The shell's own getters, over the real store — the last publish is what a pet would have read. */
function mountShell(): { app: VueApp; published: () => PetHostAppearanceWrite } {
  const appearance = useAppearanceStore()
  const Host = defineComponent({
    setup() {
      attachPetHostAppearanceLink({
        appearance: () => ({
          // The setting, as the shell publishes it: each page resolves `system` against its own
          // engine, and the accent is the resolved one because only this window can read the OS.
          theme: appearance.theme,
          colorScheme: appearance.colorScheme,
          accent: appearance.effectiveAccent(),
          highContrast: appearance.highContrast,
          bodyFontSize: appearance.bodyFontSize,
        }),
      })
      return () => h('div')
    },
  })
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(Host)
  app.mount(host)
  mounted.push(app)
  return {
    app,
    published: () =>
      platform.publishPetHostAppearance.mock.calls.at(-1)?.[0] as PetHostAppearanceWrite,
  }
}

describe('the appearance this window publishes for the pet', () => {
  it('is the resolved appearance, not the settings behind it', async () => {
    const appearance = useAppearanceStore()
    appearance.setAccent('teal')
    appearance.setFollowSystemAccent(true)
    await nextTick()

    const shell = mountShell()
    // With "follow the system accent" on and no colour readable on this machine, the shell's own
    // root is drawn with the theme's fallback hue — `coral` — and that is what the pet is told.
    // Publishing the stored `accent` would have the pet drawing `teal`, a hue this window is not
    // showing; the store keeps the user's pick precisely so it can be returned to.
    expect(shell.published().accent).toBe('coral')
    expect(appearance.accent).toBe('teal')
  })

  it('publishes once on mount, with nothing changed yet', async () => {
    // The case the whole channel exists for on a fresh start: the pet is switched on, its window
    // opens, and it must draw the app's palette rather than the defaults. A link that only
    // published on change would tell it nothing until the user touched an appearance control.
    const shell = mountShell()
    await nextTick()

    expect(platform.publishPetHostAppearance).toHaveBeenCalledTimes(1)
    expect(shell.published()).toEqual({
      // `system`, the schema's default: this window draws light because the engine says so, and so
      // will the pet — from the same engine rather than from a value pinned by this window.
      theme: 'system',
      colorScheme: 'default',
      accent: 'ink',
      highContrast: false,
      bodyFontSize: 15,
    })
  })

  it('republishes the whole appearance when any one axis moves', async () => {
    const appearance = useAppearanceStore()
    const shell = mountShell()
    await nextTick()

    appearance.setAccent('teal')
    await nextTick()
    expect(shell.published()).toEqual({
      theme: 'system',
      colorScheme: 'default',
      accent: 'teal',
      highContrast: false,
      bodyFontSize: 15,
    })

    // A second axis, and the first is still in the frame: the host replaces the value whole, so a
    // partial publish would put the pet back on an earlier accent.
    appearance.setBodyFontSize(18)
    await nextTick()
    expect(shell.published()).toEqual({
      theme: 'system',
      colorScheme: 'default',
      accent: 'teal',
      highContrast: false,
      bodyFontSize: 18,
    })

    appearance.setHighContrast(true)
    await nextTick()
    expect(shell.published().highContrast).toBe(true)

    appearance.setColorScheme('forest')
    await nextTick()
    expect(shell.published().colorScheme).toBe('forest')

    appearance.setTheme('dark')
    await nextTick()
    expect(shell.published().theme).toBe('dark')
  })

  it('stops publishing once the shell is gone', async () => {
    // The watcher lives on the shell's scope, so an unmounted shell cannot publish the appearance
    // of a window that is closing — the same rule the two links beside this one follow for their
    // listeners.
    const appearance = useAppearanceStore()
    const shell = mountShell()
    await nextTick()
    const count = platform.publishPetHostAppearance.mock.calls.length

    shell.app.unmount()
    appearance.setAccent('rose')
    await nextTick()

    expect(platform.publishPetHostAppearance.mock.calls.length).toBe(count)
  })

  it('publishes again after a change that arrives in the same tick as the mount', async () => {
    // A store write during the mount turn is a real one (the OS accent read resolves asynchronously
    // and calls back into the store), and it must reach the pet: the watch is established outside
    // `onMounted` for exactly this.
    const appearance = useAppearanceStore()
    const shell = mountShell()
    appearance.setAccent('cyan')
    await nextTick()
    await nextTick()

    expect(shell.published().accent).toBe('cyan')
  })
})

describe('what the platform adapter does with a refusal', () => {
  it('is not an error the window draws', async () => {
    // Asserted here rather than in the platform module's own suite because the claim is about this
    // window: a host that cannot store the value leaves the pet's windows on the app's defaults,
    // and an appearance change is far too frequent to put a sentence on screen for.
    const { publishPetHostAppearance } = await vi.importActual<
      typeof import('../platform/pet-host-appearance')
    >('../platform/pet-host-appearance')
    await expect(
      publishPetHostAppearance({
        theme: 'dark',
        colorScheme: 'default',
        accent: 'ink',
        highContrast: false,
        bodyFontSize: 15,
      }),
    ).resolves.toBeUndefined()
  })
})
