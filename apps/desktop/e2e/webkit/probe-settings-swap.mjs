/**
 * What the shipping engine does when the settings dialog swaps what it is showing.
 *
 * Two defects were measured in Chromium inside this dialog on the same day, and both are
 * *layout* claims — the kind only an engine can settle — so both are read here on WebKitGTK and
 * the numbers are named as this engine's:
 *
 *   1. **Where the reader lands.** `.dialog-content` is one scroll container reused by two rails:
 *      the dialog's own (which swaps the section) and the agents tree's (which swaps the page).
 *      Neither used to touch the offset, so a switch kept the previous content's — and because the
 *      new content is usually shorter the engine clamps it, putting the reader at the *bottom* of a
 *      page they have never seen the top of. Chromium, 1280x800: the AI page at `1194/1230` and the
 *      `editor` row pressed → `186/186`. `e2e/settings-scroll-reset.spec.ts` is that fence;
 *      `content-scroll.ts` is the fix, and it finds the box by walking up from the swapped content
 *      because the container belongs to the panel and a sub-rail may not name the panel's markup.
 *
 *   2. **How wide the list is.** `SelectMenu.vue`'s popup declared `max-width: 280px`, which was not
 *      a ceiling but a second, smaller width: Chromium measured every settings select opening at
 *      `280` inside a `526` control. The bound is a measurement now (`measurePlacement`), and the
 *      stylesheet declares none. `e2e/select-popup-width.spec.ts` is that fence.
 *
 * **The click path, in the order this probe takes it** — the same one a person takes, through the
 * dialog's own rail, addressed by row index because a text selector would move with the locale:
 *
 *   `.status-btn[title="Settings"]` → `.dialog-nav .nav-row` 4 (`ai`) → scroll `.dialog-content` to
 *   its end → `.dialog-nav .nav-row` 2 (`editor`) → the same rail back to 4 → `#settings-ai-provider`
 *   → `.select-popup`.
 *
 * The dialog is opened once and closed before returning, which is the contract `list-room` and
 * `dialog-resize` already keep: the overlay covers the status button that opened it, so the close
 * is the dialog's own, and nothing after this probe can reach the editor anyway.
 */
import { clickByText } from './probe-support.mjs'
import { until } from './webdriver.mjs'

/** The shell's settings button — the only way this harness can open the dialog. */
const TRIGGER = '.status-btn[title="Settings"]'
/** The dialog's rail, addressed by row index (`SettingsNavigation.vue`'s own order). */
const ROW = '.dialog-nav .nav-row'
const AI = 4
const EDITOR = 2
/** The AI section's provider select (`AiSettings.vue:75`), a `SelectMenu` and not a `ComboBox`. */
const PROVIDER = '#settings-ai-provider'

/**
 * Where the reader was put down, and where the page they opened actually starts.
 *
 * Two readings that must agree, both produced by the engine: the container's own `scrollTop`, and
 * the drawn page's top edge in the container's coordinates. The drawn page is the child that is
 * not on its way out — the swap is a cross-fade and the leaver is still in the document for its
 * whole 280ms exit, out of flow at the container's own top, so a reader that took the first
 * `.settings-section` would be measuring the page the reader has left.
 */
const READ_LANDING = `const content = document.querySelector('.dialog-content')
if (!content) return { error: 'no .dialog-content' }
const drawn = Array.from(content.children)
  .find((el) => !el.classList.contains('page-leave-active'))
if (!drawn) return { error: 'no page is drawn' }
const box = content.getBoundingClientRect()
return {
  scrollTop: Math.round(content.scrollTop),
  scrollMax: Math.round(content.scrollHeight - content.clientHeight),
  viewport: Math.round(content.clientHeight),
  firstLine: Math.round(drawn.getBoundingClientRect().top - box.top),
}`

/** The list's own box against the control it belongs to. */
const READ_LIST = `const list = document.querySelector('.select-popup')
const trigger = document.querySelector('${PROVIDER}')
if (!list || !trigger) return { error: 'the list or its control is not in the document' }
const a = trigger.getBoundingClientRect()
const b = list.getBoundingClientRect()
return {
  control: Math.round(a.width * 100) / 100,
  list: Math.round(b.width * 100) / 100,
  left: Math.round(b.left * 100) / 100,
  right: Math.round(b.right * 100) / 100,
  viewport: window.innerWidth,
  rows: list.querySelectorAll('.select-option').length,
  maxWidth: getComputedStyle(list).maxWidth,
}`

