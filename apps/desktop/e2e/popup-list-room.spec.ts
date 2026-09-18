/**
 * The room a detached list needs under its control — the invariant that lets `SelectMenu` and
 * `ComboBox` go on placing **once**, at open, with nothing watching their own box.
 *
 * **The finding this file fences.** Neither of those two components observes its own list while it
 * is up (measured 2026-09-18, the fix that taught `ComboBox` to follow its *field*, `ea160cd`, and
 * the one that taught `SelectMenu` the same, `01ccdbc`). `use-detached-popup.ts` does — its
 * `watchSize` — and it is the recipe this app's other detached popups use. So the question the two
 * of them leave open is whether a list can change height while it is up and need to move, and the
 * answer measured here is **no, and by these numbers**:
 *
 *   * `ComboBox` — `place()` reads the box once, so the placement is stale the moment the list's
 *     height changes. And it changes while the list is up: `query` narrows `rows` (typing), and
 *     `props.options` grows under it (the provider's `/models` answer landing — `AiSettings.vue:94`
 *     binds the store's `modelsCache`). The one call site in the product is the AI model field
 *     (`AiSettings.vue:90`), and at the smallest window the product allows (860x560,
 *     `tauri.conf.json:17-18`) its room below measures **322px** against a list capped at **280px**.
 *     The recipe's own flip condition (`ComboBox.vue`'s `dropsDown`: `below + height <= height - 8`,
 *     with `below` four pixels under the field) needs **292**, so the list opens downward with 30px
 *     to spare, and every height it can reach fits under it. A shorter list only ever needs less
 *     room, so no size change can move it.
 *
 *   * `SelectMenu` — the same reading for the one call site in the product whose options can change
 *     while its list is up: the graph's tag filter (`GraphToolbar.vue:110`), whose options are the
 *     vault's tags (`props.tagOptions`), so a file the watcher sees edited can add one under an open
 *     list. Its room below measures **416px** at the smallest window height the product allows, and
 *     the cap is the same 280. Every other select in the app binds a module constant (`*Choices`
 *     computeds over literals) or a list that only changes on a press — and a press outside the list
 *     closes it first (`SelectMenu.vue`'s `onPointerDown`) — so no other call site can change size
 *     while its list is open at all.
 *
 * **Why a fence and not a watcher.** A watcher nobody can trigger is a control that does nothing
 * with a delay on it, and neither of these two can be triggered today: the numbers above are the
 * whole reason. But they are *layout* numbers, and layout is exactly what a later change moves. So
 * the invariant is pinned instead: **read the tallest list the control can draw and the room the
 * page gives it, and fail when the room runs out.** A red run here is not cosmetic — it says a
 * change has made the missing watcher necessary, and the failure message says which control and
 * why it matters.
 *
 * **What each half measures.**
 *
 *   1. the AI model field at 860x560, with a `/models` answer big enough to put the list at its cap,
 *      read while the list is open — plus the same reading on a page whose list has been made taller
 *      than the room it is given, which is the half that says this fence can see the failure it is
 *      for. Without that half the case would pass for all the wrong reasons: it restates the
 *      product's own layout.
 *   2. the graph's tag filter at 1280x560 (the note list column is not drawn at 860 at all —
 *      measured: its four selects report a zero box there), read with its list open.
 *
 * Nothing here asserts a palette or a duration, and neither number is restated from a stylesheet:
 * the cap is read from the open list's own computed `max-height`, and the room from the two
 * rectangles the engine laid out.
 *
 * Chromium is the instrument for the arithmetic; both surfaces are the main window and its settings
 * dialog, and `e2e/webkit/` is where the engine that ships is measured.
 */
import { expect, test, type Page } from '@playwright/test'
import { openNote } from './support/editorHarness'

/**
 * The provider's answer, long enough that the list is at its cap whatever the cap is: nine 30px rows
 * already pass the 280 the stylesheet declares, and fourteen leaves room for the cap to be raised
 * without this file quietly measuring a shorter list than the control can draw.
 */
const MODELS = Array.from({ length: 14 }, (_, i) => `probe-model-${i}`)

/**
 * The two constant numbers of the placement recipe, both from the component: `place()` puts the box
 * four pixels off the control's edge (`below = anchor.bottom + 4`) and keeps eight from the window's
 * edge (`pad`). A list fits under its control while `roomBelow >= cap + GAP + PAD` — the flip
 * condition in `ComboBox.vue`/`SelectMenu.vue`, rearranged.
 */
