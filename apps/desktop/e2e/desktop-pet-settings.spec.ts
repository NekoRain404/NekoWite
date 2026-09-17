/**
 * E1 — the desktop pet's settings pages, in a browser.
 *
 * Plan §11 gives D7a/D7b/D7c the acceptance 主开关/通知/预览真实生效、重开保留 and files it here, and
 * §12 adds the sweep this file is mostly made of: 1280x820, 860x560, 深浅主题, 长中文/路径,
 * 125%/150% 缩放 and reduced-motion — plus the one sentence that governs the rest of this task,
 * 「浏览器截图不能证明原生置顶/穿透/焦点正确，须另做真实 Tauri 验证」.
 *
 * So this file claims nothing about the compositor, and it says so wherever a reader might
 * otherwise assume it: **everything here is Chromium, through Playwright.** No window is created,
 * nothing is composited, and `always-on-top`, `pointer-passthrough` and `no-focus-steal` are not
 * exercised by a single assertion below. What a browser *can* answer is what the page does with the
 * findings a host hands it — that a capability nobody measured is disabled and explained rather than
 * drawn as a switch that would do nothing — and that is a claim about the page, which is what these
 * pages are.
 *
 * ## What is driven, and what is not
 *
 * §10.1 puts the settings *integration* in D12: `features/settings/types.ts` gains the section and
 * `SettingsPanel.vue` imports it. That has not landed, so there is no row in the running dialog to
 * click. Rather than skip the pages, each test opens the **real settings dialog** and mounts the
 * real container into its **real content box**, so the width the pages are measured at is the width
 * they will have rather than a number this file picked. What that does not cover is the wiring, and
 * the wiring is D12's.
 *
 * ## The host is the memory gateway
 *
 * `createMemoryPetGateway` is the double D1 froze, and it is the only host in this file. That is
 * deliberate rather than convenient: the double keeps §7.2's unfaked default — every capability
 * `unverified` until something is observed — so the gap D11a reported (no `wander`, and two of the
 * four roam modes gated behind capabilities nothing has measured) is what these pages actually show
 * on a machine §12's matrix has not run on. A run that declared all eleven capabilities available
 * would be testing a build that does not exist.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openNote } from './support/editorHarness'
import { LONG_PATH } from './support/petFixture'

/** The four pages whose components are slot content, of §5.1's pages. `advanced` is added by a test. */
const SLOT_PAGES = ['character', 'bubble', 'care', 'project'] as const
type SlotPage = (typeof SLOT_PAGES)[number] | 'advanced'

/** The findings a test asks the host to declare. Everything not named stays unverified. */
type DeclaredFindings = Record<
  string,
  { status: 'available' } | { status: 'degraded' | 'unavailable' | 'unverified'; fallback: string; detail: string }
>

interface MountOptions {
  /** Which slot pages to render. A page left out is one this build has no component behind. */
  slotPages?: readonly SlotPage[]
  /** What the host reports for the capabilities it names. */
  capabilities?: DeclaredFindings
  /** A character id to store before mounting — where the long-path case is written. */
  characterId?: string | null
  /**
   * Ask for a store of its own rather than the one the previous mount in this test made.
   *
   * Two mounts over one store is what "reopen the dialog" means; two *hosts* is what a comparison
   * between two reports means. The names say which of the two a test is doing.
   */
  freshStore?: boolean
}

/** What the page-side harness records, so a test can ask what the page actually did. */
interface Harness {
  calls: string[]
  unmount(): void
  feature(): Promise<{ enabled: boolean; visible: boolean }>
  vocabulary(): Promise<string[]>
  /** The stored values of one domain, read back through the host's own port. */
  read(domain: string): Promise<Record<string, unknown> | null>
}

declare global {
  interface Window {
    __petSettings?: Harness
    /** The install's store, kept across mounts: reopening the dialog meets the same settings. */
    __petSettingsGateway?: unknown
  }
}

