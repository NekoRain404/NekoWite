/**
 * Every detached popup the app draws resolves the appearance the *shell* carries — measured as an
 * equality, one surface at a time.
 *
 * **The family this file exists for.** `AppShell.vue:285-292` puts `data-theme`,
 * `data-color-scheme`, `data-accent`, `data-contrast` and the eight inline `--app-*` properties on
 * the `.shell` element and nowhere else in the page. A surface rendered under `body` is therefore
 * outside the element that carries the user's appearance, and resolves `palettes.css`'s `:root`
 * block instead: the light palette, the `ink` accent and the default face inside a window the user
 * has told to draw a dark `forest` in Source Serif 4. `780ec5c` fixed the app's 22 selects
 * (`components/SelectMenu.vue`) and `f865e2b` the settings dialog; this file is four of the seven
 * surfaces that commit named, and `e2e/agent-popup-host-scope.spec.ts` carries the three that
 * belong to the agent panel.
 *
 * | surface                | the teleport it used to make          |
 * |------------------------|---------------------------------------|
 * | the tab's context menu | `ui/ContextMenu.vue:164`              |
 * | the command palette    | `ui/CommandPalette.vue:255`           |
 * | the layout guide line  | `ui/LayoutResizeHandle.vue:218`       |
 * | the AI model combobox  | `components/ComboBox.vue:305`         |
 *
 * **What this file measures, and how.** The bar is `780ec5c`'s: **the equality of two
 * independently measured values**, obtained by driving the real controls to an appearance the
 * token block cannot produce and then reading the popup's own cascade against `.shell`'s and
 * against `:root`'s. Not "the popup is dark" — a popup given a second table of its own would pass
 * that — and not "it differs from the old value". Each case therefore asserts four things:
 *
 *  1. **the mechanism**: the popup is a descendant of `.shell`, which nothing else in the page is;
 *  2. **the equality**: all thirteen properties resolve on the popup to what the shell published —
 *     the eight it writes inline (`AppShell.vue:271-280`) and the five its four `data-*` axes
 *     select out of `palettes.css`. A fix that moved four of the eight and left four would be a
 *     popup half in the scope, which is this defect in a different shape;
 *  3. **the fence**: every driven property is *not* the page root's, and the token block's own
 *     values are its documented fallbacks — without this the equality above is also satisfied by a
 *     shell that published nothing, both sides being `:root`'s answer;
 *  4. **the drawn half**: what the engine painted, read off elements that resolve the properties —
 *     a row against a control beside it that declares the same `var(--app-text)`, and the face and
 *     the shadow against the light pair they used to be. The guide line has neither a face nor
 *     text of its own, so it gets the change fence instead: the same drag is read twice with the
 *     accent driven to two different values, and the drawing has to follow.
 *
 * Everything is driven through the real controls, and every case names its click path with
 * `file:line` at each hop, because "a user can reach it" is the acceptance rather than a claim
 * about the component in isolation:
 *
 *   `AppShell.vue:456` the status bar's settings button → `App.vue`'s `showSettings`
 *   → `AppDialogs.vue:74` mounts `SettingsPanel`
 *   → `SettingsNavigation.vue:17-24` the rail rows the cases below click
 *   → `AppearanceSettings.vue:87` dark / `:111` the `forest` card / `:140` the accent swatches
 *      / `:214` the body-size field / `:225` the leading field / `:168` the interface-font select
 *   → `stores/appearance.ts` → `AppShell.vue:271-292`, the element every case reads.
 *
 * Nothing here claims anything about WebKitGTK; `e2e/webkit/pet-probe.mjs` carries the same
 * measurement in the engine that ships, and names it there.
 */
import { expect, test, type Page } from '@playwright/test'
import { openNote } from './support/editorHarness'

