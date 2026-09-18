/**
 * A combo box's list is as wide as the field it belongs to — measured as an equality.
 *
 * ## The defect this file exists for
 *
 * The same rule `SelectMenu.vue` carried, stated by `ComboBox.vue`'s own placement in as many
 * words — *"Never narrower than the field it belongs to, never wider than a menu"* (`:166`) — and
 * contradicted in two places at once:
 *
 *   * `ComboBox.vue:151` capped the *floor* at 280px (`Math.max(180, Math.min(anchor.width, 280))`),
 *     so a field wider than 280px could not pull the list out with it;
 *   * `ComboBoxList.vue:117` declared `max-width: 280px` on the popup itself — a second, smaller
 *     answer to the same question, and the one that would have held even once the floor followed.
 *
 * **It is reachable from the running window**, which is why it is a defect rather than a tidy-up:
 * the field is `AiSettings.vue`'s model row (`#settings-ai-model`, `class="input"` inside
 * `.model-row`), and inside the settings dialog that row is the dialog's own width. Measured below
 * at 1280x800, and again with the dialog dragged wider, which is the state a user can put it in.
 *
 * **What a36a06d established about this shape.** That commit fixed `SelectMenu.vue` — the third copy
 * of this same placement — and in doing so named ComboBox and `use-detached-popup.ts` as the two
 * siblings that "cap only the *floor*; neither declares a width ceiling". That reading came from the
 * placement function alone; `ComboBox.vue` has no ceiling, but the component it hands the box to
 * does, and 280px sat there as the width *and* the height of the same rule — the same one-number-
 * copied pairing the commit used as its evidence that the number was never a decision.
 *
 * ## What each case measures
 *
 * Two independently measured values: the field's own `getBoundingClientRect()` and the open list's,
 * both read from the engine after the list has arrived. Not "the list got wider" — a list pinned to
 * a second constant would pass that. Both are reported, so a run says what they were.
 *
 *   `AppShell.vue` status bar's settings button (`.status-btn`, the last one)
 *     → `AppDialogs.vue` mounts `SettingsPanel`
 *     → `SettingsNavigation.vue` an `.dialog-nav .nav-row` (the `ai` row)
 *     → `AiSettings.vue:90` `<ComboBox>` → `ComboBox.vue:440` `#settings-ai-model` the field
 *     → `ComboBoxList.vue:84` `.combo-popup` the list
 */
import { expect, test, type Page } from '@playwright/test'
import { openNote } from './support/editorHarness'

/** The dialog rail's `ai` row, in `SettingsNavigation.vue`'s order. Named rather than indexed so a
 *  row inserted above it cannot silently move this file onto another page. */
const AI_ROW = 4

/**
 * The tolerance on the equality: the list's width is written as `min-width: <field width>px` — an
 * integer, because `offsetWidth` is one — while the field's own rect is fractional, so the two
 * disagree by a fraction of a pixel on a layout whose field is not a whole number. The same
 * tolerance, for the same reason, as `select-popup-width.spec.ts` and `settings-resize.spec.ts`.
 */
const SUBPIXEL = 1

interface Widths {
  field: number
  popup: number
  /** Where the list's own edges ended up, so "it fits" is read from the box rather than inferred. */
  popupLeft: number
  popupRight: number
  viewport: number
  /** What the list's own width rule says, read from the engine's computed style. */
  maxWidth: string
  /** What the popup's children ask for, which is how "no option was clipped by the field's own
   *  ellipsis" is read rather than guessed. */
  contentWidth: number
}

/** Open the settings dialog at the window this programme's numbers are taken at. */
async function openDialog(page: Page, width = 1280, height = 800): Promise<void> {
  await openNote(page)
  await page.locator('.status-btn').last().click()
  await page.locator('.settings-overlay').waitFor({ state: 'visible', timeout: 5000 })
  await page.setViewportSize({ width, height })
  await page.waitForFunction((w) => window.innerWidth === w, width, { timeout: 5000 })
  await page.locator('.dialog-nav .nav-row').nth(AI_ROW).click()
  await page.waitForTimeout(400)
}