const GAP = 4
const PAD = 8

/** The i18n string the app is running in, for a locator by label. */
async function t(page: Page, key: string): Promise<string> {
  return page.evaluate(async (k) => {
    const mod = (await import('/src/i18n/index.ts')) as unknown as { t(key: string): string }
    return mod.t(k)
  }, key)
}

/** Answer the AI gateway's model list with `models`, the way a provider would. */
async function seedModels(page: Page, models: readonly string[]): Promise<void> {
  await page.evaluate((list) => {
    const internals = (
      window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => unknown } }
    ).__TAURI_INTERNALS__
    const original = internals.invoke
    internals.invoke = async (cmd: string, args: unknown = {}) => {
      if (cmd === 'ai_list_models') return [...list]
      return original(cmd, args)
    }
  }, models)
}

/** Where an open list sits against the control it hangs from, and how much room the window has. */
interface Room {
  /** The list's own height, as drawn. */
  height: number
  /** The cap its stylesheet declares, read off the open element rather than restated. */
  cap: number
  /** The control's bottom edge to the window's bottom. */
  roomBelow: number
  /** Which side of the control the list came to rest on. */
  side: 'above' | 'below'
  /** The gap between the two boxes: four pixels when the recipe placed it, more when it is stale. */
  gap: number
  /** Whether the whole list is inside the window it had to fit in. */
  inside: boolean
}

async function readRoom(
  page: Page,
  listSelector: string,
  controlSelector: string,
  controlIndex = 0,
): Promise<Room> {
  return page.evaluate(
    ({ listSelector: listSel, controlSelector: controlSel, controlIndex: index }) => {
      const list = document.querySelector(listSel) as HTMLElement | null
      const control = document.querySelectorAll(controlSel)[index] as HTMLElement | undefined
      if (!list || !control) throw new Error(`no ${listSel} / ${controlSel}[${index}] in the document`)
      const a = control.getBoundingClientRect()
      const b = list.getBoundingClientRect()
      const above = a.top - b.bottom
      return {
        height: b.height,
        cap: Number.parseFloat(getComputedStyle(list).maxHeight),
        roomBelow: window.innerHeight - a.bottom,
        side: above > 0 ? 'above' : 'below',
        gap: Math.abs(above > 0 ? above : b.top - a.bottom),
        inside: b.top >= 0 && b.bottom <= window.innerHeight,
      }
    },
    { listSelector, controlSelector, controlIndex },
  )
}

