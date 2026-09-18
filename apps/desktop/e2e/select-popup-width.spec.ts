/**
 * A select's list is as wide as the control it belongs to — measured as an equality.
 *
 * ## The defect this file exists for
 *
 * `SelectMenu.vue`'s popup declared `max-width: 280px`, and its placement declared the opposite
 * rule in as many words: *"Never narrower than the control it belongs to, never wider than a menu"*
 * (`:173-174`). The first half is false the moment the control is wider than 280px, and inside the
 * settings dialog every one of these controls is: `.settings-field` fills `.dialog-content`, which
 * at the 1280x800 window this programme's numbers are taken at is 528px wide — and the dialog is
 * resizable, so a user can make it wider still. So the list opened at 53% of its own control's
 * width, with the labels it exists to show ellipsised at the same place the closed control had
 * already ellipsised them: the popup was drawn to answer "which of these is it", and the one thing
 * it could not do was show more of the answer than the box that was already too narrow.
 *
 * **It is an oversight and not a decision**, and the evidence is in the repository rather than in
 * anyone's memory:
 *
 *   * `280px` arrived in `1ba9a64` — the commit that introduced this component — as
 *     `max-width: 280px` *and* `max-height: 280px` on the same rule, and the commit message argues
 *     the keyboard model, the modal claim, the z-index and the motion tokens and says nothing about
 *     either number. A width and a height given the same constant is one number copied, not two
 *     decisions.
 *   * The two sibling recipes that carry the same placement code (`ComboBox.vue:151`,
 *     `use-detached-popup.ts:80`) cap only the *floor*: neither declares a width ceiling at all, and
 *     both carry the same "never narrower than the control" comment. Three copies of one rule, and
 *     this is the one that contradicts it.
 *   * The app's own menus are 320px (`AgentPanelMenu.vue:186`, `AgentSessionHistoryMenu.vue:446`) —
 *     so 280 is not a house constant for "how wide a menu is", and something wider already ships.
 *
 * The one real question a width cap answers — *can a long option make the list wider than the room
 * it has?* — is what the third case below settles, because it is the failure the cap was hiding
 * behind: the list must fit inside the window at the product's smallest size (860x560,
 * `tauri.conf.json:17-18`). The second is the maintainer's own case, the dialog dragged wider.
 *
 * **The second defect this file found, and it was in the fix.** Once the floor followed the
 * control, the AI provider's list opened **87px to the left of its control** in
 * `settings-resize.spec.ts` — a placement computed against a `min-width: 908px` left over from a
 * wider dialog. `pos` outlives the popup, Vue renders the next one with the last placement's
 * `min-width` on its first frame, and the first `measurePlacement` is usually the only one, so the
 * component was reading a box it had itself sized for a different trigger. `SelectMenu.show()`
 * forgets the placement before every open, which makes the arithmetic idempotent; that case is the
 * test that fails without it.
 *
 * ## What each case measures
 *
 * Two independently measured values, per control: the trigger's own `getBoundingClientRect()` and
 * the open list's, both read from the engine after the list has arrived. Not "the list got wider" —
 * a list pinned to a second constant would pass that. Both numbers are reported, so a run says what
 * they were.
 *
 *   `AppShell.vue` status bar's settings button (`.status-btn`, the last one)
 *     → `AppDialogs.vue` mounts `SettingsPanel`
 *     → `SettingsNavigation.vue:50` a `.dialog-nav .nav-row`
 *     → the page's own `<SelectMenu>` trigger → `SelectMenu.vue:357` the popup
 */
import { expect, test, type Page } from '@playwright/test'
import { openNote } from './support/editorHarness'

/**
 * The tolerance on the equality, and it is 1px rather than exact: the list's width is written as
 * `min-width: <control width>px` — an integer, because `offsetWidth` is one — while the control's
 * own `getBoundingClientRect()` is fractional, so the two disagree by a fraction of a pixel on a
 * layout whose trigger is not a whole number. `settings-resize.spec.ts` carries the same tolerance
 * for the same reason. Measured, one run in five under load: 525.99 against 526.
 */
const SUBPIXEL = 1

/** The dialog rail's rows, in `SettingsNavigation.vue`'s order, by index. */
const GENERAL = 0
const APPEARANCE = 1
const EDITOR = 2
const EXPORT = 3

/**
 * One control per page, so the equality is a claim about the component rather than about one call
 * site: four different pages, four different option lists — two words long, a font stack, a number,
 * a paper size — and one rule.
 */
const CONTROLS = [
  { row: GENERAL, id: 'settings-locale' },
  { row: APPEARANCE, id: 'settings-ui-font' },
  { row: EDITOR, id: 'settings-autosave-interval' },
  { row: EXPORT, id: 'settings-export-page-size' },
] as const

/** The trigger's box and the open list's, in viewport coordinates. */
interface Widths {
  trigger: number
  popup: number
  /** Where the list's own edges ended up, so "it fits" is read from the box rather than inferred. */
  popupLeft: number
  popupRight: number
  viewport: number
  /** What the list's own width rule says, read from the engine's computed style. */
  maxWidth: string
  natural: number
}