/** The eight properties `AppShell.vue:271-280` publishes, in the order it writes them. */
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
 * The five properties `AppShell.vue` never writes: they come from the four `data-*` axes it
 * carries, through `palettes.css`'s blocks, and they are the ones a popup outside the shell gets
 * *wrong* — the light `--app-elevated`, the light `--app-text`, the `ink` `--app-accent`, the light
 * `--app-border` and the light `--app-shadow-menu` (`780ec5c`'s own table).
 *
 * Every one of them is driven here, so every one carries both halves of the claim.
 */
const PALETTE_PROPERTIES = [
  '--app-elevated',
  '--app-text',
  '--app-accent',
  '--app-border',
  '--app-shadow-menu',
] as const

/**
 * The three the page root can be fenced against individually. The other five are compared for
 * equality only: a column width is the window's (dragged on the layout's own handle) and the two
 * stacks resolve to the same string on both sides, so a `not.toBe` would assert nothing.
 */
const DRIVEN = ['--app-body-size', '--app-line-height', '--app-font'] as const

/** The appearance the cases drive the controls to, and why each value is not the default. */
const BODY_SIZE = 17
const LINE_HEIGHT = 2
const UI_FONT = 'serif'

/** The dark `forest` `--app-text` and the light palette's, which is what a stray row draws. */
const DARK_TEXT = 'rgb(232, 243, 226)'
const LIGHT_TEXT = 'rgb(41, 42, 39)'
/** The light palette's elevated mix, which is what a surface outside the shell paints. */
const LIGHT_FACE = 'color(srgb 0.998431 0.994353 0.982275)'
/** The two themes' `--app-shadow-menu` are different objects: this is how they differ. */
const LIGHT_SHADOW = 'rgba(37, 33, 27,'
const DARK_SHADOW = 'rgba(0, 0, 0,'

/** The settings dialog's rail rows, by the order `SettingsNavigation.vue:17-24` declares them. */
const APPEARANCE_ROW = 1
const AI_ROW = 4

interface SurfaceReading {
  /** The thirteen published and palette properties, as CSS text ('' when it cannot see one). */
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
  /** `document.documentElement` — where a popup outside `.shell` resolves these from. */
  token: SurfaceReading
  /** The popup's own box, wherever it was rendered. */
  popup: SurfaceReading
  /** The popup's `parentElement.className`, for the fence on the mechanism itself. */
  parent: string
  /** Whether the popup is inside the element that carries the appearance. */
  inShell: boolean
  /** One row (or the text control) of the surface — what a user reads. */
  row: SurfaceReading | null
  /** A control that lives inside the shell and resolves the same property as {@link row}. */
  reference: SurfaceReading | null
}

/** Open the settings dialog on the appearance page — the door every case below comes through. */
async function openAppearance(page: Page): Promise<void> {
  // `AppShell.vue:456` — the status bar's own settings button, the last of the two.
  await page.locator('.status-btn').last().click()
  await page.locator('.settings-overlay').waitFor({ state: 'visible', timeout: 5000 })
  // `SettingsNavigation.vue:17-24` — the rail's rows, by id order.
  await page.locator('.dialog-nav .nav-row').nth(APPEARANCE_ROW).click()
  await page.locator('.dialog-content').waitFor({ state: 'visible', timeout: 5000 })
}

/** Close the dialog without committing anything: Escape, which `useModalEscape` owns. */
async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.locator('.settings-overlay').waitFor({ state: 'detached', timeout: 5000 })
}

/**
 * Drive the appearance to values the token block cannot produce, through the controls a user
 * presses.
 *
 * `17` is not the default 15, `2` is not 1.8, `forest` is not `default`, `teal` is not `ink`,
 * `serif` is not `system`, and dark is not what a page with no `data-theme` resolves — so a popup
 * that read any token lands on the default of every one of them, which is what the fences look for.
 */
