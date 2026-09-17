/**
 * The app's inherited font size and leading are the user's, not the token block's — measured as an
 * equality.
 *
 * **The defect this file exists for.** `styles/style.css:3` reads
 *
 *   `body { font-family: var(--app-font); font-size: var(--app-body-size); line-height: var(--app-line-height); }`
 *
 * and `body` is outside `.shell` — the one element `AppShell.vue:271-292` puts the user's appearance
 * on: the four `data-*` axes and eight inline `--app-*` properties. A custom property is inherited,
 * but a `font-size` declaration is *resolved where it is written*, so `body`'s `var(--app-body-size)`
 * was substituted with `tokens.css`'s `15px` and the whole application inherited that result. Measured
 * in Chromium with `17px` stored through this very page: `.shell`'s own computed `font-size` was
 * `15px` while the `--app-body-size` it published was `17px`, and its computed `line-height` was
 * `27px` (= 15 × 1.8) while its `--app-line-height` was `2`. Only the surfaces that read the
 * variables themselves — the two editor panes, `editor-content.css:22` and `sourcePane.css:27` —
 * followed the user; everything that merely inherited sat at the default at every setting, and at
 * `12px` and at `20px` the inherited baseline was the same number.
 *
 * `appShell-chrome.css:52-53` is the fix: the element that redefines the variables declares the two
 * properties, beside the `font-family` that has been there since the same defect was found for the
 * face (`:51`).
 *
 * ## What this file measures, and how
 *
 * The bar is **the equality of two independently measured values**: what the engine computed for an
 * element that declares nothing (`getComputedStyle(…).fontSize`), against what the shell published
 * (`getComputedStyle(shell).getPropertyValue('--app-body-size')`) — the second is the number the
 * user typed, the first is the number the cascade settled on. Not "the shell is 20px": a shell given
 * a second declaration of its own would pass that. Everything is driven through the real controls:
 *
 *   `AppShell.vue:457` status bar's settings button → `App.vue`'s `showSettings`
 *   → `AppDialogs.vue:74` mounts `SettingsPanel`
 *   → `SettingsNavigation.vue:45` the second rail row (appearance)
 *   → `AppearanceSettings.vue:214` the body-size field / `:217` its `@change`
 *      → `stores/appearance.ts:183` `setBodyFontSize` → `AppShell.vue:275`
 *   → `AppearanceSettings.vue:225` the leading field / `:229` its `@change`
 *      → `stores/appearance.ts:193` `setLineHeight` → `AppShell.vue:276`
 *   → `app/appShell-chrome.css:20-53` the declarations this file is about.
 *
 * Both ends of the control's range are driven in one run, because the fix is symmetric and a change
 * that only grew the app would be a different defect: `12`/`1.2` and `20`/`2.4` are
 * `appearance-schema.ts`'s `BODY_FONT_SIZE_MIN`/`MAX` and `LINE_HEIGHT_MIN`/`MAX`.
 *
 * The blast radius was measured before the fix was written, by injecting the two declarations into a
 * live page and diffing every element inside `.shell` (`getComputedStyle` before and after):
 *
 *   - **at the defaults (15px / 1.8) nothing moves at all** — not one of the elements inside
 *     `.shell` changes a size or a leading, because every surface that wants a size of its own
 *     declares one;
 *   - **the leading moves 121 elements** at any non-default leading: the title bar's `12px` rows
 *     (21.6px → 24px), the tree's rows, the status bar, and so on — each multiplies its *own* size by
 *     the number the setting publishes;
 *   - **the size moves 52 elements**, and they are the containers that were inheriting: `.titlebar`,
 *     `.sidebar`, `.panes`, `.dialog-content` … No *text* element inside `.shell` draws at the
 *     inherited size in this app, so the size half is the one a future surface will feel first — and
 *     the 52 are exactly the elements that were being handed a number the user did not choose.
 *
 * The surfaces that must **not** move are those that declare a size of their own, and that is an
 * explicit decision rather than an accident of inheritance: `.status-bar` stays at `11px`
 * (`ui/StatusBar.vue:128`) and `.nav-row` at `12px` (`SettingsNavigation.vue:87`) whether the user
 * asked for 12px or 20px. This file pins both halves.
 *
 * Nothing here claims anything about WebKitGTK; `e2e/webkit/pet-probe.mjs` carries the same
 * measurement in the engine that ships.
 */
import { expect, test, type Page } from '@playwright/test'
import { openNote } from './support/editorHarness'

