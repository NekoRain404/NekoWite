/**
 * The window's page being told which appearance to draw in, and being kept told.
 *
 * The clauses are the ones the composable's header states, and three of them are the same three the
 * theme composable this one replaced carried: the attributes land on the page's *root* (which is
 * what makes a palette switchable at all — `:root` and the attribute selectors all match it), a
 * `system` theme keeps being read for as long as it can still move the page, and the page is given
 * back as it was found when the window goes away.
 *
 * What is new is the *set* of things that land there, and it is the whole of §1's 「跟随宿主主题与
 * 强调色」: the app's colour scheme, its accent and its contrast go with the theme, and so does the
 * body size the user set — because a pet window that followed only the theme would be drawing the
 * app's palette with somebody else's accent, at a size nobody chose.
 *
 * The engine is a double here for the reason §10.2 gives for every injected resource: a test cannot
 * make a real engine report a dark preference, and the rule about what the *setting* means has to
 * be measured apart from what the *engine says*. The double carries the two things a
 * `MediaQueryList` is read for — `matches`, and a change to re-read it on — and nothing else.
 */
import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import type { PetBubbleTheme } from '../services/pet-bubble-theme'
import {
  PET_PAGE_APPEARANCE_DEFAULTS,
  petHostAppearanceOf,
  type PetPageAppearance,
} from '../services/pet-page-appearance'
import { usePetPageAppearance, type PetPageAppearanceOptions } from './use-pet-page-appearance'

/** A `MediaQueryList` with the two members this composable reads, and a way to move the engine. */
function engine(startDark: boolean) {
  const listeners = new Set<() => void>()
  const query = {
    matches: startDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, handler: () => void) => listeners.add(handler),
    removeEventListener: (_type: string, handler: () => void) => listeners.delete(handler),
  }
  return {
    view: { matchMedia: () => query },
    /** The user flipped their desktop theme. */
    flip(dark: boolean) {
      query.matches = dark
      for (const handler of [...listeners]) handler()
    },
    listening: () => listeners.size,
  }
}

/** The composable as a component uses it: inside a scope it can be disposed with. */
function scoped(options: PetPageAppearanceOptions) {
  const scope = effectScope()
  const subject = scope.run(() => usePetPageAppearance(options))
  if (!subject) throw new Error('the composable did not run inside its scope')
  return { subject, stop: () => scope.stop() }
}

/** A page of its own, so the runner's document is never the thing under test. */
function page(): HTMLElement {
  const element = document.createElement('div')
  document.body.append(element)
  return element
}

/** The app's appearance as the host would have published it, with the defaults for the rest. */
function app(published: Parameters<typeof petHostAppearanceOf>[0] = {}): PetPageAppearance {
  return petHostAppearanceOf(published)
}