async function driveAppearance(page: Page, accent = 'teal'): Promise<void> {
  const content = page.locator('.dialog-content')
  await content.locator('.view-modes .switch-option').nth(1).click() // dark
  await content.locator('.color-scheme-card[data-scheme="forest"]').click()
  await content.locator(`.accent-swatch[aria-label="${accent}"]`).click()

  // The two numeric fields, through the same `@change` a blur produces.
  const size = content.locator('input[type="number"]').first()
  await size.fill(String(BODY_SIZE))
  await size.press('Enter')
  const leading = content.locator('input[type="number"]').nth(1)
  await leading.fill(String(LINE_HEIGHT))
  await leading.press('Enter')

  // The interface font: the select's trigger, then the row the store knows by id.
  await content.locator('#settings-ui-font').click()
  await page.locator('.select-popup').waitFor({ state: 'visible', timeout: 5000 })
  await page.locator('.select-popup .select-option[data-value="' + UI_FONT + '"]').click()
  await page.locator('.select-popup').waitFor({ state: 'detached', timeout: 5000 })

  // The shell has to have taken all of it before anything is measured against it.
  await page.waitForFunction(
    ({ size: wanted, leading: wantedLeading, font }) => {
      const shell = document.querySelector('.shell')
      if (!shell) return false
      const style = getComputedStyle(shell)
      return style.getPropertyValue('--app-body-size').trim() === wanted
        && style.getPropertyValue('--app-line-height').trim() === wantedLeading
        && style.fontFamily.includes(font)
    },
    { size: `${BODY_SIZE}px`, leading: String(LINE_HEIGHT), font: 'Source Serif' },
    { timeout: 5000 },
  )
}

/**
 * Read one popup, its shell and the page root, plus an optional two-element pair inside the
 * surface (a row against a control that resolves the same property).
 *
 * One `evaluate` and not three: three round-trips can describe three different moments.
 */
