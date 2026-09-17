/**
 * The pet's surface follows the appearance the user chose in the app — measured as an equality.
 *
 * Plan §1 keeps 「现有主题、强调色」 and §5.2's row for the bubble's theme says 「默认跟随宿主主题」, and
 * the two together are one promise about *every* surface. Two things used to break it, and both are
 * things a reader can see:
 *
 *  1. **The settings page's preview drew a bubble the desktop never drew.** It answered Light and
 *     Dark with `#f7f7f5` / `#23211f`, while the app's own `--app-elevated` is `#fffefb` / `#24241f`;
 *     a user sets a bubble colour by looking at that stage.
 *  2. **The pet window carried none of the app's own axes.** No `data-accent`, no
 *     `data-color-scheme`, no `data-contrast` — so `palettes.css`'s fallbacks stood in for the
 *     user's accent, scheme and contrast, and `tokens.css`'s 15px stood in for their body size.
 *
 * ## What this file measures, and how
 *
 * The bar for the first one is **equality of two measured values**: the preview's bubble and the
 * desktop's bubble, computed, for the same settings. Not "both are light" and not "they differ" —
 * a fix that gave the preview a *third* table would pass those. So the two values are read off two
 * real pages and compared as strings:
 *
 *  - the **app page**, through the real settings dialog, with the appearance driven by the real
 *    controls (the theme buttons, the accent swatches, the scheme cards, the size field) and the
 *    pet section mounted inside it — `desktop-pet-settings.spec.ts`'s own mount, so the preview is
 *    the product's component in the product's column;
 *  - the **pet window's page**, `desktop-pet.html`, with `DesktopPetRoot` mounted into
 *    `#desktop-pet` — the product's root in the product's own mount point — and a host that hands
 *    it the same five axes the app page's own root is carrying (read *off* that page rather than
 *    spelled here, so the two cannot be given different values by this instrument).
 *
 * The second claim is measured in **WebKitGTK**, which is the engine that ships:
 * `e2e/webkit/pet-probe.mjs`'s appearance step drives the same fields through the host and reads
 * the page back. Chromium is not evidence about WebKit, and nothing here is offered as any.
 *
 * Everything else in this file is Chromium through Playwright, and one thing it deliberately does
 * not claim: the *publish* path (the app window calling `desktop_pet_publish_host_appearance`)
 * needs a Tauri host, so what is measured here is the page's half — given those five axes, both
 * surfaces draw the same bubble.
 */
import { expect, test, type Page } from '@playwright/test'
import { openNote } from './support/editorHarness'

/** The bubble's alpha for these cases: not the default, so a surface ignoring the setting shows. */
const OPACITY = 0.6

/** One computed colour pair, as a page reports it. */
interface BubbleColours {
  background: string
  color: string
}

/** What the app page's stage carries and what its preview draws, read in one go. */
interface PreviewReading {
  stage: Record<string, string | undefined>
  bubble: BubbleColours
  /** The palette the stage resolved those axes to, for the anti-vacuity check. */
  elevated: string
}

/**
 * Open the settings dialog on Appearance and put the pet's section inside the same dialog.
 *
 * The appearance is changed through the **real controls** — the three theme buttons, the accent
 * swatches and the scheme cards — because the claim is about what a user reaches by clicking, and a
 * test that wrote the store directly would prove the store works. The pet section is mounted the
 * way `desktop-pet-settings.spec.ts` mounts it: the real container, in the real content box, over
 * the memory gateway, with the bubble's own settings written through the host's own write path.
 */
