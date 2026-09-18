/**
 * A select's popup draws the user's appearance, not a token — measured as an equality.
 *
 * **The defect this file exists for.** `SelectMenu.vue`'s popup was teleported to `body`, and `body`
 * is outside `.shell` — the one element that carries the user's appearance: `AppShell.vue:271-292`
 * puts `data-theme`, `data-color-scheme`, `data-accent`, `data-contrast` and the eight inline
 * `--app-*` properties on it and nothing repeats them anywhere else in the page. So every popup in
 * the app resolved `palettes.css`'s `:root` block instead of the user's choices, which in a dark
 * theme is the light one.
 *
 * Measured, Chromium, before the fix — the appearance driven through this very page's controls
 * (dark, `forest`, `teal`, 17px, leading 2, serif), the trigger's own dialog beside the popup:
 *
 *   | property                 | `.shell`            | popup (on `body`)                        | `:root`             |
 *   |--------------------------|---------------------|------------------------------------------|---------------------|
 *   | `--app-elevated`         | `#243020`           | `#fffefb`                                | `#fffefb`           |
 *   | `--app-text`             | `#e8f3e2`           | `#292a27`                                | `#292a27`           |
 *   | `--app-accent`           | `#2e9e8f`           | `#343532`                                | `#343532`           |
 *   | `--app-font`             | Source Serif 4      | `system-ui`                              | `system-ui`         |
 *   | `--app-shadow-menu`      | `rgb(0 0 0 / 48%)`  | `rgb(37 33 27 / 18%)`                    | `rgb(37 33 27 / 18%)` |
 *   | drawn face               | —                   | `color(srgb 0.9984 0.9944 0.9823)`       | —                   |
 *   | drawn text (a row)       | —                   | `rgb(41, 42, 39)`                        | —                   |
 *
 * A user picked a theme, a scheme, an accent, a size and a face and then read every one of the app's
 * 22 selects — the settings dialog's five pickers among them — on a light list drawn in the dark.
 *
 * ## What this file measures, and how
 *
 * The bar is **the equality of two independently measured values**: `.shell`'s own cascade and the
 * popup's, for one set of settings reached by clicking. Not "the popup is dark" — a popup given a
 * second table of its own would pass that. Everything is driven through the real controls:
 *
 *   `AppShell.vue:457` status bar's settings button → `App.vue`'s `showSettings`
 *   → `AppDialogs.vue:74` mounts `SettingsPanel`
 *   → `SettingsNavigation.vue:45` the second rail row (appearance)
 *   → `AppearanceSettings.vue:87` dark / `:111` the `forest` card / `:140` the `teal` swatch
 *      / `:214` the size field / `:225` the leading field
 *   → `AppearanceSettings.vue:168` the interface-font select, whose trigger
 *      (`SelectMenu.vue:335`) opens the popup this file is about (`:350` the teleport, `:356` the
 *      popup, `:365` its rows, `SelectMenu.vue:108-127` where the target is resolved).
 *
 * The drawn half is a pair rather than a property, exactly as the dialog's was: `.shell` declares
 * `font-family: var(--app-font)` (`app/appShell-chrome.css:51`) and so does a row of the popup
 * (`SelectMenu.vue`'s `.select-option`) — two elements, two stylesheets, one `var()`, so the engine
 * settles it.
 *
 * Nothing here claims anything about WebKitGTK; `e2e/webkit/pet-probe.mjs` carries the same
 * measurement in the engine that ships.
 */
import { expect, test, type Page } from '@playwright/test'
import { openNote } from './support/editorHarness'

/** The eight properties `AppShell.vue:271-292` publishes, in the order it writes them. */
const SHELL_PROPERTIES = [
  '--app-sidebar-width',
  '--app-rail-width',
  '--app-notelist-width',
  '--app-body-size',
  '--app-line-height',
  '--app-font',
  '--app-mono-font',
  '--app-editor-font',
] as const

/**
 * The three of them this case drives away from their clean-install value, and therefore the three
 * the "not the page root's" fence can be stated for. The other five are compared for equality only:
 * a column width is the window's (dragged on the layout's own handle) and the two stacks this case
 * does not touch resolve to the same string on both sides, so a `not.toBe` would assert nothing.
 */