async function readPopup(
  page: Page,
  selectors: { popup: string, row?: string, reference?: string },
): Promise<PopupReading> {
  return page.evaluate(
    ({ properties, popup, row, reference }: {
      properties: readonly string[]
      popup: string
      row?: string
      reference?: string
    }): PopupReading => {
      const surface = (selector: string): SurfaceReading => {
        const el = selector === ':root'
          ? document.documentElement
          : document.querySelector(selector)
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
      const element = document.querySelector(popup)
      if (!element) throw new Error(`no element for ${popup}`)
      return {
        shell: surface('.shell'),
        token: surface(':root'),
        popup: surface(popup),
        parent: element.parentElement?.className ?? '',
        inShell: element.closest('.shell') !== null,
        row: row === undefined ? null : surface(row),
        reference: reference === undefined ? null : surface(reference),
      }
    },
    {
      properties: [...SHELL_PROPERTIES, ...PALETTE_PROPERTIES],
      popup: selectors.popup,
      row: selectors.row,
      reference: selectors.reference,
    },
  )
}

/**
 * The three claims every case makes, held to one surface.
 *
 * `where` is the surface's name and is in every failure message, because a reader who sees "the
 * popup resolves `--app-font` to what the shell published" fail needs to know which popup.
 */
function assertSurface(read: PopupReading, where: string): void {
  // ---- 1. The mechanism, first: nothing below can be true if this is not. ----------------------
  expect(read.inShell, `${where}: the popup is drawn inside the element that carries the appearance`)
    .toBe(true)

  // ---- 2. The equality: one setting, one answer, read off two elements. ------------------------
  //
  // The eight properties the shell publishes inline, and the five the four `data-*` axes it
  // carries select out of `palettes.css`. Both halves are the same claim and both are needed.
  for (const name of [...SHELL_PROPERTIES, ...PALETTE_PROPERTIES]) {
    expect(
      read.popup.properties[name],
      `${where}: the popup resolves ${name} to what the shell published`,
    ).toBe(read.shell.properties[name])
  }

  // ---- 3. And it is the *setting*, not the token that happens to be on both sides. -------------
  //
  // The fence has to close in both directions: the equality above is also satisfied by a shell
  // that published nothing (both sides would be `:root`'s answer). So the shell's own values must
  // be numbers the token block cannot produce, and the token's must be the documented fallback.
  expect(read.shell.properties['--app-body-size'], `${where}: the shell publishes the driven size`)
    .toBe(`${BODY_SIZE}px`)
  expect(read.token.properties['--app-body-size'], `${where}: the page root's fallback`)
    .toBe('15px')
  expect(read.shell.properties['--app-line-height'], `${where}: the shell publishes the leading`)
    .toBe(String(LINE_HEIGHT))
  expect(read.token.properties['--app-line-height'], `${where}: the page root's fallback`)
    .toBe('1.8')
  for (const name of [...DRIVEN, ...PALETTE_PROPERTIES]) {
    expect(read.popup.properties[name], `${where}: ${name} is not the page root's`)
      .not.toBe(read.token.properties[name])
  }
}

/**
 * The drawn half, where the surface paints a face of its own: the box, and the words in it.
 *
 * The text colour is a *pair* where the surface has a control beside it: two elements in two
 * stylesheets that each declare `color: var(--app-text)`, so the agreement is the engine's answer
 * and not a table this file wrote down twice.
 */
function assertDrawn(
  read: PopupReading,
  where: string,
  options: { face?: boolean, shadow?: boolean, textPair?: boolean } = {},
): void {
  if (options.face === true) {
    expect(read.popup.background, `${where}: the face is not the light palette's elevated`)
      .not.toBe(LIGHT_FACE)
    const channels = read.popup.background.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []
    expect(channels, `${where}: the face is a mix, read as ${read.popup.background}`).toHaveLength(3)
    expect(Math.max(...channels), `${where}: the face is dark, read as ${read.popup.background}`)
      .toBeLessThan(0.5)
  }
  if (options.shadow === true) {
    expect(read.popup.boxShadow, `${where}: the shadow is not the light palette's`)
      .not.toContain(LIGHT_SHADOW)
    expect(read.popup.boxShadow, `${where}: the shadow is the dark one`).toContain(DARK_SHADOW)
  }
  if (options.textPair !== true) return
  if (read.row === null || read.reference === null) throw new Error(`${where}: no pair to read`)
  // `.tab` never left the shell, so it is the half of the pair that was always right.
  expect(read.row.color, `${where}: a row draws the colour the control beside it draws`)
    .toBe(read.reference.color)
  expect(read.row.color, `${where}: which is the dark palette's text`).toBe(DARK_TEXT)
  expect(read.row.color, `${where}: and not the light one`).not.toBe(LIGHT_TEXT)
}

test('the context menu a right click on a tab opens resolves the shell’s appearance', async ({
  page,
}) => {
  await openNote(page)
  await openAppearance(page)
  await driveAppearance(page)
  await closeDialog(page)

  // `ui/TabBar.vue:130-142` — the tab, whose own `@contextmenu` opens the menu at the pointer and
  // hands the press to `ui/ContextMenu.vue`'s teleport.
  await page.locator('.tab').first().click({ button: 'right' })
  await page.locator('.ctx-menu').waitFor({ state: 'visible', timeout: 5000 })

  const read = await readPopup(page, {
    popup: '.ctx-menu',
    row: '.ctx-menu-item',
    // The tab the menu was opened on: `ui/TabBar.vue:241` declares the same `color: var(--app-text)`
    // the menu's rows do (`ui/ContextMenu.vue:294`).
    reference: '.tab',
  })
  assertSurface(read, 'the context menu')
  assertDrawn(read, 'the context menu', { face: true, shadow: true, textPair: true })
  // And the border is the dark `#3b4d36` at 86%, not the light `#e7e3db`.
  expect(read.popup.borderColor, 'the context menu: the border is the dark one')
    .toContain('0.231373')
  expect(read.popup.borderColor, 'the context menu: and not the light one')
    .not.toContain('0.905882')
})

test('the command palette resolves the shell’s appearance', async ({ page }) => {
  await openNote(page)
  await openAppearance(page)
  await driveAppearance(page)
  await closeDialog(page)

  // `ui/CommandPalette.vue:202-221` — the app's own Ctrl+K listener, which is the only door to
  // this surface: the palette has no control and no trigger to hang off.
  await page.keyboard.press('Control+k')
  await page.locator('.palette-overlay.is-open').waitFor({ state: 'visible', timeout: 5000 })
  // The overlay's own arrive settles before the rect and the paint are read.
  await page.waitForTimeout(400)

  const read = await readPopup(page, {
    popup: '.palette-overlay',
    row: '.palette-input',
    reference: '.tab',
  })
  assertSurface(read, 'the command palette')
  assertDrawn(read, 'the command palette', { textPair: true })

  // The palette's *box* is the dialog, not the overlay: the overlay's own background is a
  // translucent scrim over the whole window, and the dialog inside it is what carries the face.
  const box = await page.evaluate(() => {
    const palette = document.querySelector('.palette')
    const overlay = document.querySelector('.palette-overlay')
    if (!palette || !overlay) throw new Error('the palette drew no dialog')
    const cs = getComputedStyle(palette)
    const rect = overlay.getBoundingClientRect()
    return {
      background: cs.backgroundColor,
      boxShadow: cs.boxShadow,
      fontFamily: cs.fontFamily,
      inShell: palette.closest('.shell') !== null,
      // The overlay is `inset: 0` against its containing block, which has to be the window for a
      // full-screen modal to be full-screen. A containing block that is an ancestor's padding box
      // (`transform`, `filter`, `backdrop-filter`, `contain`) would answer with a smaller one —
      // which is the half of dropping this teleport that has to be measured rather than assumed.
      covers: rect.width >= window.innerWidth && rect.height >= window.innerHeight
        && rect.left <= 0 && rect.top <= 0,
      overlay: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }
  })
  expect(box.inShell, 'the palette’s own box is inside the shell').toBe(true)
  expect(box.fontFamily, 'the palette draws the face the shell draws').toBe(read.shell.fontFamily)
  expect(box.fontFamily, 'which is Source Serif 4').toContain('Source Serif 4')
  expect(box.fontFamily, 'and not the default stack').not.toContain('system-ui')
  expect(box.background, 'the dialog’s face is not the light palette’s').not.toBe(LIGHT_FACE)
  expect(box.boxShadow, 'and its shadow is the dark one').toContain(DARK_SHADOW)
  expect(
    box.covers,
    `the overlay fills the window: ${JSON.stringify(box.overlay)} against a ${box.viewport.width}x${box.viewport.height} viewport`,
  ).toBe(true)
})

test('the layout drag guide line resolves the shell’s appearance', async ({ page }) => {
  await openNote(page)
  await openAppearance(page)
  await driveAppearance(page)
  await closeDialog(page)

  // `AppShell.vue:439-455` — the status bar's first button, whose `toggle-rail` is what puts a
  // `LayoutResizeHandle` on screen (`AppShell.vue:387`, guarded by `railOpen`, which `App.vue:42`
  // starts false).
  await page.locator('.status-btn').first().click()
  const handle = page.locator('.layout-resize-handle').last()
  await handle.waitFor({ state: 'visible', timeout: 5000 })

  const teal = await dragAndRead(page, handle, '.resize-guide-line')
  assertSurface(teal, 'the guide line')
  // The line has no text and no face of its own: what it draws is
  // `color-mix(in srgb, var(--app-accent) 62%, transparent)`, so its resolved `--app-accent` —
  // asserted against the shell's, and against the page root's, above — *is* the drawn value's
  // source. What is left is that a line was drawn at all, and that its drawing follows the accent
  // the user picked, which is the change below.
  expect(
    teal.popup.background,
    `the guide line is drawn, read as ${teal.popup.background}`,
  ).not.toBe('rgba(0, 0, 0, 0)')

  // The accent moved through its own swatch, and the same drag is read again: a surface that
  // resolves the accent from outside the shell answers the same colour at both settings, which is
  // this defect's signature rather than a fence invented for it.
  await openAppearance(page)
  await page.locator('.dialog-content .accent-swatch[aria-label="coral"]').click()
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('.shell') as Element)
      .getPropertyValue('--app-accent').trim() === '#d65f4d',
    undefined,
    { timeout: 5000 },
  )
  await closeDialog(page)
  const coral = await dragAndRead(page, handle, '.resize-guide-line')
  assertSurface(coral, 'the guide line')
  expect(
    coral.popup.background,
    `the guide line follows the accent: teal drew ${teal.popup.background}, coral drew ${coral.popup.background}`,
  ).not.toBe(teal.popup.background)
})