/**
 * Open the app's own settings dialog and put the pet section inside it.
 *
 * `.status-btn`'s last entry is the settings button (`AppShell.vue`'s status bar) and the dialog it
 * opens is the real one — same overlay, same rail, same content box. The section goes into
 * `.dialog-content` at that element's own padding, so `measure()` below reads the width the dialog
 * gives a page at this viewport rather than a width chosen here.
 *
 * Called twice in one test, it is a *reopen*: the dialog is already up, and the host and its store
 * are the ones the first call made — which is what "close the dialog and open it again" has to mean
 * for the setting that was written to still be there.
 *
 * Vue is imported by URL rather than by name: a page has no import map, and the component has to be
 * compiled against the *same* Vue instance the dev server serves.
 */
async function openPetSection(page: Page, options: MountOptions = {}): Promise<void> {
  if ((await page.locator('.settings-overlay').count()) === 0) {
    await page.locator('.status-btn').last().click()
    await page.locator('.settings-overlay').waitFor({ state: 'visible', timeout: 5000 })
  }
  await page.evaluate(
    async (opts: { slotPages: readonly SlotPage[] } & MountOptions) => {
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

      const store = window as unknown as { __petSettingsGateway?: ReturnType<typeof gatewayModule.createMemoryPetGateway> }
      const real =
        opts.freshStore || store.__petSettingsGateway === undefined
          ? gatewayModule.createMemoryPetGateway({
              visible: true,
              capabilities: opts.capabilities,
            })
          : store.__petSettingsGateway
      store.__petSettingsGateway = real

      // Seed the character domain before a page reads it: `characterId` has no control of its own
      // (the library that sets it is D8's), so a long id can only arrive from the store.
      if (opts.characterId !== undefined) {
        const loaded = await real.readSettings('character')
        if (loaded.status === 'current' || loaded.status === 'migrated') {
          // `PetSettingsRecord` is a union correlated on `domain`, and the value a *read* answers
          // with is the whole union: the domain is checked rather than assumed, which is what
          // makes the record's own values the `character` ones this write spreads.
          const { record } = loaded
          if (record.domain === 'character') {
            await real.updateSettings({
              domain: 'character',
              revision: record.revision,
              values: { ...record.values, characterId: opts.characterId },
            })
          }
        }
      }

      // Every call the container or a page makes, by name. A recording proxy rather than a list of
      // wrapped methods, because a list can only see the methods somebody remembered to list.
      const calls: string[] = []
      const gateway = new Proxy(real, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver)
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => {
            calls.push(String(property))
            return (value as (...a: unknown[]) => unknown).apply(target, args)
          }
        },
      }) as typeof real

      const pageUrls: Record<string, string> = {
        character: '/src/features/desktop-pet-settings/components/PetCharacterSettings.vue',
        bubble: '/src/features/desktop-pet-settings/components/PetBubbleSettings.vue',
        care: '/src/features/desktop-pet-settings/components/PetCareSettings.vue',
        project: '/src/features/desktop-pet-settings/components/PetProjectSettings.vue',
        advanced: '/src/features/desktop-pet-settings/components/PetIntegrationSettings.vue',
      }

      const slots: Record<string, (props: { context: unknown }) => unknown> = {}
      for (const name of opts.slotPages) {
        const url = pageUrls[name]
        if (url === undefined) continue
        const component = (await import(/* @vite-ignore */ url)) as { default: unknown }
        slots[name] = (slotProps: { context: unknown }) =>
          vue.h(component.default as never, { context: slotProps.context })
      }

      window.__petSettings?.unmount()
      const host = document.createElement('div')
      host.id = 'e2e-pet-settings'
      host.style.cssText =
        'position: absolute; left: 20px; right: 20px; top: 16px; bottom: 20px; overflow: auto; z-index: 2; background: var(--app-panel);'
      const content = document.querySelector('.dialog-content')
      if (content === null) throw new Error('the settings dialog has no content box')
      content.append(host)

      const app = vue.createApp({
        render: () => vue.h(container.default as never, { gateway, page: 'general' }, slots),
      })
      app.mount(host)
      window.__petSettings = {
        calls,
        unmount: () => {
          app.unmount()
          host.remove()
        },
        feature: () => real.feature(),
        vocabulary: () => Promise.resolve([...new Set(calls)].sort()),
        read: async (domain: string) => {
          const loaded = await real.readSettings(domain as never)
          if (loaded.status !== 'current' && loaded.status !== 'migrated') return null
          return loaded.record.values as Record<string, unknown>
        },
      }
    },
    { slotPages: options.slotPages ?? SLOT_PAGES, ...options },
  )
  await expect(page.locator('#e2e-pet-settings .pet-settings')).toBeAttached()
}