const DRIVEN = ['--app-body-size', '--app-line-height', '--app-font'] as const

/** The appearance the case drives the controls to, and the reason each value is not the default. */
const BODY_SIZE = 17
const LINE_HEIGHT = 2
const UI_FONT = 'serif'

/**
 * The settings dialog's rail rows, by the order `SettingsNavigation.vue:17-24` declares them: the
 * appearance page the interface-font select lives on, and the AI page beside it. The second case
 * below settle on one and presses the other's row, which is what makes the select arrive under the
 * press rather than stand still for it.
 */
const APPEARANCE_ROW = 1
const AI_ROW = 4

/** The dark `forest` `--app-text`, the face and the shadow — the numbers the defect was measured at,
 *  and their light counterparts, which are what a popup outside `.shell` draws. */
const DARK_TEXT = 'rgb(232, 243, 226)'
const LIGHT_TEXT = 'rgb(41, 42, 39)'
const LIGHT_FACE = 'color(srgb 0.998431 0.994353 0.982275)'
const LIGHT_SHADOW = 'rgba(37, 33, 27,'
const DARK_SHADOW = 'rgba(0, 0, 0,'

interface SurfaceReading {
  /** The eight published properties, as CSS text ('' when the surface cannot see one at all). */
  properties: Record<string, string>
  fontFamily: string
  fontSize: string
  color: string
  background: string
  boxShadow: string
  borderColor: string
}

interface PopupReading {
  /** `.shell` — the element that carries the setting. */
  shell: SurfaceReading
  /** The popup's own box, wherever it was teleported to. */
  popup: SurfaceReading
  /** One row of the list, which is what a user reads and clicks. */
  option: SurfaceReading
  /** The closed control the popup belongs to. */
  trigger: SurfaceReading
  /** `document.documentElement` — where a popup outside `.shell` resolves these from. */
  token: SurfaceReading
  /** Where the popup ended up in the DOM, for the fence on the mechanism itself. */
  popupParent: string
  /** How far the popup sits off the trigger's edge — the 4px the recipe places it at. */
  gap: number
  /** Whether it opened upward (there was no room below) or downward. */
  side: 'above' | 'below'
  /** How far the popup's left edge sits from the trigger's, in pixels (the clamp may nudge it). */
  dx: number
  /** The popup's own box, for the window it had to fit inside. */
  box: { top: number, left: number, right: number, bottom: number }
  /** The window that box had to fit inside. */
  viewport: { width: number, height: number }
}

/**
 * Open the settings dialog's Appearance section and drive it to a value the token block cannot
 * produce.
 *
 * The values are deliberately all *not* the clean-install ones: `17` is not the default 15, `2` is
 * not 1.8, `forest` is not `default`, `teal` is not `ink`, `serif` is not `system`, and dark is not
 * what a page with no `data-theme` resolves. A popup that read any token would land on the default
 * of every one of them, which is what the fences below look for.
 */
async function openAppearanceWithOwnValues(page: Page): Promise<void> {
  // `AppShell.vue:457` — the status bar's own settings button, the same one a user presses.
  await page.locator('.status-btn').last().click()
  await page.locator('.settings-overlay').waitFor({ state: 'visible', timeout: 5000 })

  // `SettingsNavigation.vue:45` — the second row of the rail, by id order (`general, appearance, …`).
  await page.locator('.dialog-nav .nav-row').nth(1).click()
  const content = page.locator('.dialog-content')

  // Theme, scheme and accent: three clicks, three buttons a user sees on that page.
  await content.locator('.view-modes .switch-option').nth(1).click() // dark
  await content.locator('.color-scheme-card[data-scheme="forest"]').click()
  await content.locator('.accent-swatch[aria-label="teal"]').click()

  // The two numeric fields, through the same `@change` a blur produces (`AppearanceSettings.vue:217`
  // and `:229`).
  const size = content.locator('input[type="number"]').first()
  await size.fill(String(BODY_SIZE))
  await size.press('Enter')
  const leading = content.locator('input[type="number"]').nth(1)
  await leading.fill(String(LINE_HEIGHT))
  await leading.press('Enter')

  // The interface font, the select this file is about: trigger, then the row the store knows by id.
  await content.locator('#settings-ui-font').click()
  await page.locator('.select-popup').waitFor({ state: 'visible', timeout: 5000 })
  await page.locator('.select-popup .select-option[data-value="' + UI_FONT + '"]').click()
  // Closed again, so the per-test state is the dialog's and not a half-finished pick.
  await page.locator('.select-popup').waitFor({ state: 'detached', timeout: 5000 })
}