/** One drag of one handle, read while the guide line is up. The line only exists mid-drag. */
async function dragAndRead(
  page: Page,
  handle: ReturnType<Page['locator']>,
  guide: string,
): Promise<PopupReading> {
  const box = await handle.boundingBox()
  if (box === null) throw new Error('the rail’s handle has no box to drag')
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(box.x - 40, y)
  await page.locator(guide).waitFor({ state: 'visible', timeout: 5000 })
  const read = await readPopup(page, { popup: guide })
  await page.mouse.up()
  await page.locator(guide).waitFor({ state: 'detached', timeout: 5000 })
  return read
}

/**
 * Everything `document.body` holds, split into what draws and what cannot.
 *
 * One `evaluate`, and it walks `body` rather than reading `.shell`'s subtree: the claim is about
 * what is *outside* the element that carries the appearance, and a search rooted at the shell could
 * not see it.
 */
async function strays(page: Page): Promise<{
  drawn: string[]
  inert: string[]
  bodyChildren: string[]
  appChildren: string[]
}> {
  return page.evaluate(() => {
    const shell = document.querySelector('.shell')
    if (!shell) throw new Error('the app drew no shell')
    // The tags that cannot paint. A node that is not one of these and is outside `.shell` is a
    // surface resolving the appearance from somewhere the user's setting never reached.
    const inertTags = new Set(['script', 'style', 'link', 'template', 'noscript'])
    const drawn: string[] = []
    const inert: string[] = []
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (shell.contains(el)) continue
      const tag = el.tagName.toLowerCase()
      if (inertTags.has(tag)) {
        inert.push(tag)
        continue
      }
      const name = `${tag}${el.id === '' ? '' : `#${el.id}`}${el.className === '' ? '' : `.${String(el.className)}`}`
      // `#app` is the mount point, not a surface: `Vue`'s container, transparent and empty of
      // anything but the shell. Everything else here is a defect.
      if (el.id !== 'app') drawn.push(name)
    }
    return {
      drawn,
      inert,
      bodyChildren: Array.from(document.body.children).map((c) => c.tagName.toLowerCase()),
      appChildren: Array.from(document.getElementById('app')?.children ?? []).map(
        (c) => `${c.tagName.toLowerCase()}${c.className === '' ? '' : `.${String(c.className)}`}`,
      ),
    }
  })
}