/** Open the settings dialog at the window every number in this programme is taken at. */
async function openDialog(page: Page, width = 1280, height = 800): Promise<void> {
  await openNote(page)
  await page.locator('.status-btn').last().click()
  await page.locator('.settings-overlay').waitFor({ state: 'visible', timeout: 5000 })
  await page.setViewportSize({ width, height })
  await page.waitForFunction((w) => window.innerWidth === w, width, { timeout: 5000 })
  await page.waitForTimeout(300)
}

/** Open one control's list and read both boxes. */
async function widths(page: Page, id: string): Promise<Widths> {
  await page.locator(`#${id}`).click()
  await page.locator('.select-popup').waitFor({ state: 'visible', timeout: 5000 })
  // The arrival is a translate and a scale (`SelectPopup`'s own rungs), and a rectangle read
  // through a transform is not the box the engine laid out. One rung is 200ms.
  await page.waitForTimeout(300)
  const read = await page.evaluate((triggerId: string) => {
    const trigger = document.querySelector(`#${triggerId}`) as HTMLElement
    const popup = document.querySelector('.select-popup') as HTMLElement
    const t = trigger.getBoundingClientRect()
    const p = popup.getBoundingClientRect()
    return {
      trigger: Math.round(t.width * 100) / 100,
      popup: Math.round(p.width * 100) / 100,
      popupLeft: Math.round(p.left * 100) / 100,
      popupRight: Math.round(p.right * 100) / 100,
      viewport: window.innerWidth,
      maxWidth: getComputedStyle(popup).maxWidth,
      /** What the list's own content asks for: the half of the rule that lets a long option make
       *  the list wider than its control, and the number that says no case here needed it. */
      natural: popup.scrollWidth,
    }
  }, id)
  // Closed again, so the next control's press is not a dismissal of this one's list.
  await page.keyboard.press('Escape')
  await page.locator('.select-popup').waitFor({ state: 'detached', timeout: 5000 })
  return read
}

test.describe('the width of a select’s list', () => {
  test('is the width of the control it belongs to, on every settings page', async ({ page }) => {
    await openDialog(page)

    const seen: string[] = []
    for (const control of CONTROLS) {
      await page.locator('.dialog-nav .nav-row').nth(control.row).click()
      await page.waitForTimeout(400)
      const read = await widths(page, control.id)
      seen.push(`${control.id} ${read.popup}/${read.trigger} natural=${read.natural}`)
      // The claim, both halves of it: not narrower than its control, and not so wide it eats the
      // window. The second is what stops "at least as wide as the control" from being satisfied by
      // removing the bound altogether.
      expect(read.popup, `${control.id}: the trigger should be wider than the old 280px cap`)
        .toBeGreaterThan(280)
      expect(read.popup).toBeGreaterThanOrEqual(read.trigger - SUBPIXEL)
      expect(read.popup).toBeLessThanOrEqual(read.viewport)
    }
    console.log(`list/control widths: ${seen.join(', ')}`)
  })

  test('grows with the control when the user drags the dialog wider', async ({ page }) => {
    // The maintainer's own case: the dialog is resizable now (`settings-resize.spec.ts`), and a list
    // pinned to a constant is the one thing in it that does not come along.
    await openDialog(page)
    await page.locator('.dialog-nav .nav-row').nth(APPEARANCE).click()
    await page.waitForTimeout(400)

    const before = await widths(page, 'settings-ui-font')
    // Five keyboard steps of 16px (`use-dialog-size.ts`'s `DIALOG_SIZE_STEP`), the grip's own
    // arrows — a real user gesture, and one no drag can race.
    await page.locator('.settings-resize').focus()
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(300)
    const after = await widths(page, 'settings-ui-font')

    console.log(
      `the dialog grew, widths: control ${before.trigger} -> ${after.trigger}, list ${before.popup} -> ${after.popup}`,
    )
    expect(after.trigger).toBeGreaterThan(before.trigger)
    // The equality again, at the size the user chose.
    expect(after.popup).toBeGreaterThanOrEqual(after.trigger - SUBPIXEL)
    expect(after.popup).toBeGreaterThan(before.popup)
  })

  test('still fits inside the window at the product’s smallest size', async ({ page }) => {
    // 860x560 is `tauri.conf.json:17-18`'s minimum, and the fence against the overshoot: a list that
    // answered the width defect by never being bounded again would open past the window's edge, and
    // a row clipped by the window is worse than a row clipped by a constant.
    await openDialog(page, 860, 560)
    await page.locator('.dialog-nav .nav-row').nth(EXPORT).click()
    await page.waitForTimeout(400)

    const read = await widths(page, 'settings-export-page-size')
    console.log(
      `at 860: list ${read.popup}/${read.trigger}, ${read.popupLeft}..${read.popupRight} in ${read.viewport}, max-width ${read.maxWidth}`,
    )
    expect(read.popupLeft).toBeGreaterThanOrEqual(0)
    expect(read.popupRight).toBeLessThanOrEqual(read.viewport)
    expect(read.popup).toBeGreaterThanOrEqual(read.trigger - SUBPIXEL)
  })
})