/** Open the model list and read both boxes, then close it again. */
async function widths(page: Page): Promise<Widths> {
  await page.locator('#settings-ai-model').click()
  await page.locator('.combo-popup').waitFor({ state: 'visible', timeout: 5000 })
  // The arrival is a translate and a scale (`ComboBoxList`'s own rungs), and a rectangle read
  // through a transform is not the box the engine laid out.
  await page.waitForTimeout(300)
  const read = await page.evaluate(() => {
    const field = document.querySelector('#settings-ai-model') as HTMLElement
    const popup = document.querySelector('.combo-popup') as HTMLElement
    const f = field.getBoundingClientRect()
    const p = popup.getBoundingClientRect()
    const round = (n: number): number => Math.round(n * 100) / 100
    return {
      field: round(f.width),
      popup: round(p.width),
      popupLeft: round(p.left),
      popupRight: round(p.right),
      viewport: window.innerWidth,
      maxWidth: getComputedStyle(popup).maxWidth,
      contentWidth: popup.scrollWidth,
    }
  })
  await page.keyboard.press('Escape')
  await page.locator('.combo-popup').waitFor({ state: 'detached', timeout: 5000 })
  return read
}

test.describe('the width of a combo box’s list', () => {
  test('is the width of the field it belongs to', async ({ page }) => {
    await openDialog(page)
    const read = await widths(page)
    console.log(
      `model list/field: ${read.popup}/${read.field} natural=${read.contentWidth} max-width ${read.maxWidth}`,
    )
    // The field really is wider than the old cap, or this case would pass on a layout where the
    // constant was never wrong.
    expect(read.field).toBeGreaterThan(280)
    // The claim the comment makes, both halves of it.
    expect(read.popup).toBeGreaterThanOrEqual(read.field - SUBPIXEL)
    expect(read.popup).toBeLessThanOrEqual(read.viewport)
  })

  test('grows with the field when the user drags the dialog wider', async ({ page }) => {
    await openDialog(page)
    const before = await widths(page)
    // Five keyboard steps of 16px (`use-dialog-size.ts`'s `DIALOG_SIZE_STEP`), the grip's own
    // arrows — a real user gesture, and one no drag can race.
    await page.locator('.settings-resize').focus()
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(300)
    const after = await widths(page)

    console.log(
      `the dialog grew, widths: field ${before.field} -> ${after.field}, list ${before.popup} -> ${after.popup}`,
    )
    expect(after.field).toBeGreaterThan(before.field)
    // The equality again, at the size the user chose. This is also the case that fails if the
    // list is placed against the *previous* open's `min-width`: the reopened list would be clamped
    // sideways for a width it is not going to have.
    expect(after.popup).toBeGreaterThanOrEqual(after.field - SUBPIXEL)
    expect(after.popup).toBeGreaterThan(before.popup)
    expect(after.popupLeft).toBeLessThanOrEqual(before.popupLeft + SUBPIXEL)
  })

  test('still fits inside the window at the product’s smallest size', async ({ page }) => {
    // 860x560 is `tauri.conf.json`'s minimum, and the fence against the overshoot: a list that
    // answered the width defect by never being bounded again would open past the window's edge.
    await openDialog(page, 860, 560)
    const read = await widths(page)
    console.log(
      `at 860: list ${read.popup}/${read.field}, ${read.popupLeft}..${read.popupRight} in ${read.viewport}, max-width ${read.maxWidth}`,
    )
    expect(read.popupLeft).toBeGreaterThanOrEqual(0)
    expect(read.popupRight).toBeLessThanOrEqual(read.viewport)
    expect(read.popup).toBeGreaterThanOrEqual(read.field - SUBPIXEL)
  })
})