/**
 * `styles/style.css`'s `body` declaration is gone, and this is the measurement that makes its
 * removal safe rather than tidy.
 *
 * It read `font-family: var(--app-font); font-size: var(--app-body-size); line-height:
 * var(--app-line-height)` — the user's three settings, stated on an element *outside* `.shell`. What
 * kept a copy there was this family: a surface teleported to `body` had no `.shell` ancestor to
 * inherit from, so the declaration was the only thing that reached it. With every member rendering
 * inside the shell, a declaration on `body` reaches exactly `#app`, whose only child is `.shell`
 * (`App.vue:143`) and which declares all three itself (`appShell-chrome.css:51-53`).
 *
 * So the claim is not about a property value at all: **nothing the app draws is outside the
 * element that carries the appearance**, checked with each of this file's surfaces on screen. The
 * pet window's page, which has no shell, does not load `style.css` — `app/desktop-pet-entry.ts`
 * imports `tokens.css` and `palettes.css` and nothing else — so there is no second page for the
 * removed declaration to have been serving.
 */
test('nothing the app draws is rendered outside the element that carries the appearance', async ({
  page,
}) => {
  await openNote(page)
  await openAppearance(page)
  await driveAppearance(page)
  await closeDialog(page)

  // The invariant is checked with a surface up and with none: an empty page proves nothing about
  // where a popup went, and the two readings together are what say no *node* is ever outside.
  const idle = await strays(page)

  // `ui/TabBar.vue:142` — the context menu, the member that was measured drawing a light menu.
  await page.locator('.tab').first().click({ button: 'right' })
  await page.locator('.ctx-menu').waitFor({ state: 'visible', timeout: 5000 })
  const withMenu = await strays(page)
  await page.keyboard.press('Escape')
  await page.locator('.ctx-menu').waitFor({ state: 'detached', timeout: 5000 })

  // `ui/CommandPalette.vue` — the palette, raised over everything by Ctrl+K.
  await page.keyboard.press('Control+k')
  await page.locator('.palette-overlay.is-open').waitFor({ state: 'visible', timeout: 5000 })
  const withPalette = await strays(page)

  for (const [name, read] of [['idle', idle], ['with the context menu up', withMenu], ['with the palette up', withPalette]] as const) {
    expect(
      read.drawn,
      `${name}: no element outside the shell draws (${JSON.stringify(read)})`,
    ).toEqual([])
    expect(
      read.appChildren,
      `${name}: and the mount point holds the shell and nothing else`,
    ).toEqual(['div.shell'])
  }
  // The body itself holds the mount point and, on the dev server, the `<script>` Vite injects —
  // which is one of the tags that cannot paint and is why the split above is by tag.
  expect(
    idle.bodyChildren.filter((tag) => !['script', 'style', 'link'].includes(tag)),
    `the shell is the only thing on the page body (${JSON.stringify(idle.bodyChildren)})`,
  ).toEqual(['div'])

  // ---- And the blast radius, the way the fix it belongs to was measured. -----------------------
  //
  // The structural half above says nothing draws outside the shell; this half says the removed
  // declaration had nothing left to *do* inside it either. The old rule is injected back into the
  // live page and every element in `.shell` is read before and after: a declaration that is still
  // load-bearing moves something, and "at the defaults nothing moves" is the number `780ec5c`
  // recorded for the pair it added to `.shell` — this is the same measurement for the copy it left
  // on `body`.
  const blast = await page.evaluate(() => {
    const shell = document.querySelector('.shell')
    if (!shell) throw new Error('the app drew no shell')
    const read = (): string[] =>
      Array.from(shell.querySelectorAll('*')).map((el) => {
        const cs = getComputedStyle(el)
        return `${cs.fontSize}|${cs.lineHeight}|${cs.fontFamily}`
      })
    const before = read()
    const bodyBefore = getComputedStyle(document.body).fontSize
    // The rule verbatim as `style.css` carried it, with the values it resolved to outside `.shell`.
    const style = document.createElement('style')
    style.textContent =
      'body { font-family: var(--app-font); font-size: var(--app-body-size); line-height: var(--app-line-height); }'
    document.head.append(style)
    const after = read()
    // Read *before* the rule is taken away again: a reading taken after the removal describes the
    // page without it, which would make this fence vacuous — measured, it did.
    const bodyAfter = getComputedStyle(document.body).fontSize
    style.remove()
    return {
      elements: before.length,
      moved: before.filter((value, index) => value !== after[index]).length,
      bodyBefore,
      bodyAfter,
    }
  })
  expect(
    blast.moved,
    `re-stating the declaration on body moves nothing inside the shell (${blast.elements} elements read; body ${blast.bodyBefore} → ${blast.bodyAfter})`,
  ).toBe(0)
  // And it *does* move the body itself, which is the half that says the injection was live rather
  // than a no-op test: the rule resolves on `body` to the token block, exactly as it used to.
  expect(
    blast.bodyAfter,
    `the re-injected rule reached the body (${blast.bodyBefore} → ${blast.bodyAfter})`,
  ).not.toBe(blast.bodyBefore)
  expect(blast.bodyAfter).toBe('15px')
})

