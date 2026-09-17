/**
 * The window's page being told which palette to draw in, and being kept told.
 *
 * The three clauses are the ones the composable's header states: the attribute lands on the page's
 * root (which is what makes a theme switchable at all — `:root` and `[data-theme="dark"]` both
 * match it), a `system` theme keeps being read from the engine for as long as it is `system`, and
 * the page is given back as it was found when the window goes away.
 *
 * The engine is a double here for the reason §10.2 gives for every injected resource: a test cannot
 * make a real engine report a dark preference, and the rule about what the *setting* means has to
 * be measured apart from what the *engine says*. The double carries the two things a
 * `MediaQueryList` is read for — `matches`, and a change to re-read it on — and nothing else.
 */
import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import type { PetBubbleTheme } from '../services/pet-bubble-theme'
import { usePetPageTheme, type PetPageThemeOptions } from './use-pet-page-theme'

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
function scoped(options: PetPageThemeOptions) {
  const scope = effectScope()
  const subject = scope.run(() => usePetPageTheme(options))
  if (!subject) throw new Error('the composable did not run inside its scope')
  return { subject, stop: () => scope.stop() }
}

/** A page of its own, so the runner's document is never the thing under test. */
function page(): HTMLElement {
  const element = document.createElement('div')
  document.body.append(element)
  return element
}

describe('usePetPageTheme', () => {
  it('puts the forced members on the page’s root, and takes the attribute off for light', async () => {
    const root = page()
    const theme = ref<PetBubbleTheme>('light')
    const { subject, stop } = scoped({ theme: () => theme.value, root: () => root, view: null })

    expect(root.getAttribute('data-theme')).toBeNull()
    expect(subject.resolved.value).toBe('light')

    theme.value = 'dark'
    await nextTick()
    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(subject.resolved.value).toBe('dark')

    theme.value = 'light'
    await nextTick()
    expect(root.hasAttribute('data-theme')).toBe(false)
    stop()
  })

  it('resolves “system” from the engine, and follows it while it is chosen', async () => {
    const root = page()
    const theme = ref<PetBubbleTheme>('system')
    const host = engine(true)
    const { subject, stop } = scoped({ theme: () => theme.value, root: () => root, view: host.view })

    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(subject.resolved.value).toBe('dark')

    // The desktop theme flipped: a window that stopped hearing this would be the one surface on the
    // machine still drawn in the old palette.
    host.flip(false)
    await nextTick()
    expect(root.hasAttribute('data-theme')).toBe(false)
    expect(subject.resolved.value).toBe('light')
    stop()
  })

  it('stops listening the moment the user forces a member, and starts again if they return', async () => {
    // A page that has been told `light` has nothing to hear, and a listener left attached is the
    // leak every composable beside this one exists to prevent.
    const root = page()
    const theme = ref<PetBubbleTheme>('system')
    const host = engine(false)
    const { stop } = scoped({ theme: () => theme.value, root: () => root, view: host.view })
    expect(host.listening()).toBe(1)

    theme.value = 'dark'
    await nextTick()
    expect(host.listening()).toBe(0)

    // And a forced member ignores the engine entirely — the flip must not move the page.
    host.flip(false)
    await nextTick()
    expect(root.getAttribute('data-theme')).toBe('dark')

    theme.value = 'system'
    await nextTick()
    expect(host.listening()).toBe(1)
    expect(root.hasAttribute('data-theme')).toBe(false)
    stop()
  })

  it('gives the page back as it found it when the window goes away', async () => {
    const root = page()
    const theme = ref<PetBubbleTheme>('system')
    const host = engine(true)
    const { stop } = scoped({ theme: () => theme.value, root: () => root, view: host.view })
    expect(root.getAttribute('data-theme')).toBe('dark')

    stop()
    expect(root.hasAttribute('data-theme')).toBe(false)
    expect(host.listening()).toBe(0)
  })

  it('leaves an attribute that was already there exactly as it was', () => {
    // A page that was already drawn in a theme keeps it: the window is a guest on whatever it was
    // mounted into, which is also why the teardown restores rather than deletes.
    const root = page()
    root.dataset.theme = 'dark'
    const stop = (() => {
      const scope = effectScope()
      scope.run(() => usePetPageTheme({ theme: () => 'light', root: () => root, view: null }))
      return () => scope.stop()
    })()

    expect(root.hasAttribute('data-theme')).toBe(false)
    stop()
    expect(root.getAttribute('data-theme')).toBe('dark')
  })

  it('does nothing at all where there is no page to draw on', () => {
    // "No root" is a real state — a page that has not been built yet, and a runner with no
    // `document`. The rule is still resolved (it is the *setting*'s answer, not the page's), and
    // nothing throws on the way to a root that is not there.
    const scope = effectScope()
    const subject = scope.run(() =>
      usePetPageTheme({ theme: () => 'dark', root: () => null, view: null }),
    )
    expect(subject?.resolved.value).toBe('dark')
    scope.stop()
  })
})