test('the select popup resolves the appearance the shell carries, value for value', async ({
  page,
}) => {
  await openNote(page)
  await openAppearanceWithOwnValues(page)

  // Reopen the list and let the arrival settle before anything is measured: the popup travels on a
  // transform, and a rect read mid-flight is a reading of the animation.
  await page.locator('#settings-ui-font').click()
  await page.locator('.select-popup').waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForTimeout(400)

  const read = await page.evaluate(
    ({ properties }: { properties: readonly string[] }): PopupReading => {
      const surface = (selector: string): SurfaceReading => {
        const el = selector === ':root' ? document.documentElement : document.querySelector(selector)
        if (!el) throw new Error(`no element for ${selector}`)
        const cs = getComputedStyle(el)
        const out: Record<string, string> = {}
        for (const name of properties) out[name] = cs.getPropertyValue(name).trim()
        return {
          properties: out,
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          color: cs.color,
          background: cs.backgroundColor,
          boxShadow: cs.boxShadow,
          borderColor: cs.borderTopColor,
        }
      }
      const popup = document.querySelector('.select-popup')
      const trigger = document.querySelector('#settings-ui-font')
      if (!popup || !trigger) throw new Error('the popup or its trigger is not in the document')
      const triggerBox = trigger.getBoundingClientRect()
      const popupBox = popup.getBoundingClientRect()
      const above = triggerBox.top - popupBox.bottom
      const below = popupBox.top - triggerBox.bottom
      return {
        shell: surface('.shell'),
        popup: surface('.select-popup'),
        option: surface('.select-popup .select-option'),
        trigger: surface('#settings-ui-font'),
        token: surface(':root'),
        popupParent: popup.parentElement?.className ?? '',
        gap: above > 0 ? above : below,
        side: above > 0 ? 'above' : 'below',
        dx: popupBox.left - triggerBox.left,
        box: {
          top: popupBox.top,
          left: popupBox.left,
          right: popupBox.right,
          bottom: popupBox.bottom,
        },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }
    },
    { properties: SHELL_PROPERTIES },
  )

  // ---- The mechanism, first: the popup hangs off the shell and not off `body`. -----------------
  //
  // Nothing else in this file can be true if this is not, and it is the half a reader can check in
  // one line: `body` is outside `.shell`'s scope, `.shell` is inside it.
  expect(read.popupParent).toBe('shell')

  // ---- The equality: one setting, one answer, read off two elements. ---------------------------
  //
  // Every property `AppShell.vue` publishes is compared, including the three widths and the two
  // stacks this case never touches — a fix that moved four of them and left four would be a popup
  // that is half in the scope, which is the defect in a different shape.
  for (const name of SHELL_PROPERTIES) {
    expect(read.popup.properties[name], `the popup resolves ${name} to what the shell published`).toBe(
      read.shell.properties[name],
    )
  }

  // ---- And it is the *setting*, not the token that happens to be on both sides. ----------------
  //
  // The fence has to close in both directions: the equality above is also satisfied by a shell that
  // published nothing (both sides would be `:root`'s answer). So the shell's own value must be a
  // number the token block cannot produce, and the token's must be the documented fallback — which
  // is what makes the next lines a real fence rather than a restatement.
  expect(read.shell.properties['--app-body-size']).toBe(`${BODY_SIZE}px`)
  expect(read.token.properties['--app-body-size']).toBe('15px')
  expect(read.shell.properties['--app-line-height']).toBe(String(LINE_HEIGHT))
  expect(read.token.properties['--app-line-height']).toBe('1.8')
  expect(read.shell.properties['--app-font']).toContain('Source Serif 4')
  expect(read.token.properties['--app-font']).not.toContain('Source Serif 4')
  for (const name of DRIVEN) {
    expect(
      read.shell.properties[name],
      `the shell publishes ${name} at all, so the fence is about a value`,
    ).not.toBe('')
    expect(read.popup.properties[name], `${name} is not the page root's`).not.toBe(
      read.token.properties[name],
    )
  }

  // ---- The drawn half. -------------------------------------------------------------------------
  //
  // A property can be carried by an element that never uses it. These are what the engine painted,
  // read off the elements that resolve them: a row of the list against the shell, for the face (two
  // `font-family: var(--app-font)` declarations in two different stylesheets); the palette's own
  // `--app-text` for the words, against both the light number this defect drew and the dark one the
  // shell published; and the popup's face and shadow, against the light pair they used to be.
  expect(read.option.fontFamily).toBe(read.shell.fontFamily)
  expect(read.option.fontFamily).toContain('Source Serif 4')
  expect(read.option.fontFamily).not.toContain('system-ui')
  expect(read.option.color).toBe(DARK_TEXT)
  expect(read.option.color).not.toBe(LIGHT_TEXT)
  expect(read.option.color).toBe(read.trigger.color)
  // The light palette's elevated mix, measured: `#fffefb` toward `#f5f3ee`, which is what a popup
  // outside the scope painted. The dark one is a mix of `#243020` and `#1a2418`, so every channel
  // is below a half — a reading rather than a string, because the mix is `color-mix()`'s to make.
  expect(read.popup.background).not.toBe(LIGHT_FACE)
  const channels = read.popup.background.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []
  expect(channels, `the popup's face is a mix, read as ${read.popup.background}`).toHaveLength(3)
  expect(Math.max(...channels)).toBeLessThan(0.5)
  // The shadow is `--app-shadow-menu`, and the two themes' are different objects: the light one is
  // built on `rgb(37 33 27 / 18%)`, the dark one on black at 48%.
  expect(read.popup.boxShadow).not.toContain(LIGHT_SHADOW)
  expect(read.popup.boxShadow).toContain(DARK_SHADOW)
  // And the border is the dark `#3b4d36` at 86%, not the light `#e7e3db`.
  expect(read.popup.borderColor).not.toContain('0.905882')
  expect(read.popup.borderColor).toContain('0.231373')

  // ---- And the retarget did not move it. -------------------------------------------------------
  //
  // The popup is still `position: fixed` and still placed against its trigger by the recipe
  // (`SelectMenu.vue`'s `place()`): four pixels off the edge it opened from — above or below,
  // whichever has room — with its left edge on the trigger's, and all of it inside the window it
  // had to fit in. This half is why the popup is teleported at all: an ancestor that becomes a
  // containing block for fixed descendants (`transform`, `translate`, `filter`, `backdrop-filter`,
  // `contain`) would answer these coordinates from its own padding box instead, and the settings
  // overlay is already one of those (`SettingsPanel.vue`'s `backdrop-filter`, measured).
  //
  // The *side* is not asserted: it is the window's to decide from where the trigger happens to be
  // (`dropsDown`), and pinning it here would pin the harness's layout rather than the placement. The
  // four numbers below are the placement.
  expect(read.gap, `the popup hangs ${read.gap}px off the trigger, on the ${read.side}`).toBeCloseTo(4, 1)
  expect(Math.abs(read.dx)).toBeLessThanOrEqual(2)
  expect(read.box.left).toBeGreaterThanOrEqual(0)
  expect(read.box.right).toBeLessThanOrEqual(read.viewport.width)
  expect(read.box.top).toBeGreaterThanOrEqual(0)
  expect(read.box.bottom).toBeLessThanOrEqual(read.viewport.height)
})