/** What the host says the feature state is — the double's store, read back through its own port. */
const featureState = (page: Page) => page.evaluate(() => window.__petSettings?.feature())

/** The methods the page has used, without duplicates. */
const vocabulary = (page: Page) => page.evaluate(() => window.__petSettings?.vocabulary() ?? [])

/** How many settings writes the page has asked for. */
const writes = (page: Page) =>
  page.evaluate(() => (window.__petSettings?.calls ?? []).filter((c) => c === 'updateSettings').length)

/** One domain's stored values, as the host holds them — not as a page renders them. */
async function stored(page: Page, domain: string): Promise<Record<string, unknown>> {
  const values = await page.evaluate((name) => window.__petSettings?.read(name), domain)
  if (values === null || values === undefined) throw new Error(`the store holds no ${domain} record`)
  return values
}

/** The settings tab for one page. */
const tab = (page: Page, name: string): Locator =>
  page.locator(`#e2e-pet-settings .pet-settings__tab[data-page="${name}"]`)

/**
 * Open a sub-page, and wait until the one being left is out of the document.
 *
 * The swap is a cross-fade, so for its 400ms **both** pages are in the DOM: the leaver is out of
 * flow and takes no pointer, but it still matches every selector. That is not a cosmetic detail —
 * the first run of this spec counted six checkboxes where the page has two and one, and clicking
 * "the sixth" wrote nothing at all, because the sixth was the *leaving* page's control. Counting
 * boxes is how this file addresses the switches (it does not pin a locale), so a page that is on its
 * way out has to be waited for rather than selected around.
 *
 * `console-clean.spec.ts` waits on `.dialog-content > .page-leave-active` for the same reason, one
 * level up.
 */
async function openTab(page: Page, name: string): Promise<void> {
  await tab(page, name).click()
  await expect(page.locator('#e2e-pet-settings .pet-swap-leave-active')).toHaveCount(0, { timeout: 3000 })
}

/**
 * Boot the app and open a note, then move the window to the viewport under test.
 *
 * The resize comes second because `openNote` clicks the file tree, and **at 860x560 the tree is
 * present but not visible in this build** — the first run of this spec found it as a 30s click
 * timeout on `.tree-name`, with the element resolved in the DOM. That is a finding about the
 * editor's layout at that size and not this task's to fix (reported in D13's report); what this
 * helper does is keep it out of the way of the measurement, which is what a user does anyway: the
 * window is resized after it is open, and the settings pages are measured at the size asked for.
 */
async function bootAt(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 820 })
  await openNote(page)
  if (viewport.width !== 1280 || viewport.height !== 820) await page.setViewportSize(viewport)
}

/**
 * Move a range control the way a user does: the browser sets the value and fires `input`, which is
 * the one event these pages listen for. Written out because Playwright's `fill()` is for text.
 */
