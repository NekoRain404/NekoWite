/**
 * The settings dialog's corner grip and its agents rail, read on WebKitGTK.
 *
 * The Chromium fence for the numbers here is `e2e/settings-resize.spec.ts` (the drag, the bounds,
 * the keyboard, persistence, the palette and the popups) and `e2e/settings-density.spec.ts` (the
 * rail). What an engine settles for itself is *layout* — where a 16px grip lands inside a 1px
 * border, what a rect reports for a box sized by an inline style, how tall a box is when six of its
 * seven children are `display: none` — so this probe takes the layout readings again here, plus the
 * rail, which is pure layout from end to end.
 *
 * **This is the 6.0-API MiniBrowser, not the shipping 4.1, and both halves of that are in the
 * run's own output.** The session capabilities say `{browserName: MiniBrowser, browserVersion:
 * 2.52.6}` while the page reports `Version/60.5` — the two disagree because they are two different
 * facts: the version string comes off the linked library, and the UA off the `webkitgtk-6.0` build
 * the driver has compiled in. `Cargo.lock` names the app's own linkage, and it is the other one:
 * `webkit2gtk`. Every number below is therefore the 6.0-API engine's. It is still worth taking —
 * `wry` on Linux is WebKitGTK either way, the layout engine is the same family, and a number from
 * the neighbouring API beats no number — provided it is not passed off as the shipping engine's.
 *
 * ## The drag really is driven, and the seam where it is not
 *
 * The **pointer** is the driver's own `performActions` source — `probe-dialog.mjs`'s presses are
 * element clicks, and a `PointerEvent` built in the page is untrusted, so neither reaches a handler
 * that then calls `setPointerCapture`. Measured here at three sizes, the corner lands within **1px**
 * of where the pointer was released each time.
 *
 * The endpoint is not perfectly reliable on this box, and that is why the attempt is wrapped rather
 * than bare: `POST /session/…/actions` has answered **500** for a sequence beginning on the grip
 * inside this dialog, while the identical sequence succeeded on the editor page with the dialog
 * closed. When it refuses, the refusal is recorded verbatim in `pointerDrag.unavailable` and
 * `verify.mjs` reports the check as *unmeasured* instead of as a pass — the one thing worse than a
 * gap in an instrument is a gap that reads green. A hang is treated as a refusal too, on a 15s
 * bound, because a driver that accepts a request and never answers would otherwise take the run
 * down with it.
 *
 * The **keyboard** is dispatched from the page rather than driven, for the same endpoint's sake,
 * and the difference is stated rather than glossed: what that leaves unsettled is only whether a
 * hand's keypress arrives at the handler. The tab order the grip sits in, the arithmetic the
 * handler performs and every number it writes are the engine's, read off the element.
 */
import { clickByText } from './probe-support.mjs'
import { until } from './webdriver.mjs'

/** The shell's settings button — the one trigger this harness has for the dialog. */
const TRIGGER = '.status-btn[title="Settings"]'
const DIALOG = '.settings-dialog'
const GRIP = '.settings-resize'
/** The settings rail's agents row (`SettingsNavigation.vue:27`, label `settings.section.agents`). */
const AGENTS_ROW = 'Agents'

/**
 * The dialog's box, the grip's, and the model's own two numbers.
 *
 * Read off `getBoundingClientRect()` and off the grip's ARIA value rather than off Vue's state: the
 * claim is about what the engine laid out, and a model that agreed with itself would answer both.
 */
const READ = `const box = (el) => {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
}
const dialog = document.querySelector('${DIALOG}')
const grip = document.querySelector('${GRIP}')
const overlay = document.querySelector('.settings-overlay')
if (!dialog || !grip || !overlay) return { error: 'the dialog, its grip or its overlay is missing' }
const cs = getComputedStyle(dialog)
const gs = getComputedStyle(grip)
return {
  dialog: box(dialog),
  grip: box(grip),
  overlay: box(overlay),
  gripStyle: { cursor: gs.cursor, touchAction: gs.touchAction },
  reported: { now: Number(grip.getAttribute('aria-valuenow')), min: Number(grip.getAttribute('aria-valuemin')), max: Number(grip.getAttribute('aria-valuemax')) },
  semantics: { role: grip.getAttribute('role'), orientation: grip.getAttribute('aria-orientation'), tabindex: grip.tabIndex, label: grip.getAttribute('aria-label'), valueText: grip.getAttribute('aria-valuetext') },
  transitionProperty: cs.transitionProperty,
  transitionDuration: cs.transitionDuration
}`