/**
 * The same list, opened **while the page it is on is still arriving** — the defect the case above
 * cannot see, because it reads at rest.
 *
 * `SelectMenu.vue` re-placed only when the window resized or something scrolled, and the settings
 * page arrives through a `scale`/`translate` spring (`SettingsPanel.vue:347-355`), so a press made
 * during the arrival was placed against a trigger that went on moving and stayed there. It is the
 * same defect `ea160cd` fixed in `ComboBox.vue`, in the component that established the recipe —
 * which is the point: fixing one thing on a control is not the same as the control being right.
 *
 * ## The instrument, and the half of it that had to change
 *
 * **The press is forced.** `click()` runs actionability checks, one of which waits for the element
 * to hold still for two frames; a waited-for press therefore lands at the end of the spring, where
 * the residual movement is under a pixel and the check would pass for the wrong reason. Measured:
 * the forced press reproduced the drift on every run, the waited-for press did not. A reader's
 * press is neither — it lands the moment the field is visible, which is during the arrival.
 *
 * **The assertion is two independently measured values**: the list's own rect and the trigger's,
 * read in one `evaluate` after everything has come to rest. The recipe puts the list's left edge on
 * the trigger's and four pixels off the edge it opened from. Nothing here re-states a palette or a
 * number the component owns; a list that had followed a transform-carried trigger shows a `dx` of
 * exactly the distance that trigger still had to travel.
 *
 * The click path, hop by hop, is the one above plus the page swap:
 *
 *   `AppShell.vue:457` the status bar's settings button
 *   → `SettingsNavigation.vue:45` the AI row (`:22`), so the press below lands on a page that is
 *     still arriving rather than on one already at rest
 *   → `SettingsNavigation.vue:44` the appearance row, whose press starts the swap
 *   → `AppearanceSettings.vue:168` `#settings-ui-font` — a `SelectMenu` trigger, its press opening
 *     the list (`SelectMenu.vue:331`) — pressed with the reader's timing, not the checker's
 */
