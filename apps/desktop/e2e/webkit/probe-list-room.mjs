/**
 * How much room the shipping engine gives a detached list under its control.
 *
 * The Chromium fence for this number is `e2e/popup-list-room.spec.ts`, and what it fences is the
 * reason `SelectMenu.vue` and `ComboBox.vue` can go on placing once, at open, with nothing watching
 * their own box: the room under the control covers the tallest list the control can draw, so no
 * height change while the list is up can need a move. That is a *layout* claim, and layout is the
 * one thing an engine settles for itself — the settings dialog's field heights, the popup's cap,
 * the row boxes. So it is read here on WebKitGTK as well, and the numbers are named as this
 * engine's.
 *
 * **The two readings, and why both.** The harness's own viewport is 1280x800, which is the window
 * the other probes measure; the product's smallest window is 860x560 (`tauri.conf.json:17-18`), and
 * the room a control is given is smallest there. A margin that only holds at the larger window is
 * not the invariant, so both are taken — the 800 one for comparability, the 560 one for the claim.
 *
 * 1. `.status-btn[title="Settings"]` opens the dialog (the one trigger this harness can use, shared
 *    with `probe-dialog.mjs`), `.dialog-nav .nav-row` with the AI label moves to the section, and
 *    `#settings-ai-model` is the field — `AiSettings.vue:90`, the app's only `ComboBox`.
 * 2. The provider's `/models` answer is stubbed in the page and the section's own refresh button is
 *    pressed, so the list is at its cap when it is read. A list that is not at its cap would make
 *    every number here mean less than it says.
 *
 * What comes back is not a verdict: `verify.mjs` has none for this probe, and the numbers are the
 * result. The reading is taken with the list OPEN, and the viewport is put back before returning,
 * because the probes share one page and this one moves it.
 */
import { clickByText } from './probe-support.mjs'
import { until } from './webdriver.mjs'

/** The shell's settings button — the only way this harness can open the dialog. */
const TRIGGER = '.status-btn[title="Settings"]'
/** The settings rail's row for the AI section (`SettingsNavigation.vue:22`, label `settings.section.ai`). */
const AI_ROW = 'AI'
/** The model field (`AiSettings.vue:90`) and the refresh button beside it (`:100`). */
const FIELD = '#settings-ai-model'
const REFRESH = '.model-refresh'

/** The product's own minimum window, and the content box that is one (`decorations: false`). */
const MIN = { width: 860, height: 560 }
/** MiniBrowser's chrome between its outer window and the content box (`measure.mjs`). */
const CHROME_HEIGHT = 36
/** More rows than the 280px cap needs, so the list is at its cap whatever the cap is. */
const MODELS = Array.from({ length: 14 }, (_, i) => `probe-model-${i}`)

/**
 * The provider's answer, installed the way a provider would answer.
 *
 * A plain body with one `return`, not an IIFE whose completion value is the answer: this driver
 * hands the script to `/execute/sync` as a function body and reads what it *returns* — measured
 * here, an IIFE reported `null` where the same statements with a `return` reported the object.
 */
const SEED = `const internals = window.__TAURI_INTERNALS__
  const original = internals.invoke
  internals.invoke = async (cmd, args) => (cmd === 'ai_list_models' ? ${JSON.stringify(MODELS)} : original(cmd, args))
  return true`

/**
 * Open the list and read where it landed against the field, in the coordinates of the window the
 * engine actually has. `cap` is the list's own computed `max-height`, so the comparison is between
 * two numbers the engine produced rather than one it produced and one this file restated.
 */
const READ = `const list = document.querySelector('.combo-popup')
const field = document.querySelector('${FIELD}')
if (!list || !field) return { error: 'the list or its field is not in the document' }
const a = field.getBoundingClientRect()
const b = list.getBoundingClientRect()
const above = a.top - b.bottom
const below = b.top - a.bottom
return {
    rows: list.querySelectorAll('.combo-option').length,
    height: Math.round(b.height),
    cap: Number.parseFloat(getComputedStyle(list).maxHeight),
    roomBelow: Math.round(window.innerHeight - a.bottom),
    side: above > 0 ? 'above' : 'below',
    gap: Math.round((above > 0 ? above : below) * 10) / 10,
    inside: b.top >= 0 && b.bottom <= window.innerHeight,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  }`

/** Open the field's list, read the room it was given, and close it again. */
async function readRoom(wd) {
  await clickByText(wd, FIELD, '')
  await until(
    () => wd.execute(`return document.querySelectorAll('.combo-option').length > 9`),
    { timeout: 5_000, what: 'the model list at its cap' },
  )
  // The list travels on a transform; a rect read mid-flight is a reading of the animation.
  await new Promise((resolve) => setTimeout(resolve, 500))
  const read = await wd.execute(READ)
  await wd.execute(`document.querySelector('${FIELD}').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  return true`)
  await until(() => wd.execute(`return document.querySelector('.combo-popup') === null`), {
    timeout: 5_000,
    what: 'the list to close',
  })
  return read
}

export const listRoomProbe = {
  name: 'list-room',
  async run(wd) {
    // No `openNote`: the harness has already opened the document and verified the viewport before
    // the probes run, and this probe reads a dialog — going through the file tree again would move
    // which note is open for the probe that runs after (`note-switch`).
    await wd.execute(SEED)
    await clickByText(wd, TRIGGER, '')
    await until(() => wd.execute(`return Boolean(document.querySelector('.settings-dialog'))`), {
      what: 'the settings dialog',
    })
    await clickByText(wd, '.dialog-nav .nav-row', AI_ROW)
    await until(() => wd.execute(`return Boolean(document.querySelector('${FIELD}'))`), {
      timeout: 10_000,
      what: 'the AI section',
    })
    // The page arrives through the scale/translate spring, and a press inside it is placed against a
    // field that goes on moving — the defect `01ccdbc` fixed. This probe is not about that, so it
    // waits for the arrival to settle before pressing.
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    await clickByText(wd, REFRESH, '')
    await new Promise((resolve) => setTimeout(resolve, 800))

    // ---- the harness's own window first, then the smallest one the product allows --------------
    const atHarness = await readRoom(wd)

    await wd.setWindowRect({ width: MIN.width, height: MIN.height + CHROME_HEIGHT, x: 0, y: 0 })
    await until(
      () =>
        wd.execute(`return innerWidth === ${MIN.width} && innerHeight === ${MIN.height}`),
      { timeout: 10_000, what: `a ${MIN.width}x${MIN.height} content area` },
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    const atMinimum = await readRoom(wd)

    // Put the page back: the probes share one window and the ones after this expect 1280x800.
    await wd.setWindowRect({ width: 1280, height: 800 + CHROME_HEIGHT, x: 0, y: 0 })
    await until(() => wd.execute('return innerWidth === 1280 && innerHeight === 800'), {
      timeout: 10_000,
      what: 'the harness viewport back',
    })
    await wd.execute(`document.querySelector('.settings-overlay')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    return true`)
    await until(() => wd.execute(`return document.querySelector('.settings-dialog') === null`), {
      timeout: 5_000,
      what: 'the dialog to close',
    })

    return { atHarness, atMinimum, engine: await wd.execute('return navigator.userAgent') }
  },
}