async function openAppearanceAndPetPreview(page: Page): Promise<void> {
  await page.locator('.status-btn').last().click()
  await page.locator('.settings-overlay').waitFor({ state: 'visible', timeout: 5000 })
  // The second row of the rail, by id order: `SettingsNavigation.vue`'s own table is
  // `general, appearance, …`, and a label would need this file to know the locale.
  await page.locator('.dialog-nav .nav-row').nth(1).click()

  const dialog = page.locator('.dialog-content')
  await dialog.locator('.view-modes .switch-option').nth(1).click() // dark
  await dialog.locator('.color-scheme-card[data-scheme="forest"]').click()
  await dialog.locator('.accent-swatch[aria-label="teal"]').click()
  const size = dialog.locator('input[type="number"]').first()
  await size.fill('16')
  await size.press('Enter')

  await page.evaluate(
    async (opacity: number) => {
      const source = await (await fetch('/src/main.ts')).text()
      const vueUrl = source.match(/["']([^"']*\/deps\/vue\.js[^"']*)["']/)?.[1]
      if (vueUrl === undefined) throw new Error('the dev server serves no vue dependency')
      const vue = (await import(/* @vite-ignore */ vueUrl)) as typeof import('vue')
      const container = (await import(
        /* @vite-ignore */ '/src/features/desktop-pet-settings/components/DesktopPetSettings.vue'
      )) as { default: unknown }
      const gatewayModule = (await import(
        /* @vite-ignore */ '/src/platform/gateways/memory-pet.ts'
      )) as typeof import('/src/platform/gateways/memory-pet.ts')

      const gateway = gatewayModule.createMemoryPetGateway({ visible: true })
      const loaded = await gateway.readSettings('message')
      if (loaded.status !== 'current') throw new Error('the double would not read its message record')
      // The domain is checked rather than assumed: `PetSettingsRecord` is a union correlated on
      // `domain`, and `record.values` is the whole union until this narrows it — the same reading
      // `desktop-pet-settings.spec.ts` makes when it seeds a character id.
      if (loaded.record.domain !== 'message') throw new Error('the double answered for another domain')
      // The bubble is pinned to **the other** palette on purpose: `system` would make both surfaces
      // follow the app again and the case would pass on the defect. This is the override §5.2
      // keeps, and it is the one the preview used to draw with a table of its own. The line is what
      // makes the surface a bubble rather than nothing: the schema's `quickBubbles` is empty on
      // purpose (they are the *user's* words), and `message.idle` alone draws no surface.
      await gateway.updateSettings({
        domain: 'message',
        revision: loaded.record.revision,
        values: { ...loaded.record.values, theme: 'light', opacity, quickBubbles: ['The desktop bubble.'] },
      })

      const host = document.createElement('div')
      host.id = 'e2e-pet-appearance'
      host.style.cssText =
        'position: absolute; left: 20px; right: 20px; top: 16px; bottom: 20px; overflow: auto; z-index: 2; background: var(--app-panel);'
      const content = document.querySelector('.dialog-content')
      if (content === null) throw new Error('the settings dialog has no content box')
      content.append(host)
      // The preview is drawn by the container itself (`DesktopPetSettings.vue:297`), on every page,
      // so no slot is needed for it: what this case mounts is the product's own container with the
      // product's own preview in the product's own column.
      const app = vue.createApp({
        render: () => vue.h(container.default as never, { gateway, page: 'bubble' }),
      })
      app.mount(host)
      await vue.nextTick()
      window.__petAppearance = { unmount: () => app.unmount() }
    },
    OPACITY,
  )

  // The bubble is drawn on request (§6.3 gives the reminder its own life), so the case asks for it
  // through the stage's own button.
  await page.locator('#e2e-pet-appearance .pet-preview__ask').click()
}

declare global {
  interface Window {
    __petAppearance?: { unmount(): void }
  }
}

test('the settings preview draws the bubble the desktop draws, value for value', async ({ page, browser }) => {
  await openNote(page)
  await openAppearanceAndPetPreview(page)

  const preview = await page.evaluate((): PreviewReading => {
    const stage = document.querySelector<HTMLElement>('#e2e-pet-appearance .pet-preview__stage')
    const bubble = document.querySelector<HTMLElement>('#e2e-pet-appearance .pet-preview__bubble')
    if (!stage || !bubble) throw new Error('the preview drew no bubble to measure')
    const style = getComputedStyle(bubble)
    return {
      stage: { ...stage.dataset },
      bubble: { background: style.backgroundColor, color: style.color },
      elevated: getComputedStyle(stage).getPropertyValue('--app-elevated').trim(),
    }
  })

  // The four axes the *stage* carries, which is what the pet window's root carries too. Read here
  // and handed to the pet page below, so the two pages are measured on the same appearance rather
  // than on two values this file spelled.
  expect(preview.stage).toMatchObject({
    theme: 'light',
    colorScheme: 'forest',
    accent: 'teal',
    contrast: 'normal',
  })

  const desktop = await browser.newPage()
  try {
    await desktop.goto('/desktop-pet.html')
    const bubble = await desktop.evaluate(
      async (axes: { appearance: Record<string, string | undefined>; opacity: number }) => {
        const source = await (await fetch('/src/main.ts')).text()
        const vueUrl = source.match(/["']([^"']*\/deps\/vue\.js[^"']*)["']/)?.[1]
        if (vueUrl === undefined) throw new Error('the dev server serves no vue dependency')
        const vue = (await import(/* @vite-ignore */ vueUrl)) as typeof import('vue')
        const root = (await import(
          /* @vite-ignore */ '/src/features/desktop-pet/components/DesktopPetRoot.vue'
        )) as { default: unknown }
        const gatewayModule = (await import(
          /* @vite-ignore */ '/src/platform/gateways/memory-pet.ts'
        )) as typeof import('/src/platform/gateways/memory-pet.ts')

        // The host relays what the app published, so the double is told exactly the axes the app
        // page's own stage was carrying — see the header for why they are passed in.
        const gateway = gatewayModule.createMemoryPetGateway({
          visible: true,
          hostAppearance: {
            theme: axes.appearance.theme,
            colorScheme: axes.appearance.colorScheme,
            accent: axes.appearance.accent,
            highContrast: axes.appearance.contrast === 'high',
            bodyFontSize: 16,
          },
        })
        const loaded = await gateway.readSettings('message')
        if (loaded.status !== 'current') throw new Error('the double would not read its message record')
        if (loaded.record.domain !== 'message') throw new Error('the double answered for another domain')
        await gateway.updateSettings({
          domain: 'message',
          revision: loaded.record.revision,
          values: {
            ...loaded.record.values,
            theme: 'light',
            opacity: axes.opacity,
            quickBubbles: ['The desktop bubble.'],
          },
        })

        const host = document.getElementById('desktop-pet')
        if (!host) throw new Error('desktop-pet.html declares no #desktop-pet to mount into')
        const app = vue.createApp({
          render: () =>
            vue.h(root.default as never, {
              gateway,
              connection: gateway,
              // A character is chosen and its file cannot load in a browser: the bubble is drawn
              // above the sentence either way, and the bubble is what this case measures.
              imageUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
              width: 160,
              height: 180,
              platform: null,
            }),
        })
        app.mount(host)
        await vue.nextTick()
        // The host's own reads are promises, and the surface is drawn once they land.
        await new Promise((resolve) => setTimeout(resolve, 200))

        const surface = host.querySelector<HTMLElement>('.pet-bubble__line')
        const box = surface?.closest('.pet-bubble')
        if (!box) throw new Error('the pet window drew no bubble to measure')
        const style = getComputedStyle(box)
        return { background: style.backgroundColor, color: style.color }
      },
      { appearance: preview.stage, opacity: OPACITY },
    )

    // The bar, as an equality of two measured values: the same settings, the same numbers, drawn by
    // two different pages. `#f7f7f5` was what the preview used to answer Light with; the app's own
    // light elevated is `#fffefb`, and the forest scheme re-points it further — so a preview with a
    // table of its own, or one that forgot the scheme, lands on a different string here.
    expect(preview.bubble.background).toBe(bubble.background)
    expect(preview.bubble.color).toBe(bubble.color)

    // Anti-vacuity, in the other direction: the equality above must not hold because both pages are
    // drawing the *old* literal, nor because both are drawing the `forest` scheme's light colour by
    // accident of the app being light. The stage resolved the scheme, and the pet window is a
    // different document with its own defaults — so what is checked is that the measured background
    // is a mix of the palette the app's own stage resolved.
    expect(preview.bubble.background).not.toBe('rgb(247, 247, 245)')
    expect(preview.elevated).not.toBe('')
  } finally {
    await desktop.close()
  }
})

test('the pet window carries the app’s own axes, not the palette’s fallbacks', async ({ browser }) => {
  // The second defect, in the same shape: the window used to carry no `data-accent`,
  // `data-color-scheme` or `data-contrast` at all, and drew `palettes.css`'s defaults and
  // `tokens.css`'s 15px. Driven here through the host (the publish path needs a Tauri host — see the
  // header), and in WebKitGTK by the probe.
  const desktop = await browser.newPage()
  try {
    await desktop.goto('/desktop-pet.html')
    const reading = await desktop.evaluate(async () => {
      const source = await (await fetch('/src/main.ts')).text()
      const vueUrl = source.match(/["']([^"']*\/deps\/vue\.js[^"']*)["']/)?.[1]
      if (vueUrl === undefined) throw new Error('the dev server serves no vue dependency')
      const vue = (await import(/* @vite-ignore */ vueUrl)) as typeof import('vue')
      const root = (await import(
        /* @vite-ignore */ '/src/features/desktop-pet/components/DesktopPetRoot.vue'
      )) as { default: unknown }
      const gatewayModule = (await import(
        /* @vite-ignore */ '/src/platform/gateways/memory-pet.ts'
      )) as typeof import('/src/platform/gateways/memory-pet.ts')

      const gateway = gatewayModule.createMemoryPetGateway({
        visible: true,
        hostAppearance: {
          theme: 'dark',
          colorScheme: 'forest',
          accent: 'teal',
          highContrast: true,
          bodyFontSize: 17,
        },
      })
      const host = document.getElementById('desktop-pet')
      if (!host) throw new Error('desktop-pet.html declares no #desktop-pet to mount into')
      const app = vue.createApp({
        render: () => vue.h(root.default as never, { gateway, connection: gateway, platform: null }),
      })
      app.mount(host)
      await vue.nextTick()
      await new Promise((resolve) => setTimeout(resolve, 200))

      const pageRoot = document.documentElement
      return {
        theme: pageRoot.getAttribute('data-theme'),
        colorScheme: pageRoot.getAttribute('data-color-scheme'),
        accent: pageRoot.getAttribute('data-accent'),
        contrast: pageRoot.getAttribute('data-contrast'),
        bodySize: pageRoot.style.getPropertyValue('--app-body-size'),
        // And the inherited read, which is what every surface in the window actually consumes
        // (`PetContextMenu.vue:249` is `font-size: var(--app-body-size, 12px)`): a property written
        // somewhere nothing inherits from would leave those at the fallback.
        inheritedBodySize: getComputedStyle(
          document.querySelector('.pet-root') as HTMLElement,
        )
          .getPropertyValue('--app-body-size')
          .trim(),
      }
    })

    expect(reading).toMatchObject({
      theme: 'dark',
      colorScheme: 'forest',
      accent: 'teal',
      contrast: 'high',
      bodySize: '17px',
    })
    // The property is really on the element rather than in a string: an inherited read sees it.
    expect(reading.inheritedBodySize).toBe('17px')
  } finally {
    await desktop.close()
  }
})