test('the select’s list follows its trigger through the settings page swap', async ({ page }) => {
  await openNote(page)
  await page.locator('.status-btn').last().click()
  await page.locator('.settings-overlay').waitFor({ state: 'visible', timeout: 5000 })

  // Settle on the AI page first. Without this the appearance row's press would be a no-op — the
  // dialog opens on the first page — and the select would be pressed at rest, which is the
  // reading the case above already makes.
  await page.locator('.dialog-nav .nav-row').nth(AI_ROW).click()
  await page.waitForTimeout(900)

  const content = page.locator('.dialog-content')
  await page.locator('.dialog-nav .nav-row').nth(APPEARANCE_ROW).click()
  await content.locator('#settings-ui-font').click({ force: true })
  await page.locator('.select-popup').waitFor({ state: 'visible', timeout: 5000 })
  // The spring, the list's own arrival and the last frame the follow loop reads: what is measured
  // is where the two boxes came to rest rather than where they were mid-flight.
  await page.waitForTimeout(1200)

  const read = await page.evaluate(() => {
    const popup = document.querySelector('.select-popup') as HTMLElement | null
    const trigger = document.querySelector('#settings-ui-font') as HTMLElement | null
    if (!popup || !trigger) throw new Error('the list or its trigger is not in the document')
    const a = trigger.getBoundingClientRect()
    const b = popup.getBoundingClientRect()
    // Which pair of edges to subtract is the side's to decide, and the side is read from the two
    // boxes' own centres rather than from the class the placement wrote — a list that had flipped
    // while its trigger moved past it would otherwise report a gap of the wrong sign.
    const side = b.top + b.height / 2 < a.top + a.height / 2 ? 'above' : 'below'
    return {
      gap: side === 'above' ? a.top - b.bottom : b.top - a.bottom,
      dx: b.left - a.left,
      side,
      inside: b.left >= 0 && b.right <= window.innerWidth && b.top >= 0
        && b.bottom <= window.innerHeight,
      rect: { top: b.top, left: b.left, right: b.right, bottom: b.bottom },
      triggerRect: { top: a.top, left: a.left, bottom: a.bottom },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }
  })

  expect(
    read.gap,
    `the list hangs ${read.gap}px off its trigger on the ${read.side}, list ${JSON.stringify(read.rect)} of trigger ${JSON.stringify(read.triggerRect)} in a ${read.viewport.width}x${read.viewport.height} window`,
  ).toBeCloseTo(4, 1)
  expect(Math.abs(read.dx), `the list’s left edge is ${read.dx}px off the trigger’s`).toBeLessThanOrEqual(2)
  expect(read.inside, `the list is inside the window: ${JSON.stringify(read.rect)}`).toBe(true)
})