/** The two ends of the range, and the leading that goes with each — `appearance-schema.ts`'s. */
const SMALL = { size: 12, leading: 1.2 }
const LARGE = { size: 20, leading: 2.4 }

/**
 * One surface that declares a size of its own and a leading it does not: `.settings-field`
 * (`AppearanceSettings.vue:277`, a `<label>`), which is `12px` at both ends of the range and whose
 * line box is `12 × leading`.
 */
const FIELD_SIZE = 12

/** And one that declares both: the status bar's own `11px` (`ui/StatusBar.vue:128`). */
const STATUS_SIZE = 11

interface TypeReading {
  /** What the shell publishes, as CSS text — the setting, as the shell carries it. */
  published: { size: string, leading: string }
  /** What the engine computed for the shell itself. */
  shell: { fontSize: string, lineHeight: string }
  /** The settings dialog's content box, which declares no size of its own. */
  content: { fontSize: string, lineHeight: string }
  /** A field that declares `12px` of its own and inherits the leading. */
  field: { fontSize: string, lineHeight: string }
  /** The status bar, which declares `11px` of its own. */
  status: { fontSize: string }
  /** The status bar's own buttons, which declare nothing and used to draw the UA's `13.3333px`. */
  statusButton: { fontSize: string }
  /** `body`, which states no typography of its own since `style.css`'s declaration was removed. */
  body: { fontSize: string }
  /** `document.documentElement`'s token block, the third number a fallback could land on. */
  token: { size: string, leading: string }
}

/** Open the settings dialog on Appearance, the way a user reaches the two fields. */
async function openAppearance(page: Page): Promise<void> {
  // `AppShell.vue:457` — the status bar's own settings button.
  await page.locator('.status-btn').last().click()
  await page.locator('.settings-overlay').waitFor({ state: 'visible', timeout: 5000 })
  // `SettingsNavigation.vue:45` — the second row of the rail.
  await page.locator('.dialog-nav .nav-row').nth(1).click()
}

/**
 * Write one size and one leading through the two fields' own `@change` — the event a blur produces.
 *
 * The fields are `<input type="number">`: `fill` + `Enter` is the same door
 * `settings-dialog-scope.spec.ts` uses, and it is the door a user's typing and tabbing takes.
 */
async function driveType(page: Page, value: { size: number, leading: number }): Promise<void> {
  const content = page.locator('.dialog-content')
  const size = content.locator('input[type="number"]').first()
  await size.fill(String(value.size))
  await size.press('Enter')
  const leading = content.locator('input[type="number"]').nth(1)
  await leading.fill(String(value.leading))
  await leading.press('Enter')
  // The store writes the shell's inline style in the same tick; this waits for the *paint* to have
  // been given the new number before anything is read, rather than for a duration.
  await page.waitForFunction(
    (expected) =>
      getComputedStyle(document.querySelector('.shell') as Element)
        .getPropertyValue('--app-body-size')
        .trim() === expected,
    `${value.size}px`,
    { timeout: 5000 },
  )
}

function readType(page: Page): Promise<TypeReading> {
  return page.evaluate((): TypeReading => {
    const of = (selector: string): { fontSize: string, lineHeight: string } => {
      const el = selector === 'body' ? document.body : document.querySelector(selector)
      if (!el) throw new Error(`no element for ${selector}`)
      const cs = getComputedStyle(el)
      return { fontSize: cs.fontSize, lineHeight: cs.lineHeight }
    }
    const shell = document.querySelector('.shell')
    if (!shell) throw new Error('the app drew no shell')
    const shellStyle = getComputedStyle(shell)
    const rootStyle = getComputedStyle(document.documentElement)
    return {
      published: {
        size: shellStyle.getPropertyValue('--app-body-size').trim(),
        leading: shellStyle.getPropertyValue('--app-line-height').trim(),
      },
      shell: { fontSize: shellStyle.fontSize, lineHeight: shellStyle.lineHeight },
      content: of('.dialog-content'),
      field: of('.dialog-content .settings-field'),
      status: { fontSize: of('.status-bar').fontSize },
      statusButton: { fontSize: of('.status-btn').fontSize },
      body: { fontSize: of('body').fontSize },
      token: {
        size: rootStyle.getPropertyValue('--app-body-size').trim(),
        leading: rootStyle.getPropertyValue('--app-line-height').trim(),
      },
    }
  })
}

/**
 * One end of the range, held to the same five numbers.
 *
 * `name` is only for the failure message; the assertions are the same at both ends, which is the
 * point — a fix that only made the app grow would be a different defect wearing this one's clothes.
 */
