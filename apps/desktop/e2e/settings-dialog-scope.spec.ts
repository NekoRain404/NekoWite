/**
 * The settings dialog draws the user's appearance, not a token — measured as an equality.
 *
 * **The defect this file exists for.** `SettingsPanel.vue` teleported the whole dialog to `body`, and
 * `body` is outside `.shell` — the one element that carries the user's appearance: `AppShell.vue:285`
 * puts `data-theme`, `data-color-scheme`, `data-accent`, `data-contrast` and the seven inline
 * `--app-*` properties on it (`:271-280`), and nothing repeats them anywhere else in the page. A
 * child of `body` is outside every one of them, so the whole dialog resolved `palettes.css`'s `:root`
 * block instead: the light palette, `default` scheme, `ink` accent, `tokens.css`'s `15px`/`1.8` and
 * `system-ui`.
 *
 * Measured, Chromium, before the fix — the appearance driven through this very page's controls
 * (dark, `forest`, `teal`, 17px, leading 2, serif), the shell beside the dialog reading:
 *
 *   | property            | `.shell`    | dialog      | `:root`     |
 *   |---------------------|-------------|-------------|-------------|
 *   | `--app-elevated`    | `#243020`   | `#fffefb`   | `#fffefb`   |
 *   | `--app-text`        | `#e8f3e2`   | `#292a27`   | `#292a27`   |
 *   | `--app-accent`      | `#2e9e8f`   | `#343532`   | `#343532`   |
 *   | `--app-body-size`   | `17px`      | `15px`      | `15px`      |
 *   | `--app-line-height` | `2`         | `1.8`       | `1.8`       |
 *   | `--app-font`        | Source Serif 4 | system-ui | system-ui   |
 *
 * A user picked a theme, a colour scheme, an accent, a size and a font by looking at a dialog that
 * could show none of them — and four sibling dialogs in `AppDialogs.vue` were drawing all of them,
 * because they were never teleported. The dialog kept its teleport and lost only this.
 *
 * ## What this file measures, and how
 *
 * The bar is **the equality of two independently measured values**: `.shell`'s own cascade and the
 * dialog's, for one set of settings reached by clicking. Not "the dialog is dark" — a dialog given a
 * second table of its own would pass that. Everything is driven through the real controls, in the
 * order a user reaches them:
 *
 *   `AppShell.vue:457` status bar's settings button → `App.vue`'s `showSettings`
 *   → `AppDialogs.vue:74` mounts `SettingsPanel`
 *   → `SettingsNavigation.vue:45` the second rail row (appearance)
 *   → `AppearanceSettings.vue:87` dark / `:111` the `forest` card / `:140` the `teal` swatch
 *      / `:214` the size field / `:225` the leading field / `:168` the interface-font select.
 *
 * The `.dialog-nav` reading is the drawn half, and it is a pair rather than a property: the rail
 * declares `font-family: var(--app-font)` (`SettingsNavigation.vue:87`) and so does `.shell`
 * (`app/appShell-chrome.css:37`, moved there from `AppShell.vue`'s inline block) — two elements, two
 * stylesheets, one `var()`, so the engine settles it.
 *
 * Nothing here claims anything about WebKitGTK; `e2e/webkit/pet-probe.mjs` carries the same
 * measurement in the engine that ships.
 */
import { expect, test, type Page } from '@playwright/test'
import { openNote } from './support/editorHarness'

/** The seven properties the shell publishes, in the order `AppShell.vue:271-280` writes them. */
const SHELL_PROPERTIES = [
  '--app-sidebar-width',
  '--app-rail-width',
  '--app-notelist-width',
  '--app-body-size',
  '--app-line-height',
  '--app-font',
  '--app-mono-font',
] as const

/**
 * The three of them this case drives away from their clean-install value, and therefore the three
 * the "not the page root's" fence can be stated for. The other four are compared for equality only:
 * a column width is the window's (dragged on the layout's own handle) and the monospace stack is
 * unchanged here, so their two answers are the same number and a `not.toBe` would assert nothing.
 */
const DRIVEN = ['--app-body-size', '--app-line-height', '--app-font'] as const

/** The appearance the case drives the controls to, and the reason each value is not the default. */
const BODY_SIZE = 17
const LINE_HEIGHT = 2
const UI_FONT = 'serif'

/**
 * What one surface resolved, and where it stands.
 *
 * `properties` is read with `getComputedStyle(el).getPropertyValue(…)` on the element itself, so the
 * answer is "what this element's own cascade settled on" — for `.shell` that is the inline style
 * `AppShell.vue` wrote, and for the dialog that is whatever it inherited from it.
 */
interface SurfaceReading {
  /** The seven published properties, as CSS text ('' when the surface cannot see one at all). */
  properties: Record<string, string>
  fontFamily: string
  fontSize: string
  color: string
  background: string
}

interface ScopeReading {
  /** `.shell` — the element that carries the setting. */
  shell: SurfaceReading
  /** The dialog's own box, inside the overlay. */
  dialog: SurfaceReading
  /** The rail inside the dialog, whose `font-family` is the drawn half of the same declaration. */
  nav: SurfaceReading
  /** `document.documentElement` — where a surface outside `.shell` resolves these from. */
  token: SurfaceReading
  /** Where the overlay ended up in the DOM, for the fence on the mechanism itself. */
  overlayParent: string
}