/**
 * One pointer drag through the driver's real input path, or the endpoint's refusal.
 *
 * Bounded by its own timeout because a driver that accepts the request and then never answers would
 * otherwise take the whole run down with it — the failure this records is a *refusal*, and a hang is
 * not one.
 */
async function tryPointerDrag(wd, from, to) {
  const step = (n) => ({
    type: 'pointerMove',
    duration: 0,
    origin: 'viewport',
    x: Math.round(from.x + ((to.x - from.x) * n) / 3),
    y: Math.round(from.y + ((to.y - from.y) * n) / 3),
  })
  const actions = [
    {
      type: 'pointer',
      id: 'mouse',
      parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(from.x), y: Math.round(from.y) },
        { type: 'pointerDown', button: 0 },
        step(1),
        step(2),
        step(3),
        { type: 'pointerUp', button: 0 },
      ],
    },
  ]
  try {
    await Promise.race([
      wd.performActions(actions).then(() => wd.releaseActions()),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('the driver did not answer within 15s')), 15_000),
      ),
    ])
    return { ok: true }
  } catch (error) {
    return { ok: false, unavailable: String(error?.message ?? error).split('\n')[0].slice(0, 200) }
  }
}

export const resizeProbe = {
  name: 'dialog-resize',
  async run(wd) {
    // No `openNote`: the harness has already opened the document and verified the viewport before
    // the probes run, and this one reads a dialog. Going through the file tree again would move
    // which note is open for the probe that runs after it.
    await clickByText(wd, TRIGGER, '')
    await until(() => wd.execute(`return Boolean(document.querySelector('${DIALOG}'))`), {
      timeout: 10_000,
      what: 'the settings dialog',
    })
    // The arrival is a 460ms spring, and a rect read inside it is a reading of the animation rather
    // than of the box — measured once already in Chromium as 709x512 for a 720x520 dialog.
    await until(
      () =>
        wd.execute(
          `const el = document.querySelector('${DIALOG}')
           return el !== null && el.getAnimations().every((a) => a.playState === 'finished')`,
        ),
      { timeout: 10_000, what: 'the dialog arrival to settle' },
    )
    await new Promise((r) => setTimeout(r, 250))

    const start = await wd.execute(READ)
    if (start.error) return start

    // ---- the pointer drag, in this engine's own input path -------------------------------------
    //
    // Three targets, each approached from wherever the last one left the corner, so the relation
    // is checked at sizes other than the one it starts at. The gesture is four moves and a release
    // rather than one, because the handler coalesces writes to one per frame and a single-move
    // drag would never reach the frame it coalesces into.
    const centre = {
      x: start.overlay.left + start.overlay.width / 2,
      y: start.overlay.top + start.overlay.height / 2,
    }
    const drags = []
    let pointerDrag = null
    for (const target of [
      { x: centre.x + 430, y: centre.y + 300 },
      { x: centre.x + 330, y: centre.y + 250 },
      { x: centre.x + 500, y: centre.y + 330 },
    ]) {
      const before = await wd.execute(READ)
      const attempt = await tryPointerDrag(
        wd,
        { x: before.grip.right - 4, y: before.grip.bottom - 4 },
        target,
      )
      if (!attempt.ok) {
        pointerDrag = { unavailable: attempt.unavailable ?? 'the driver refused the drag' }
        break
      }
      await new Promise((r) => setTimeout(r, 200))
      const after = await wd.execute(READ)
      drags.push({
        target,
        width: after.dialog.width,
        height: after.dialog.height,
        // The two numbers the verdict is about: where the pointer was released, and where the
        // dialog's own corner ended up. A drag that used the pointer's *delta* reports a plausible
        // box here and a `cornerGap` of half the distance it should have travelled.
        expectedWidth: 2 * (target.x - centre.x),
        expectedHeight: 2 * (target.y - centre.y),
        cornerGapX: after.grip.right - target.x,
        cornerGapY: after.grip.bottom - target.y,
        // Still centred on the overlay, which is what makes `2 * |p - c|` the relation at all.
        centreGap: Math.abs(
          after.dialog.left - after.overlay.left - (after.overlay.right - after.dialog.right),
        ),
        // The model and the box agree: what a screen reader is told is what was drawn.
        reportedMatchesBox: after.reported.now === Math.round(after.dialog.width),
      })
    }
    if (pointerDrag === null) pointerDrag = { drags }

    // ---- the keyboard: the handler's own arithmetic, and the ends it reaches -------------------
    //
    // Dispatched rather than driven, for the reason in this file's header: the driver's real key
    // input and its real pointer input are the same endpoint, and that endpoint is the one that
    // refuses here. What that leaves unmeasured is only whether a hand's keypress arrives; every
    // number below is the element's own.
    const key = (name) =>
      wd.execute(
        `const el = document.querySelector('${GRIP}')
         el.focus()
         el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true }))
         return document.activeElement === el`,
      )
    const focused = await key('End')
    await new Promise((r) => setTimeout(r, 150))
    const afterEnd = await wd.execute(READ)
    await key('Home')
    await new Promise((r) => setTimeout(r, 150))
    const afterHome = await wd.execute(READ)
    await key('ArrowRight')
    await key('ArrowDown')
    await new Promise((r) => setTimeout(r, 150))
    const afterArrows = await wd.execute(READ)

    // ---- the agents rail, which is layout from end to end -------------------------------------
    //
    // The other half of the same change: seven pages stacked in one scroll became one page at a
    // time behind a rail. The reading is the box the pages live in against the page drawn inside
    // it — two elements, measured independently, that have to agree. A box that kept the six
    // hidden pages' height would be the 4.64 screens this change exists to remove.
    await clickByText(wd, '.dialog-nav .nav-row', AGENTS_ROW)
    await until(() => wd.execute(`return Boolean(document.querySelector('.agents-rail'))`), {
      timeout: 10_000,
      what: 'the agents rail',
    })
    await new Promise((r) => setTimeout(r, 500))
    const agents = await wd.execute(`const box = document.querySelector('[data-test="agents-pages"]')
const rail = document.querySelector('.agents-rail')
const content = document.querySelector('.dialog-content')
if (!box || !rail || !content) return { error: 'the rail, its box or the scroller is missing' }
const pages = Array.from(box.querySelectorAll(':scope > [data-page]'))
const shown = pages.filter((p) => getComputedStyle(p).display !== 'none')
return {
  railRows: rail.querySelectorAll('[role="tab"]').length,
  railOrder: Array.from(rail.querySelectorAll('[role="tab"]')).map((t) => t.dataset.page),
  pages: pages.length,
  drawn: shown.length,
  drawnPage: shown.length === 1 ? shown[0].dataset.page : null,
  boxHeight: Math.round(box.getBoundingClientRect().height),
  drawnHeight: shown.length === 1 ? Math.round(shown[0].getBoundingClientRect().height) : null,
  sectionHeight: Math.round(content.firstElementChild.getBoundingClientRect().height),
  viewport: content.clientHeight,
  contentOverflowX: content.scrollWidth - content.clientWidth,
  railOverflowX: rail.scrollWidth - rail.clientWidth,
}`)

    // ---- and the dialog closed again, through its own control ----------------------------------
    //
    // Not by the status button that opened it: the overlay is `position: fixed; inset: 0` at the
    // top of the app's z-scale, so the button is underneath it and WebDriver refuses the click as
    // intercepted. The close control is inside the dialog, where the pointer can reach it.
    await clickByText(wd, '.settings-close', '', 0)
    await until(() => wd.execute(`return !document.querySelector('${DIALOG}')`), {
      what: 'the dialog to close',
    })

    return {
      viewport: await wd.execute(
        'return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }',
      ),
      start: {
        dialog: { width: start.dialog.width, height: start.dialog.height },
        grip: { width: start.grip.width, height: start.grip.height },
        // The grip's own trailing edges against the dialog's: a grip drawn away from the corner
        // would drag the box from somewhere the user cannot see.
        cornerInset: {
          x: start.dialog.right - start.grip.right,
          y: start.dialog.bottom - start.grip.bottom,
        },
        overlay: { width: start.overlay.width, height: start.overlay.height },
        reported: start.reported,
        semantics: start.semantics,
        gripStyle: start.gripStyle,
      },
      // The absence of an interpolation, read off the live element rather than off the source: a
      // rule a later stylesheet overrode would read clean in the file and animate in the app.
      transition: { property: start.transitionProperty, duration: start.transitionDuration },
      pointerDrag,
      keyboard: {
        focused,
        end: { width: afterEnd.dialog.width, height: afterEnd.dialog.height },
        home: { width: afterHome.dialog.width, height: afterHome.dialog.height },
        arrows: { width: afterArrows.dialog.width, height: afterArrows.dialog.height },
      },
      agents,
    }
  },
}