function assertEnd(read: TypeReading, end: { size: number, leading: number }): void {
  const size = `${end.size}px`
  /** A computed length as a number: the engine reports fractions, so two answers are compared as
   *  numbers rather than as strings (`12 × 2.4` is not `28.8` in binary floating point). */
  const px = (value: string): number => Number.parseFloat(value)

  // ---- The equality: what the engine computed, against what the shell published. ----------------
  //
  // Two independent readings of one setting: the property the shell carries (the user's number, as
  // the store wrote it) and the size the cascade settled on for the element itself. They were 17px
  // and 15px before the fix.
  expect(read.published.size).toBe(size)
  expect(read.shell.fontSize).toBe(size)
  expect(read.published.leading).toBe(String(end.leading))
  // The leading is a *number* and not a length (`appearance.ts` publishes `String(lineHeight)`), so
  // the shell's own computed line box is the size times it.
  expect(px(read.shell.lineHeight)).toBeCloseTo(end.size * end.leading, 2)

  // ---- And it is the *setting*, not the token that happens to be on both sides. -----------------
  //
  // The fence closes in both directions: the published number must be one the token block cannot
  // produce, and the token's must be the documented fallback. `body` is the third number — the one
  // `style.css:3` states and the one every surface outside `.shell` still resolves.
  expect(read.token.size).toBe('15px')
  expect(read.token.leading).toBe('1.8')
  expect(read.shell.fontSize).not.toBe(read.token.size)
  expect(read.shell.fontSize).not.toBe(read.body.fontSize)
  expect(read.shell.fontSize).not.toBe('15px')

  // ---- The drawn half: an element that declares nothing inherits it. ---------------------------
  //
  // A property can be carried by an element that never uses it, and `.dialog-content` declares no
  // size and no leading of its own — so this is the half a reader can see: the settings dialog's own
  // text is the size the user asked for, and a rail row that declares `12px` multiplies *that* by
  // the published leading rather than by the token block's 1.8.
  expect(read.content.fontSize).toBe(read.shell.fontSize)
  expect(px(read.content.lineHeight)).toBeCloseTo(end.size * end.leading, 2)
  expect(read.field.fontSize).toBe(`${FIELD_SIZE}px`)
  expect(px(read.field.lineHeight)).toBeCloseTo(FIELD_SIZE * end.leading, 2)

  // ---- And what asked for a size of its own keeps it. ------------------------------------------
  //
  // The status bar is chrome at a fixed 11px (`ui/StatusBar.vue:128`), which is the decision this
  // file makes explicit rather than accidental: a surface that declares a size is not the app's body
  // text, and the setting does not reach it at either end of the range.
  expect(read.status.fontSize).toBe(`${STATUS_SIZE}px`)

  // ---- And what declares nothing still draws the bar's size, not the engine's. -----------------
  //
  // The bar's two buttons declare no size at all, and a `<button>` carries the user agent's
  // `font: 13.3333px Arial` — a *declaration*, so it resets inheritance and neither the bar's `11px`
  // nor the user's setting could reach them. Measured, Chromium: `13.3333px` beside spans that drew
  // `11px`, at every setting. `app/appShell-chrome.css`'s `.status-btn { font: inherit }` is the fix
  // and this is the decision behind it: **the chrome's, not the user's** — a control inside the bar
  // is part of the bar, and the assertion is the equality against the bar rather than a second
  // `11px` written here, so this file cannot pass while the two disagree.
  expect(
    read.statusButton.fontSize,
    `the buttons draw the bar's own size, not the engine's 13.3333px (read ${read.statusButton.fontSize})`,
  ).toBe(read.status.fontSize)
  expect(read.statusButton.fontSize).not.toBe(read.shell.fontSize)
  expect(read.statusButton.fontSize).not.toBe('13.3333px')
}

test('the app inherits the font size and leading the shell publishes, at both ends of the range', async ({
  page,
}) => {
  await openNote(page)
  await openAppearance(page)

  await driveType(page, LARGE)
  const large = await readType(page)
  assertEnd(large, LARGE)

  await driveType(page, SMALL)
  const small = await readType(page)
  assertEnd(small, SMALL)

  // The two ends are two different numbers, which is what makes the assertions above about *this*
  // setting rather than about a constant that happens to be declared twice: a shell hardcoded to one
  // of them would satisfy one end and fail the other.
  expect(large.shell.fontSize).not.toBe(small.shell.fontSize)
  expect(large.field.lineHeight).not.toBe(small.field.lineHeight)
})