test('the AI model list fits under its field at the smallest window, so a resize cannot move it', async ({
  page,
}) => {
  await openNote(page)
  await seedModels(page, MODELS)
  // The product's own minimum (`tauri.conf.json:17-18`, `minWidth: 860` / `minHeight: 560`), which
  // is the whole of this file's geometry: the room a control is given is smallest there.
  await page.setViewportSize({ width: 860, height: 560 })

  // `AppShell.vue:457` the status bar's settings button → `SettingsNavigation`'s AI row, the fifth of
  // the rail's own order → `AiSettings.vue:100` the refresh button, so the cache the field's
  // `options` binds is filled by the product's own call and not by a write from this test.
  await page.locator('.status-btn').last().click()
  await page.locator('.settings-overlay').waitFor({ state: 'visible', timeout: 5000 })
  await page.locator('.dialog-nav .nav-row').nth(4).click()
  // The page arrives through the `scale`/`translate` spring; a rect read mid-flight is a reading of
  // the animation, and the follow loop needs the frame it settles on.
  await page.waitForTimeout(900)
  await page.locator('.model-refresh').click()
  await page.waitForTimeout(600)

  // `AiSettings.vue:90` — the field itself, pressed the way a reader presses it. It stands at the
  // top of the page's content, so no scrolling is involved and this is the lowest position it can
  // ever take: scrolling moves the content up, never down.
  await page.locator('#settings-ai-model').click()
  await page.locator('.combo-popup').waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForTimeout(450)
  const atRest = await readRoom(page, '.combo-popup', '#settings-ai-model')

  // The list is read at its own cap, or this case would be measuring a shorter list than the control
  // can draw and the numbers below would mean nothing.
  expect(
    atRest.height,
    `the list is at its cap as drawn (${atRest.height} of ${atRest.cap})`,
  ).toBeCloseTo(atRest.cap, 0)
  expect(atRest.side, 'the model list opens downward at the smallest window').toBe('below')
  expect(atRest.inside, 'and the whole of it is inside the window').toBe(true)
  expect(atRest.gap, 'and it hangs the recipe’s four pixels off its field').toBeCloseTo(GAP, 1)

  // ---- The invariant: the room below the field covers the tallest list it can draw. ------------
  //
  // `roomBelow` is measured from the field's own bottom edge, and the recipe starts four pixels under
  // it and keeps eight from the window's edge, so the line is `cap + GAP + PAD` — 292 of the 322px
  // the field is given.
  const need = atRest.cap + GAP + PAD
  expect(
    atRest.roomBelow,
    `the field is given ${atRest.roomBelow}px below it against the ${need}px its ${atRest.cap}px list `
      + 'needs: a list that grew past this line would be placed past the window’s edge, and neither '
      + 'ComboBox.vue nor SelectMenu.vue observes its own box while it is up — use-detached-popup.ts’s '
      + 'watchSize is the recipe that does. Add it, or give the field back its room.',
  ).toBeGreaterThanOrEqual(need)

  // ---- And the instrument can see the failure it is for. ---------------------------------------
  //
  // The reading above is the product's own layout, so at rest nothing here can go red. The list is
  // therefore made taller than the room the field is given — the one change that would make the
  // missing watcher matter — and the same two numbers are taken again. A fence that stayed green
  // through this would be measuring nothing. `!important` because the list's own rule is scoped
  // (`.combo-popup[data-v-…]`, specificity 0-2-0) and a plain class rule would lose to it.
  await page.keyboard.press('Escape')
  await page.locator('.combo-popup').waitFor({ state: 'detached', timeout: 5000 })
  await page.evaluate(() => {
    const style = document.createElement('style')
    style.id = 'list-room-probe-taller'
    style.textContent = '.combo-popup { max-height: 520px !important }'
    document.head.append(style)
  })
  await page.waitForTimeout(200)
  await page.locator('#settings-ai-model').click()
  await page.locator('.combo-popup').waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForTimeout(450)
  const taller = await readRoom(page, '.combo-popup', '#settings-ai-model')

  expect(
    taller.height,
    `the injected cap took the list to ${taller.height}px — taller than the 280 it draws at, so the `
      + 'injection reached the element it was meant for',
  ).toBeGreaterThan(atRest.height)
  expect(
    taller.roomBelow,
    `and the field’s ${taller.roomBelow}px of room is now under the ${taller.cap + GAP + PAD}px line `
      + 'above — the fence reads the layout rather than restating a constant',
  ).toBeLessThan(taller.cap + GAP + PAD)
  expect(
    taller.gap,
    `with the room gone the placement is stale: the list sits ${taller.gap}px off the field it belongs `
      + 'to rather than the recipe’s four, because nothing re-placed it when its box changed',
  ).not.toBeCloseTo(GAP, 1)
})

test('the graph’s tag list — the one select whose options change under it — fits under it too', async ({
  page,
}) => {
  await openNote(page)
  // `SidebarNavigation.vue:88` — the rail's own entries, the graph among them. It is drawn in the
  // note list column, which is not drawn at all at 860 (`GraphPanel.vue` reads a zero box there), so
  // the smallest *height* the product allows is taken with the width that keeps the column up.
  const graph = await t(page, 'nav.graph')
  await page.locator('.nav-group .nav-item', { hasText: graph }).click()
  await page.locator('.graph-panel').waitFor({ state: 'visible', timeout: 20000 })
  await page.waitForTimeout(600)
  await page.setViewportSize({ width: 1280, height: 560 })
  await page.waitForTimeout(400)

  // `GraphToolbar.vue:110` — the tag filter, the third of the panel's four selects
  // (`:82` cap, `:96` directory, `:110` tag, `:124` link type).
  await page.locator('.graph-select').nth(2).click()
  await page.locator('.select-popup').waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForTimeout(400)
  const room = await readRoom(page, '.select-popup', '.graph-select', 2)

  expect(room.side, 'the tag list opens downward at the smallest window height').toBe('below')
  expect(room.inside, 'and the whole of it is inside the window').toBe(true)
  const need = room.cap + GAP + PAD
  expect(
    room.roomBelow,
    `the tag filter is given ${room.roomBelow}px below it against the ${need}px its ${room.cap}px list `
      + 'needs: the vault’s tags arrive under an open list (a file the watcher sees edited adds one), '
      + 'so this is the select that would need a watcher on its own box first — SelectMenu.vue places '
      + 'once, at open, and a list that grew past this line would be placed past the window’s edge.',
  ).toBeGreaterThanOrEqual(need)
})