/**
 * Open the settings dialog and drive the appearance to a value the token block cannot produce.
 *
 * The values are deliberately all *not* the clean-install ones: `17` is not the default 15, `2` is
 * not 1.8, `forest` is not `default`, `teal` is not `ink`, `serif` is not `system`, and dark is not
 * what a page with no `data-theme` resolves. A dialog that read any token would land on the default
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

  // The two numeric fields, through the same `@change` a blur produces.
  const size = content.locator('input[type="number"]').first()
  await size.fill(String(BODY_SIZE))
  await size.press('Enter')
  const leading = content.locator('input[type="number"]').nth(1)
  await leading.fill(String(LINE_HEIGHT))
  await leading.press('Enter')

  // `AppearanceSettings.vue:168` — the interface font, a `SelectMenu`: trigger, then option. The
  // popup is the component's own (teleported to `body` by `SelectMenu.vue:297`, which is reported
  // rather than fixed here — see this file's header), and its option carries the store's id.
  await content.locator('#settings-ui-font').click()
  await page.locator('.select-popup .select-option[data-value="' + UI_FONT + '"]').click()
}

test('the settings dialog resolves the appearance the shell carries, value for value', async ({
  page,
}) => {
  await openNote(page)
  await openAppearanceWithOwnValues(page)

  const read = await page.evaluate(
    ({ properties }: { properties: readonly string[] }): ScopeReading => {
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
        }
      }
      const overlay = document.querySelector('.settings-overlay')
      return {
        shell: surface('.shell'),
        dialog: surface('.settings-dialog'),
        nav: surface('.dialog-nav'),
        token: surface(':root'),
        overlayParent: overlay?.parentElement?.className ?? '',
      }
    },
    { properties: SHELL_PROPERTIES },
  )

  // ---- The mechanism, first: the dialog hangs off the shell and not off `body`. ----------------
  //
  // Nothing else in this file can be true if this is not, and it is the half a reader can check in
  // one line: `body` is outside `.shell`'s scope, `.shell` is inside it.
  expect(read.overlayParent).toBe('shell')

  // ---- The equality: one setting, one answer, read off two elements. ---------------------------
  //
  // Every property `AppShell.vue` publishes is compared, including the three widths and the two
  // font stacks the dialog also reads — a fix that moved four of them and left three would be a
  // dialog that is half in the scope, which is the defect in a different shape.
  for (const name of SHELL_PROPERTIES) {
    expect(
      read.dialog.properties[name],
      `the dialog resolves ${name} to what the shell published`,
    ).toBe(read.shell.properties[name])
  }

  // ---- And it is the *setting*, not the token that happens to be on both sides. ----------------
  //
  // The fence has to close in both directions: the equality above is also satisfied by a shell that
  // published nothing (both sides would be `:root`'s answer). So the shell's own value must be a
  // number the token block cannot produce, and the token's must be the documented fallback — which
  // is what makes the next line a real fence rather than a restatement.
  expect(read.shell.properties['--app-body-size']).toBe(`${BODY_SIZE}px`)
  expect(read.token.properties['--app-body-size']).toBe('15px')
  expect(read.shell.properties['--app-line-height']).toBe(String(LINE_HEIGHT))
  expect(read.token.properties['--app-line-height']).toBe('1.8')
  expect(read.shell.properties['--app-font']).toContain('Source Serif 4')
  expect(read.token.properties['--app-font']).not.toContain('Source Serif 4')
  // And the three this case moved, against the page root as well: the dialog is not merely equal to
  // the shell, it is *not* the block a surface outside the scope resolves. This is the half that
  // fails if the teleport comes back, and it fails with the numbers the defect was measured at.
  //
  // Only the three, because the fence needs the two answers to differ: this case does not resize a
  // column (the widths are the window's, dragged on the layout's handles), so their clean-install
  // values are the token's and `not.toBe` there would assert nothing.
  for (const name of DRIVEN) {
    expect(
      read.shell.properties[name],
      `the shell publishes ${name} at all, so the fence is about a value`,
    ).not.toBe('')
    expect(read.dialog.properties[name], `${name} is not the page root's`).not.toBe(
      read.token.properties[name],
    )
  }

  // ---- The drawn half. -------------------------------------------------------------------------
  //
  // A property can be carried by an element that never uses it. These four are what the engine
  // painted: two `font-family: var(--app-font)` declarations in two different stylesheets, one on
  // each side of the seam (`app/appShell-chrome.css:37`, `SettingsNavigation.vue:87`), and the two
  // colours `SettingsPanel.vue`'s own rules resolve — `color: var(--app-text)` and the
  // elevated/panel mix the dialog paints its face with.
  expect(read.nav.fontFamily).toBe(read.shell.fontFamily)
  expect(read.nav.fontFamily).toContain('Source Serif 4')
  // The dialog's text is the dark forest `--app-text` (`#e8f3e2`) and not the `#292a27` it drew
  // while it was outside the scope — the two numbers a fallback would land on, one of them the
  // literal the pet preview's own case fences its colours with.
  expect(read.dialog.color).toBe('rgb(232, 243, 226)')
  expect(read.dialog.color).not.toBe('rgb(41, 42, 39)')
  // And its face is a dark mix of `#243020`, not the near-white the light `--app-elevated` gives.
  const dialogBackground = read.dialog.background
  expect(dialogBackground).not.toBe('color(srgb 0.998824 0.994784 0.982784)')
  const channels = dialogBackground.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []
  expect(channels, `the dialog's face is a mix, read as ${dialogBackground}`).toHaveLength(3)
  expect(Math.max(...channels)).toBeLessThan(0.5)
})