test('the AI model combobox’s list resolves the shell’s appearance', async ({ page }) => {
  await openNote(page)
  await openAppearance(page)
  await driveAppearance(page)

  // `SettingsNavigation.vue:22` — the AI row, the fifth of the rail's own order.
  await page.locator('.dialog-nav .nav-row').nth(AI_ROW).click()
  const content = page.locator('.dialog-content')
  // `AiSettings.vue:90-97` — the model field, the app's only `ComboBox`. Its own press opens the
  // list (`ComboBox.vue:302`), which is the `Teleport` this case is about.
  //
  // **The press is forced, and that is the fix's own instrument.** `click()` runs actionability
  // checks, one of which waits for the element to hold still for two frames — and the AI page
  // arrives through a `scale`/`translate` spring (`SettingsPanel.vue:347-355`), so a waited-for
  // press lands either before or after the field has come to rest depending on the frame it
  // catches. Measured here: the forced press reproduced the drift on three runs out of three, while
  // the waited-for press read the settled 4px on one run and the drifted 20.719px on another. A
  // reader's press is neither — it lands the moment the field is visible, which is during the
  // arrival, which is what this now measures.
  await content.locator('#settings-ai-model').click({ force: true })
  await page.locator('.combo-popup').waitFor({ state: 'visible', timeout: 5000 })
  // The list travels on a transform; a rect read mid-flight is a reading of the animation.
  await page.waitForTimeout(400)

  const read = await readPopup(page, {
    popup: '.combo-popup',
    row: '.combo-option',
    // The closed control beside the list — `components/ComboBox.vue:286`, which declares the same
    // `color: var(--app-text)` the list's rows do (`components/ComboBoxList.vue:167`), and the one
    // that was always right because it never left the shell.
    reference: '#settings-ai-model',
  })
  assertSurface(read, 'the model list')
  // The face and the shadow, and the words' *face*: the one row this list has is the value the
  // field already holds, so it carries `is-selected` and draws `var(--app-accent)` rather than the
  // text colour (`ComboBoxList.vue:180`) — which is why the colour half of the drawn claim is
  // carried by the property equality above and by the field's own colour here, and not by a
  // row-against-field pair.
  assertDrawn(read, 'the model list', { face: true, shadow: true })
  if (read.row === null || read.reference === null) throw new Error('the list drew no row to read')
  expect(read.row.fontFamily, 'the model list: a row draws the face the shell draws')
    .toBe(read.shell.fontFamily)
  expect(read.row.fontFamily, 'the model list: which is Source Serif 4').toContain('Source Serif 4')
  expect(read.row.fontFamily, 'the model list: and not the default stack')
    .not.toContain('system-ui')
  expect(read.reference.color, 'the field beside the list draws the dark palette’s text')
    .toBe(DARK_TEXT)

  // And the list is still placed against its field by the recipe — four pixels off the edge it
  // opened from, inside the window it had to fit in.
  //
  // **Read at rest, with nothing synthetic.** This half used to dispatch a `resize` event first,
  // because the list only re-placed when the window resized or something scrolled, and the press
  // above had been measured against a field that went on moving: the stale number was 20.719px off
  // a field it was supposed to hang 4px from, and it was reported rather than fixed because the
  // instrument that looked necessary — a `ResizeObserver` on the field — cannot see a transform.
  // It could not: `ComboBox.vue`'s `followField()` carries the measurement and the fix, and the
  // `resize` dispatch this used to need is what that fix made unnecessary. A popup that has to be
  // poked into place is a control that lies about what it is attached to, and the assertion below
  // is where that lie would show.
  const placement = await page.evaluate(() => {
    const list = document.querySelector('.combo-popup')
    const field = document.querySelector('#settings-ai-model')
    if (!list || !field) throw new Error('the list or its field is not in the document')
    const a = field.getBoundingClientRect()
    const b = list.getBoundingClientRect()
    const above = a.top - b.bottom
    const below = b.top - a.bottom
    return {
      gap: above > 0 ? above : below,
      dx: b.left - a.left,
      inside: b.left >= 0 && b.right <= window.innerWidth && b.top >= 0
        && b.bottom <= window.innerHeight,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rect: { top: b.top, left: b.left, right: b.right, bottom: b.bottom },
    }
  })
  expect(
    placement.gap,
    `the list hangs ${placement.gap}px off the field, ${JSON.stringify(placement.rect)} in a ${placement.viewport.width}x${placement.viewport.height} window`,
  ).toBeCloseTo(4, 1)
  expect(Math.abs(placement.dx)).toBeLessThanOrEqual(2)
  expect(placement.inside).toBe(true)
})