/** Put the container at its end and answer what it landed on, so "there was somewhere to go" is a
 *  number rather than an assumption about the fixture. */
async function scrollToEnd(wd) {
  return wd.executeAsync(
    `const content = document.querySelector('.dialog-content')
     if (!content) { arguments[arguments.length - 1]({ error: 'no .dialog-content' }); return }
     content.scrollTop = content.scrollHeight
     const done = arguments[arguments.length - 1]
     let n = 0
     const tick = () => {
       if (++n < 3) { requestAnimationFrame(tick); return }
       done({ top: Math.round(content.scrollTop),
              max: Math.round(content.scrollHeight - content.clientHeight) })
     }
     requestAnimationFrame(tick)`,
  )
}

/** A swap is a cross-fade with a 460ms arrival; a rect read inside it is a reading of the curve. */
const settle = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms))

export const settingsSwapProbe = {
  name: 'settings-swap',
  async run(wd) {
    // No `openNote`: the harness has already opened the document and verified the viewport, and this
    // probe reads a dialog — going through the file tree again would move which note is open for the
    // probes that care.
    await clickByText(wd, TRIGGER, '')
    await until(() => wd.execute(`return Boolean(document.querySelector('.settings-dialog'))`), {
      what: 'the settings dialog',
    })

    // ---- 1. the swap ---------------------------------------------------------------------------
    await clickByText(wd, ROW, '', AI)
    await until(() => wd.execute(`return Boolean(document.querySelector('${PROVIDER}'))`), {
      timeout: 10_000,
      what: 'the AI section',
    })
    await settle(1_200)
    const from = await scrollToEnd(wd)

    await clickByText(wd, ROW, '', EDITOR)
    await settle()
    const afterSection = await wd.execute(READ_LANDING)

    // The agents tree's own rail, which shares the container: the same reading on the second rail,
    // because they are two swaps and one rule.
    await clickByText(wd, ROW, '', 6)
    await until(() => wd.execute(`return Boolean(document.querySelector('.agents-rail'))`), {
      timeout: 10_000,
      what: 'the agents section',
    })
    await settle(1_200)
    const agentsFrom = await scrollToEnd(wd)
    await clickByText(wd, '.agents-rail [role="tab"]', '', 1)
    await settle(600)
    const afterPage = await wd.execute(READ_LANDING)

    // ---- 2. the width --------------------------------------------------------------------------
    await clickByText(wd, ROW, '', AI)
    await until(() => wd.execute(`return Boolean(document.querySelector('${PROVIDER}'))`), {
      timeout: 10_000,
      what: 'the AI section again',
    })
    await settle(1_200)
    // **The dialog is taken to its full width first, through its own grip.** The reading this probe
    // is for is "the list is as wide as its control", and at the size the dialog happens to open at
    // here the control measures 292px — twelve pixels clear of the `280` the stylesheet used to pin
    // the list to, which is a margin a reader has to be told about to believe. `End` is the grip's
    // own key for the window's room (`use-dialog-size.ts`), so this is a real gesture and not a
    // number this probe writes into a style.
    await wd.execute(`const grip = document.querySelector('.settings-resize')
      grip.focus()
      grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      return true`)
    await settle(500)
    await clickByText(wd, PROVIDER, '')
    await until(() => wd.execute(`return Boolean(document.querySelector('.select-popup'))`), {
      timeout: 5_000,
      what: 'the provider list',
    })
    // The list arrives on the pop rung; a rect read mid-flight is 0.98 of the box.
    await settle(600)
    const list = await wd.execute(READ_LIST)
    await wd.execute(`document.querySelector('${PROVIDER}').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return true`)
    await until(() => wd.execute(`return document.querySelector('.select-popup') === null`), {
      timeout: 5_000,
      what: 'the list to close',
    })

    await wd.execute(`document.querySelector('.settings-overlay')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    return true`)
    await until(() => wd.execute(`return document.querySelector('.settings-dialog') === null`), {
      timeout: 5_000,
      what: 'the dialog to close',
    })

    return {
      viewport: await wd.execute('return { width: innerWidth, height: innerHeight }'),
      /** The AI page at its end before the press, and where the reader was put after it. */
      section: { from, after: afterSection },
      /** The same pair on the agents tree's rail, which shares the container. */
      agents: { from: agentsFrom, after: afterPage },
      list,
      engine: await wd.execute('return navigator.userAgent'),
    }
  },
}