describe('usePetPageAppearance', () => {
  it('puts the app’s whole appearance on the page’s root, which is what the shell puts on its own', async () => {
    // The four attributes and the property are the *same* four and the same one `AppShell.vue` writes
    // (`:207-210`, `:195`) — including `data-theme="light"`, which the theme composable used to spell
    // as the absence of the attribute. Light is a name now, for the reason the light block has two
    // selectors: the pagess drawing the same table have to say the same things, or a selector that
    // reads the attribute as a value (the light high-contrast block) matches in one and not the
    // other.
    const root = page()
    const theme = ref<PetBubbleTheme>('light')
    const appearance = ref(app({ colorScheme: 'forest', accent: 'teal', bodyFontSize: 16 }))
    const { subject, stop } = scoped({
      theme: () => theme.value,
      host: () => appearance.value,
      root: () => root,
      view: null,
    })

    expect(root.dataset.theme).toBe('light')
    expect(root.dataset.colorScheme).toBe('forest')
    expect(root.dataset.accent).toBe('teal')
    expect(root.dataset.contrast).toBe('normal')
    expect(root.style.getPropertyValue('--app-body-size')).toBe('16px')
    expect(subject.resolved.value).toBe('light')

    theme.value = 'dark'
    await nextTick()
    expect(root.dataset.theme).toBe('dark')
    // The app's other three axes do not move with it: the bubble's setting chooses a palette, and
    // everything else on that palette stays the app's.
    expect(root.dataset.colorScheme).toBe('forest')
    expect(root.dataset.accent).toBe('teal')
    stop()
  })

  it('follows the app when the scheme, the accent or the size changes while the window is open', async () => {
    // The user is looking at the pet while they change something in Settings. Without this the
    // window would keep the appearance it mounted with until it was reopened — the same "lagging by
    // one write" the settings-change channel exists to prevent.
    const root = page()
    const appearance = ref(app())
    const { stop } = scoped({
      theme: () => 'system',
      host: () => appearance.value,
      root: () => root,
      view: engine(false).view,
    })

    appearance.value = app({ accent: 'coral', highContrast: true, bodyFontSize: 13 })
    await nextTick()
    expect(root.dataset.accent).toBe('coral')
    expect(root.dataset.contrast).toBe('high')
    expect(root.style.getPropertyValue('--app-body-size')).toBe('13px')
    stop()
  })

  it('resolves “system” from the engine while the app is following it too, and keeps hearing it', async () => {
    const root = page()
    const engineHost = engine(true)
    const { subject, stop } = scoped({
      theme: () => 'system',
      host: () => app({ theme: 'system' }),
      root: () => root,
      view: engineHost.view,
    })

    expect(root.dataset.theme).toBe('dark')
    expect(subject.resolved.value).toBe('dark')

    // The desktop theme flipped: a window that stopped hearing this would be the one surface on the
    // machine still drawn in the old palette.
    engineHost.flip(false)
    await nextTick()
    expect(root.dataset.theme).toBe('light')
    expect(subject.resolved.value).toBe('light')
    stop()
  })

  it('follows the app’s own theme instead of the engine when the app pinned one', async () => {
    // 「默认跟随宿主主题」 is a statement about the *app*, not about the desktop: on an app the user
    // pinned to light, the pet is light on a machine whose engine says dark — and there is nothing
    // for the engine's change to move, so nothing is left listening to it.
    const root = page()
    const engineHost = engine(true)
    const { subject, stop } = scoped({
      theme: () => 'system',
      host: () => app({ theme: 'light' }),
      root: () => root,
      view: engineHost.view,
    })

    expect(root.dataset.theme).toBe('light')
    expect(subject.resolved.value).toBe('light')
    expect(engineHost.listening()).toBe(0)

    engineHost.flip(false)
    await nextTick()
    expect(root.dataset.theme).toBe('light')
    stop()
  })

  it('stops listening the moment the user forces a member, and starts again if they return', async () => {
    // A page that has been told `light` has nothing to hear, and a listener left attached is the
    // leak every composable beside this one exists to prevent.
    const root = page()
    const theme = ref<PetBubbleTheme>('system')
    const engineHost = engine(false)
    const { stop } = scoped({
      theme: () => theme.value,
      host: () => app({ theme: 'system' }),
      root: () => root,
      view: engineHost.view,
    })
    expect(engineHost.listening()).toBe(1)

    theme.value = 'dark'
    await nextTick()
    expect(engineHost.listening()).toBe(0)

    // And a forced member ignores the engine entirely — the flip must not move the page.
    engineHost.flip(false)
    await nextTick()
    expect(root.dataset.theme).toBe('dark')

    theme.value = 'system'
    await nextTick()
    expect(engineHost.listening()).toBe(1)
    expect(root.dataset.theme).toBe('light')
    stop()
  })

  it('gives the page back as it found it when the window goes away', async () => {
    const root = page()
    root.dataset.theme = 'dark'
    root.dataset.accent = 'rose'
    root.style.setProperty('--app-body-size', '13px')

    const engineHost = engine(true)
    const { stop } = scoped({
      theme: () => 'system',
      host: () => app({ accent: 'lime' }),
      root: () => root,
      view: engineHost.view,
    })
    expect(root.dataset.accent).toBe('lime')

    stop()
    expect(root.dataset.theme).toBe('dark')
    expect(root.dataset.accent).toBe('rose')
    expect(root.dataset.colorScheme).toBeUndefined()
    expect(root.dataset.contrast).toBeUndefined()
    expect(root.style.getPropertyValue('--app-body-size')).toBe('13px')
    expect(engineHost.listening()).toBe(0)
  })

  it('does nothing at all where there is no page to draw on', () => {
    // "No root" is a real state — a page that has not been built yet, and a runner with no
    // `document`. The rule is still resolved (it is the *setting*'s answer, not the page's), and
    // nothing throws on the way to a root that is not there.
    const scope = effectScope()
    const subject = scope.run(() =>
      usePetPageAppearance({
        theme: () => 'dark',
        host: () => PET_PAGE_APPEARANCE_DEFAULTS,
        root: () => null,
        view: null,
      }),
    )
    expect(subject?.resolved.value).toBe('dark')
    scope.stop()
  })
})