async function slide(locator: Locator, value: number): Promise<void> {
  await locator.evaluate((el, next) => {
    const input = el as HTMLInputElement
    input.value = String(next)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

/** The width the dialog gives a page at this viewport, and what the section does with it. */
async function measure(page: Page): Promise<{
  contentWidth: number
  sectionWidth: number
  overflowX: number
  railWraps: boolean
  previewInside: boolean
}> {
  return page.evaluate(() => {
    const host = document.getElementById('e2e-pet-settings')
    const section = host?.querySelector('.pet-settings')
    const rail = host?.querySelector('.pet-settings__rail')
    const body = host?.querySelector('.pet-settings__body')
    const preview = host?.querySelector('.pet-settings__preview')
    if (!host || !section || !rail || !body || !preview) throw new Error('the section is not mounted')
    const railRows = new Set(
      Array.from(rail.children).map((child) => Math.round(child.getBoundingClientRect().top)),
    )
    const hostBox = host.getBoundingClientRect()
    const bodyBox = body.getBoundingClientRect()
    const previewBox = preview.getBoundingClientRect()
    return {
      contentWidth: Math.round(host.clientWidth),
      sectionWidth: Math.round(section.getBoundingClientRect().width),
      // The page's own horizontal overflow, in whole pixels. A positive number is content wider
      // than the box it is in — the one thing the viewport sweep is about.
      overflowX: Math.max(0, Math.round(section.scrollWidth - section.clientWidth)),
      railWraps: railRows.size > 1,
      previewInside:
        previewBox.left >= hostBox.left - 1 &&
        previewBox.right <= hostBox.right + 1 &&
        previewBox.right <= bodyBox.right + 1,
    }
  })
}

/*
 * No locale pin, and that is deliberate rather than an omission.
 *
 * `agent-settings.spec.ts` pins `nekowite.locale` to `en` because its sections carry literal English
 * copy. This file cannot: `support/editorHarness.ts`'s `openNote` clicks the sidebar by its Chinese
 * label (`.nav-item` with 文件夹), so pinning the locale to English makes the *harness* fail before
 * any pet assertion runs — measured, one run, twelve 30s timeouts. The product's default locale is
 * Chinese anyway, so what is asserted below is what a Chinese user sees.
 *
 * The assertions are therefore written against structure — counts, `data-test` hooks, `data-*`
 * attributes, rects, and the values the host reads back — rather than against wording. Where a
 * sentence is the only thing that carries the fact, the test compares two states (present vs absent)
 * instead of matching a translation.
 */

// ---------------------------------------------------------------------------
// §12's viewport sweep
// ---------------------------------------------------------------------------

// §12 names the first two, and they are the two this file runs. The third is added because the
// dialog is `width: min(720px, 100%)` — so a window narrower than about 768px is the first one that
// gives a *narrower* page rather than a shorter one, and a sweep that stopped at 860 would never
// have measured the narrow case at all. The measured widths are in this file's report.
//
// **The third size is narrower than the product can be**, deliberately: `tauri.conf.json` sets the
// main window's `minWidth` to 860, so at every window the app can have, the 720px term wins and the
// dialog is 720 (task-191 checked this — 860x560 is the narrow case, and it is narrow only in
// height). The 700 case is the clamp itself being exercised, one step past the app's own floor, and
// it is the check that the dialog would degrade rather than overflow if that floor ever moved.
for (const viewport of [
  { width: 1280, height: 820 },
  { width: 860, height: 560 },
  { width: 700, height: 560 },
]) {
  test(`the section fits the dialog's content box at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await bootAt(page, viewport)
    await openPetSection(page)
    const m = await measure(page)

    // The numbers always: a run that only asserts cannot be read, and "it fits" is a claim that has
    // to be visible as a width before it is a claim about a check.
    console.log(
      `[pet-settings] ${viewport.width}x${viewport.height}: content ${m.contentWidth}px, section ${m.sectionWidth}px, overflow ${m.overflowX}px, rail wraps ${m.railWraps}`,
    )

    expect(m.overflowX, 'the page is not wider than the box it is in').toBeLessThanOrEqual(0)
    expect(m.sectionWidth).toBeLessThanOrEqual(m.contentWidth + 1)
    expect(m.previewInside, 'the preview column is inside the dialog').toBe(true)

    // Every tab is reachable and none is clipped: at 860x560 the dialog is narrower than the rail,
    // so a rail that did not wrap would put the last page off the right edge.
    const tabs = page.locator('#e2e-pet-settings .pet-settings__tab')
    await expect(tabs).toHaveCount(6)
    const boxes = await tabs.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()))
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(viewport.width)
    }
  })
}

for (const zoom of [1.25, 1.5]) {
  test(`a ${Math.round(zoom * 100)}% zoomed window lays the page out the same way`, async ({ browser }) => {
    // Emulated as the two things browser zoom does: fewer CSS pixels for the same window, and more
    // device pixels per CSS pixel. Playwright cannot set a page zoom level, and calling a plain
    // resize "125%" would be the same mistake §12 warns about for the native matrix — so this test
    // is named for what it emulates and the numbers it prints are the ones it measured.
    //
    // This one is deliberately NOT locale-pinned: it is the run that measures the product's own
    // Chinese copy, which is what the maintainer's window shows.
    const context = await browser.newContext({
      viewport: { width: Math.round(1280 / zoom), height: Math.round(820 / zoom) },
      deviceScaleFactor: zoom,
    })
    const page = await context.newPage()
    try {
      // Booted at 1280x820 inside this context, then moved to the emulated size — `bootAt` says why
      // the note is opened before the window shrinks.
      await bootAt(page, { width: Math.round(1280 / zoom), height: Math.round(820 / zoom) })
      await openPetSection(page)
      const m = await measure(page)
      console.log(
        `[pet-settings] ${Math.round(zoom * 100)}%: content ${m.contentWidth}px, section ${m.sectionWidth}px, overflow ${m.overflowX}px`,
      )
      expect(m.overflowX).toBeLessThanOrEqual(0)
      expect(m.previewInside).toBe(true)
      // The figure the preview draws is sized in CSS pixels from a setting, so it is the thing most
      // likely to outgrow its column — at any zoom, and at the size a user is likeliest to pick.
      await openTab(page, 'character')
      await page.locator('#e2e-pet-settings [data-test="pet-character-preset-125"]').click()
      const figure = await page.locator('#e2e-pet-settings .pet-preview__figure').boundingBox()
      expect(figure).not.toBeNull()
      if (figure) expect(figure.width).toBeLessThanOrEqual(m.sectionWidth)
    } finally {
      await context.close()
    }
  })
}

// ---------------------------------------------------------------------------
// What the rail offers
// ---------------------------------------------------------------------------

test('the rail offers a page only when a component is behind it', async ({ page }) => {
  await openNote(page)
  await openPetSection(page)

  // §5.2 forbids a control that leads nowhere, so `advanced` — which this run has no component for —
  // must not be a tab. The other six are.
  await expect(page.locator('#e2e-pet-settings .pet-settings__tab')).toHaveCount(6)
  await expect(tab(page, 'advanced')).toHaveCount(0)

  // …and its absence is stated rather than silent, in the note under the rail. Asserted as a
  // *difference* rather than as a sentence: this file does not pin a locale, so matching the wording
  // would be matching a translation. With one page missing the note is there and names something;
  // with none missing it is gone entirely.
  const withOneMissing = await page.locator('#e2e-pet-settings .pet-settings__pending').innerText()
  expect(withOneMissing.trim().length).toBeGreaterThan(0)
  await openPetSection(page, { slotPages: [...SLOT_PAGES, 'advanced'], freshStore: true })
  await expect(page.locator('#e2e-pet-settings .pet-settings__tab')).toHaveCount(7)
  await expect(page.locator('#e2e-pet-settings .pet-settings__pending')).toHaveCount(0)

  // Each remaining tab actually swaps the page.
  for (const name of ['character', 'bubble', 'notification', 'care', 'project', 'general']) {
    await openTab(page, name)
    await expect(page.locator('#e2e-pet-settings .pet-settings__tab.active')).toHaveAttribute('data-page', name)
    await expect(page.locator('#e2e-pet-settings .pet-settings__content .settings-section').first()).toBeAttached()
  }
})

// ---------------------------------------------------------------------------
// The switch, the preview, and the pet's own window
// ---------------------------------------------------------------------------

test('the master switch is written, is what the host reports, and drives the preview', async ({ page }) => {
  await openNote(page)
  await openPetSection(page)

  const enable = page.locator('#e2e-pet-settings .settings-toggle input.checkbox').first()
  await expect(enable).toBeChecked()
  await expect(page.locator('#e2e-pet-settings .pet-preview__figure')).toBeVisible()

  await enable.uncheck()

  // The write landed, and the host is what says so: the page's own state is not the evidence.
  await expect.poll(() => featureState(page), { timeout: 5000 }).toEqual({ enabled: false, visible: false })
  // §5.1 keeps 启用 and 显示 apart: off is not hidden, and the preview shows the off notice instead
  // of a pet.
  await expect(page.locator('#e2e-pet-settings .pet-preview__notice')).toBeVisible()

  await enable.check()
  await expect.poll(() => featureState(page), { timeout: 5000 }).toEqual({ enabled: true, visible: true })
  await expect(page.locator('#e2e-pet-settings .pet-preview__figure')).toBeVisible()
})

test('the preview asks the host for settings and nothing else', async ({ page }) => {
  await openNote(page)
  await openPetSection(page)

  // Drive the one control the preview owns — the bubble it draws on request — and the page that
  // writes, then ask what the whole container's vocabulary was.
  await page.locator('#e2e-pet-settings .pet-preview__ask').click()
  await expect(page.locator('#e2e-pet-settings .pet-preview__bubble')).toBeVisible()
  await openTab(page, 'notification')
  // Unchecked rather than checked: the four event switches default to on, and a click on a box that
  // is already ticked changes nothing and writes nothing — which is correct behaviour and a silent
  // no-op for a test that meant to produce a write.
  await page.locator('#e2e-pet-settings .settings-toggle input.checkbox').first().uncheck()
  await expect.poll(() => writes(page), { timeout: 5000 }).toBeGreaterThanOrEqual(1)

  // Three methods, and none of them delivers anything: `PetGateway` has no delivery call at all
  // (§6.3 gives delivery to one backend ledger), so a settings page that raised a notification would
  // have to reach past its own port to do it. This is that claim as a list.
  expect(await vocabulary(page)).toEqual(['capabilities', 'readSettings', 'updateSettings'])
})

test('what a page writes is what it reads back when it is reopened', async ({ page }) => {
  await openNote(page)
  await openPetSection(page)

  // Three domains, three pages: do-not-disturb (`notification`), the bubble's opacity (`message`)
  // and the character's size (`character`).
  //
  // The do-not-disturb switch is the sixth checkbox on its page by the page's own declaration: four
  // event switches, then the sound, then the do-not-disturb, then the task title. Positional rather
  // than by label because this file does not pin a locale; the host's stored value is asserted
  // alongside, so a page that reordered its controls fails here rather than passing silently.
  await openTab(page, 'notification')
  await page.locator('#e2e-pet-settings .settings-toggle input.checkbox').nth(5).check()
  await openTab(page, 'bubble')
  await slide(page.locator('#e2e-pet-settings input#pet-bubble-opacity'), 70)
  await openTab(page, 'character')
  await page.locator('#e2e-pet-settings [data-test="pet-character-preset-125"]').click()

  // Wait for the writes to land before the page goes away, then reopen the section. The reopen is a
  // new container over the same store, which is what closing the dialog and coming back is.
  await expect.poll(() => writes(page), { timeout: 5000 }).toBeGreaterThanOrEqual(3)
  await page.evaluate(() => window.__petSettings?.unmount())
  await openPetSection(page)

  // The reopened section opens on its first page, so each page is opened before its own control is
  // read: this is the page's control showing a value the store held, which is the half a test of the
  // store alone cannot have.
  await expect(page.locator('#e2e-pet-settings .settings-toggle input.checkbox').first()).toBeChecked()
  await openTab(page, 'bubble')
  await expect(page.locator('#e2e-pet-settings input#pet-bubble-opacity')).toHaveValue('70')
  await openTab(page, 'character')
  await expect(page.locator('#e2e-pet-settings [data-test="pet-character-size"]')).toHaveValue('200')
  await openTab(page, 'notification')
  await expect(page.locator('#e2e-pet-settings .settings-toggle input.checkbox').nth(5)).toBeChecked()

  // …and the store agrees with the controls, which is what makes the three reads above a fact about
  // what was written rather than about what the page happened to render.
  expect(await stored(page, 'notification')).toMatchObject({ doNotDisturb: true })
  expect(await stored(page, 'message')).toMatchObject({ opacity: 0.7 })
  expect(await stored(page, 'character')).toMatchObject({ size: 200 })
})

// ---------------------------------------------------------------------------
// §7.2's findings, which is where the page and the machine meet
// ---------------------------------------------------------------------------

test('a roam mode nothing has measured cannot be picked — the gap D11a reported', async ({ page }) => {
  await openNote(page)
  // The double's default report: every capability unverified, which is the state of this machine
  // until §12's matrix runs.
  await openPetSection(page)

  await page.locator('#pet-general-roam').click()
  const options = page.locator('.select-popup .select-option')
  await expect(options).toHaveCount(4)

  // The four values `PetRoamMode` declares, in the order the schema lists them. **There is no
  // `wander`**: upstream's default mode is missing from the contract, and that is D11a's recorded
  // gap — so this list *is* the gap, measured, and it is why the two rows below matter.
  expect(await options.evaluateAll((els) => els.map((el) => el.getAttribute('data-value')))).toEqual([
    'off',
    'stay',
    'follow-pointer',
    'climb',
  ])

  // Only the two that need nothing from the desktop are selectable. `follow-pointer` waits on a
  // global pointer nothing has observed, `climb` on an implementation that does not exist — so on a
  // machine §12 has not measured, the pet cannot move at all. That is the honest state, and this is
  // where a user meets it.
  const refused = await options.evaluateAll((els) =>
    els
      .filter((el) => el.getAttribute('aria-disabled') === 'true')
      .map((el) => el.querySelector('.select-option-label')?.textContent?.trim() ?? ''),
  )
  expect(refused).toHaveLength(2)
  await page.keyboard.press('Escape')

  // Each refused mode carries the host's own words beside it, on the mode's own line — 「不显示可点
  // 击但无效果的控件」 with the reason attached. Read as a relationship rather than as a sentence: the
  // label comes from the same catalogue entry as the option, so a re-worded phrase cannot make this
  // pass, and a *missing* reason cannot make it either.
  const notes = await page.locator('#e2e-pet-settings .settings-note').allInnerTexts()
  for (const label of refused) {
    expect(label.length, 'a refused option has a label to look for').toBeGreaterThan(0)
    expect(notes.some((text) => text.includes(label)), `a reason is written for ${label}`).toBe(true)
  }
})

test('an observation, and only an observation, turns a gated mode on', async ({ page }) => {
  await openNote(page)
  // The same page against a host that reports `pointer-follow` as worked. Nothing else changes, and
  // the mode becomes selectable — which is what makes the test above a statement about the report
  // rather than about a control this build hardcodes as disabled.
  await openPetSection(page, {
    capabilities: {
      'pointer-follow': { status: 'available' },
      'always-on-top': { status: 'available' },
    },
  })

  await page.locator('#pet-general-roam').click()
  const options = page.locator('.select-popup .select-option')
  await expect(options.nth(2)).not.toHaveAttribute('aria-disabled', 'true')
  // …and `climb` stays disabled: §7.2 makes it a determination rather than a measurement, and
  // `linux_capabilities.rs` checks it *before* the observation, so a `Worked` recorded against it
  // would be evidence about something other than the mode.
  await expect(options.nth(3)).toHaveAttribute('aria-disabled', 'true')
  await options.nth(2).click()
  // The stored value moved, read back from the host rather than from the trigger's label — this file
  // does not pin a locale, and the label is a translation of `follow-pointer` while `follow-pointer`
  // is the value.
  await expect.poll(async () => (await stored(page, 'view')).roam, { timeout: 5000 }).toBe('follow-pointer')

  // The window behaviour that needs the compositor is live for the same reason, and only for it.
  await expect(page.locator('#e2e-pet-settings .settings-toggle input.checkbox').nth(1)).toBeEnabled()
})

test('a capability that was not measured is stated, never drawn as a switch', async ({ page }) => {
  await openNote(page)
  await openPetSection(page)

  // `always-on-top` is unverified on this machine, so the control is there, disabled, and the
  // sentence explaining it sits immediately after its own row. A switch that did nothing while
  // looking live would be the failure §7.2 names; a disabled control with no reason would be the
  // other half of it.
  const reason = await page.evaluate(() => {
    const control = document.querySelector('#e2e-pet-settings .settings-toggle input.checkbox:disabled')
    const row = control?.closest('.settings-toggle')
    const next = row?.nextElementSibling
    return next?.classList.contains('settings-note') ? next.textContent?.trim() ?? '' : null
  })
  console.log(`[pet-settings] always-on-top is gated: ${JSON.stringify(reason)}`)
  expect(reason).not.toBeNull()
  expect((reason ?? '').length).toBeGreaterThan(0)
})

test('the notification page says the machine cannot deliver, and stops saying it when it can', async ({ page }) => {
  await openNote(page)

  // Two hosts, one page. The delivery notice is not a sentence in the template — it is the report's
  // own words — so the difference between the two mounts is the whole claim: a hardcoded notice
  // would be there in both, and a page that never read the report would be missing it in both.
  await openPetSection(page, { freshStore: true })
  await openTab(page, 'notification')
  const withoutDelivery = await page.locator('#e2e-pet-settings .settings-note').count()

  await openPetSection(page, {
    freshStore: true,
    capabilities: { 'system-notification': { status: 'available' } },
  })
  await openTab(page, 'notification')
  const withDelivery = await page.locator('#e2e-pet-settings .settings-note').count()

  console.log(`[pet-settings] notification notes: unmeasured ${withoutDelivery}, available ${withDelivery}`)
  expect(withDelivery).toBe(withoutDelivery - 1)
})

test('the integration page reports all eleven capabilities, and this machine has measured none', async ({ page }) => {
  await openNote(page)
  // `advanced` is mounted on purpose: it is the surface that reads the report, and D3's mechanism —
  // a capability becomes `available` only through an observation — is one of the two things §12's
  // matrix is supposed to fill in. Until then this page is the honest picture of the build.
  await openPetSection(page, { slotPages: ['advanced'] })
  await openTab(page, 'advanced')

  const rows = page.locator('#e2e-pet-settings .pet-capability')
  await expect(rows).toHaveCount(11)
  const statuses = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-status')))
  console.log(`[pet-settings] capability statuses: ${statuses.join(', ')}`)
  expect(statuses.filter((s) => s === 'available')).toHaveLength(0)
  expect(statuses.filter((s) => s === 'unverified')).toHaveLength(11)
})

// ---------------------------------------------------------------------------
// Content that decides whether a box holds
// ---------------------------------------------------------------------------

test('a long Chinese path does not widen the page', async ({ page }) => {
  await bootAt(page, { width: 860, height: 560 })
  await openPetSection(page, { characterId: LONG_PATH })
  await openTab(page, 'character')
  const current = page.locator('#e2e-pet-settings [data-test="pet-character-current"]')
  await expect(current).toContainText(LONG_PATH.slice(-12))

  const m = await measure(page)
  console.log(`[pet-settings] long path at 860x560: section ${m.sectionWidth}px, overflow ${m.overflowX}px`)
  expect(m.overflowX).toBeLessThanOrEqual(0)

  // And the row itself wraps rather than running past its own box: a CJK path has almost no break
  // opportunities, which is exactly the case a `white-space: nowrap` would fail.
  const row = await current.boundingBox()
  const section = await page.locator('#e2e-pet-settings .pet-settings').boundingBox()
  expect(row).not.toBeNull()
  expect(section).not.toBeNull()
  if (row && section) expect(row.x + row.width).toBeLessThanOrEqual(section.x + section.width + 1)
})

// ---------------------------------------------------------------------------
// Theme, and the motion preference
// ---------------------------------------------------------------------------

test('the section owns no colour: the host theme is what it draws with', async ({ page }) => {
  await openNote(page)
  await openPetSection(page)

  // The same rule `agent-changes.spec.ts` asserts for its own surface, by the same technique: the
  // document's theme attribute is switched under the mounted page, and a colour that did not move
  // would be a hardcoded one.
  const background = (theme: 'light' | 'dark'): Promise<string> =>
    page.evaluate((value) => {
      document.documentElement.dataset.theme = value
      document.documentElement.dataset.colorScheme = 'default'
      const host = document.getElementById('e2e-pet-settings')
      return getComputedStyle(host as Element).backgroundColor
    }, theme)

  const light = await background('light')
  const dark = await background('dark')
  console.log(`[pet-settings] theme: light ${light}, dark ${dark}`)
  expect(light).not.toBe(dark)

  const text = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#e2e-pet-settings .settings-note') as Element).color,
  )
  expect(text).not.toBe(light)
  expect(text).not.toBe(dark)
})

test('reduced motion keeps the state and drops the movement', async ({ page }) => {
  await openNote(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openPetSection(page)

  const figure = page.locator('#e2e-pet-settings .pet-preview__figure')
  await expect(figure).toHaveAttribute('data-reduced', 'true')
  expect(await figure.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')

  // §5.2's rule has a direction: the pet may reduce further than the system asks for and never
  // less. The setting can only agree with this, never undo it — and the state is still on screen,
  // because reduced motion is not a reason to stop saying what is happening.
  await page.locator('#pet-general-motion').click()
  const options = page.locator('.select-popup .select-option')
  await expect(options.nth(1)).toHaveAttribute('data-value', 'reduced')
  await options.nth(1).click()
  await expect(figure).toHaveAttribute('data-reduced', 'true')
  await expect(page.locator('#e2e-pet-settings .pet-preview__ask')).toBeVisible()
})
