/**
 * The PDF export, driven as far as its dialog: the note menu, the print request, and the document behind it.
 *
 * Three shipped facts live here that nothing else in the repository can see. `services/export.ts` builds a
 * hidden `<iframe>`, writes the rendered note into it and calls `window.print()`; the unit tests assert
 * against the `srcdoc` **attribute** with a fake document, so they cannot tell a loaded frame from one the
 * engine refused, and the Playwright suite runs Chromium without the app's policy or its host. And the
 * dialog itself is a GTK window: no WebDriver endpoint can see one, no script can query one.
 *
 * So this measures, on the built application: the note menu opened by a **native right-click**, the export
 * item clicked, the **X tree** before and after, the frame's document read out of the page, the print
 * request repeated inside the app's own frame and from the main frame with `beforeprint`/`afterprint`
 * recorded (the engine's own account of whether it accepted the call), and the frame's removal after the
 * dialog is dismissed.
 *
 * Split out of `drive-app.mjs`, which owns the session and is the only place that can supply `run`,
 * `script` and `findElement`; that file's budget is 800 lines and this is a measurement of its own.
 */
import fs from 'node:fs'
import path from 'node:path'
import { until } from './webdriver.mjs'
import { closeWindow, pressKeyAt, screenshotWindow, windowGeometry, windowProperties, xWindows } from './x-windows.mjs'

/**
 * How long a *dialog-shaped* window is waited for. Long on purpose: the dialog is a GTK print dialog, and
 * GTK builds one around a CUPS query before it maps anything — a wait that stops at the first new window
 * accepts a leftover tooltip in its place, which is exactly what the first version of this stage did.
 */
const PRINT_DIALOG_TIMEOUT_MS = 45_000

/**
 * How long the export is watched for **either** outcome: the dialog, or the app's own notice that there
 * will not be one. The notice is written ten seconds after the export starts (`PRINT_OUTCOME_DEADLINE_MS`
 * in `services/export.ts`) and the toast is dismissed in seconds, so the window has to be wide enough for
 * both clocks — a dialog can take most of the timeout below to be built on a machine with a slow CUPS.
 */
const PRINT_OUTCOME_TIMEOUT_MS = 60_000

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'

/** The card's own in-view centre, and the viewport it has to be inside for a viewport-origin pointer move. */
const CARD_RECT_SCRIPT = `const r = arguments[0].getBoundingClientRect()
return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
         innerWidth: window.innerWidth, innerHeight: window.innerHeight }`

/**
 * What the export frame is holding, read from the page while its dialog is up.
 *
 * The frame is `display: none` and its document is written by `renderForPrint`, so this reads the three
 * things that decide whether the export is real: the document arrived, the `@page` rule the settings asked
 * for is inside it, and its `asset://` image resolved (`naturalWidth > 0` — the failure a browser test with
 * a stubbed host cannot have).
 */
const PRINT_FRAME_SCRIPT = `
const frames = Array.from(document.querySelectorAll('iframe'))
const srcdocFrames = frames.filter((f) => (f.getAttribute('srcdoc') ?? '').length > 0)
const frame = srcdocFrames[0] ?? null
if (!frame) return { frames: frames.length, srcdocFrames: 0 }
const doc = frame.contentDocument
const style = doc && doc.querySelector ? doc.querySelector('style[data-neko-export-page]') : null
return {
  frames: frames.length,
  srcdocFrames: srcdocFrames.length,
  docLength: doc && doc.documentElement ? doc.documentElement.innerHTML.length : -1,
  pageRule: style ? (style.textContent ?? '').slice(0, 100) : null,
  text: doc && doc.body ? doc.body.innerText.replace(/\\s+/g, ' ').slice(0, 100) : null,
  images: Array.from((doc && doc.images) || []).map((img) => ({
    src: (img.getAttribute('src') ?? '').slice(0, 48),
    loaded: img.complete && img.naturalWidth > 0,
    naturalWidth: img.naturalWidth,
  })),
}
`

/**
 * Arm the two print events on a window and call `print()` on it, returning whatever fired **before the call
 * returned**. `beforeprint` is the engine saying it accepted the request — the reading that separates "no
 * dialog appeared" from "the request never reached the printing machinery" — and `afterprint` is the signal
 * `services/export.ts` removes the frame on, so both are worth having.
 */
const printIn = (target) => `
const w = ${target}
if (!w) return 'no-frame'
w.__probePrint = []
w.addEventListener('beforeprint', () => w.__probePrint.push('beforeprint'), { once: true })
w.addEventListener('afterprint', () => w.__probePrint.push('afterprint'), { once: true })
try {
  w.print()
} catch (e) {
  return 'threw:' + (e && e.message ? e.message : String(e))
}
return w.__probePrint.length ? w.__probePrint.join(',') : 'none-synchronously'
`

const EXPORT_FRAME_WINDOW = `(Array.from(document.querySelectorAll('iframe')).find((f) => (f.getAttribute('srcdoc') ?? '').length > 0) || {}).contentWindow`
const readEvents = (target) => `return (${target}.__probePrint || []).join(',') || 'none'`

/**
 * Measure the export. `readings` is filled in place; every driver call is reported rather than thrown, so a
 * failure here still prints what it saw — the first run of this stage died on a request timeout with a
 * stack trace and no readings at all.
 */
export async function measurePrintDialog({ run, script, findElement, readings, shotDir }) {
  // The window list is read **before** the session is touched, and recorded even when the rest fails: a
  // native dialog left over from an earlier step is modal, so the next driver call is what hangs.
  let before = []
  try {
    before = xWindows()
  } catch (e) {
    readings.couldNotReadXWindows = `unreadable: ${String(e?.message ?? e).slice(0, 120)}`
  }
  readings.windowsBeforeExport = before.map((w) => w.name || w.id)
  fs.mkdirSync(shotDir, { recursive: true })

  const attempt = async (what, call) => {
    try {
      return { ok: true, value: await call() }
    } catch (e) {
      return { ok: false, error: `unreachable: ${what}: ${String(e?.message ?? e).slice(0, 120)}` }
    }
  }

  const ready = await attempt('readyState', () => run('POST', '/execute/sync', script('return document.readyState')))
  readings.sessionReachable = ready.ok ? ready.value : ready.error
  const frames = await attempt('frame count', () =>
    run('POST', '/execute/sync', script('return document.querySelectorAll("iframe").length')),
  )
  readings.framesBefore = frames.ok ? frames.value : frames.error

  // A **native** right-click through the driver's actions: the app's own `contextmenu` handler is what
  // records which note the menu acts on, so a synthetic event would test the handler's listener rather than
  // the path a user's mouse takes.
  const card = await attempt('the note card', () => findElement('css selector', 'article.note-card'))
  readings.cardFound = card.ok && card.value !== null
  if (!card.ok) readings.cardError = card.error
  if (!readings.cardFound) return

  // The pointer goes to the card's own in-view coordinates with `origin: 'viewport'`, which is how every
  // other pointer instrument in this directory drives WebKitGTK. An element origin was tried first and
  // **hangs** — the request never answers and the driver times out — so this is a measured property of the
  // driver rather than a preference.
  const rect = await attempt('the card rect', () =>
    run('POST', '/execute/sync', { script: CARD_RECT_SCRIPT, args: [{ [ELEMENT_KEY]: card.value }] }),
  )
  readings.cardRect = rect.ok ? rect.value : rect.error
  const point =
    rect.ok && rect.value
      ? {
          x: rect.value.x + Math.min(5, Math.max(0, rect.value.w - 1)),
          y: rect.value.y + Math.min(5, Math.max(0, rect.value.h - 1)),
        }
      : null
  readings.cardPoint = point
  const inside =
    point !== null &&
    point.x > 0 &&
    point.y > 0 &&
    point.x < (rect.value.innerWidth ?? 0) &&
    point.y < (rect.value.innerHeight ?? 0)
  if (!inside) {
    readings.rightClickError = `the card is not inside the viewport (${JSON.stringify(rect.ok ? rect.value : null)})`
    return
  }
  const clicked = await attempt('the right-click', () =>
    run('POST', '/actions', {
      actions: [
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', duration: 0, origin: 'viewport', x: point.x, y: point.y },
            { type: 'pointerDown', button: 2 },
            { type: 'pointerUp', button: 2 },
          ],
        },
      ],
    }),
  )
  if (!clicked.ok) readings.rightClickError = clicked.error

  // Found by its label rather than by its index: the menu is built from the note's state, so the order is
  // not this probe's business. Case is folded because the app's language is a user setting.
  const exportItem = await until(
    async () =>
      findElement('xpath', '//button[@role="menuitem"][contains(translate(., "pdf", "PDF"), "PDF")]').catch(
        () => null,
      ),
    { timeout: 8_000, what: 'the note menu to offer the PDF export' },
  ).catch(() => null)
  readings.menuItemFound = exportItem !== null
  if (!exportItem) return
  await run('POST', `/element/${exportItem}/click`, {})

  const newWindows = () => xWindows().filter((w) => !before.some((b) => b.id === w.id))
  /** Everything the probe can know about one window: for the record, and for the classification below. */
  const describe = (w) => {
    const shot = path.join(shotDir, `${w.id.replace('0x', '')}-${w.name || 'unnamed'}.png`)
    let geometry = {}
    let properties = {}
    try {
      geometry = windowGeometry(w.id)
    } catch (e) {
      geometry = { geometry: `unreadable: ${String(e?.message ?? e).slice(0, 80)}` }
    }
    try {
      properties = windowProperties(w.id)
    } catch (e) {
      properties = { properties: `unreadable: ${String(e?.message ?? e).slice(0, 80)}` }
    }
    return { ...w, ...geometry, ...properties, screenshot: screenshotWindow(w.id, shot) === true ? shot : 'no' }
  }
  /**
   * A dialog is a *visible, dialog-sized* window. Two things this excludes were both read as "the print
   * dialog" before it was written: the app's own 1x1 and 10x10 helper windows, and the **tooltip** a
   * right-click leaves behind — 639x66, `_NET_WM_WINDOW_TYPE_TOOLTIP`, transient for the main window, which
   * the first version of this stage duly reported as a dialog no user would ever see. `xprop` tells them
   * apart and the screenshot confirmed it.
   */
  const dialogShaped = (w) =>
    (w.width ?? 0) >= 200 &&
    (w.height ?? 0) >= 200 &&
    /IsViewable/.test(w.mapState ?? '') &&
    !/TOOLTIP|POPUP|DND|COMBO|MENU/.test(w._NET_WM_WINDOW_TYPE ?? '')
  const waitForDialog = (what) =>
    until(
      async () => newWindows().map(describe).find(dialogShaped) ?? null,
      { timeout: PRINT_DIALOG_TIMEOUT_MS, what },
    ).catch(() => null)

  /**
   * Either the system printed or the app said why it could not — and **one poll for both**, because the
   * two arrive on different clocks: a dialog appears at once where printing works, and the notice is
   * written ten seconds after the export starts (`PRINT_OUTCOME_DEADLINE_MS` in `services/export.ts`).
   * Reading them in sequence hides one behind the other, which is exactly what the first version of this
   * did: it waited the dialog's full 45 seconds and then looked for a toast that had already been
   * dismissed.
   */
  const described = new Map()
  /** Each window is described once: `xprop` and a screenshot per poll iteration is work for no new reading. */
  const describeOnce = (w) => {
    if (!described.has(w.id)) described.set(w.id, describe(w))
    return described.get(w.id)
  }
  const toastText = () =>
    run(
      'POST',
      '/execute/sync',
      script('return Array.from(document.querySelectorAll(".toast")).map((t) => t.textContent.trim()).join(" | ")'),
    ).catch(() => null)
  const firstOutcome = await until(
    async () => {
      const notice = await toastText()
      if (typeof notice === 'string' && notice.length > 0) return { notice }
      const dialog = newWindows().map(describeOnce).find(dialogShaped)
      return dialog ? { dialog } : null
    },
    { timeout: PRINT_OUTCOME_TIMEOUT_MS, what: "a print dialog or the export's own notice" },
  ).catch(() => null)
  readings.exportNotice = firstOutcome?.notice ?? null
  readings.dialogWindow = firstOutcome?.dialog ?? null
  readings.printFrame = await run('POST', '/execute/sync', script(PRINT_FRAME_SCRIPT)).catch(
    (e) => `unreadable: ${String(e?.message ?? e).slice(0, 160)}`,
  )
  readings.printWindows = newWindows().map(describeOnce)

  if (readings.dialogWindow === null) {
    // No dialog from the app's own export. The same call is then made **in the app's own frame** and, if
    // that is silent too, from the main frame — so the next reading separates "this frame cannot print"
    // from "printing reaches no dialog in this webview at all".
    readings.exportFramePrint = await attempt('the export frame print', () =>
      run('POST', '/execute/sync', script(printIn(EXPORT_FRAME_WINDOW))),
    ).then((r) => (r.ok ? r.value : r.error))
    readings.exportFrameDialog = await waitForDialog('a dialog-sized window for the export frame\'s own print')
    readings.exportFrameEventsAfter = await run('POST', '/execute/sync', script(readEvents(EXPORT_FRAME_WINDOW))).catch(
      (e) => `unreadable: ${String(e?.message ?? e).slice(0, 120)}`,
    )
    if (readings.exportFrameDialog === null) {
      readings.mainFramePrint = await attempt('the main frame print', () =>
        run('POST', '/execute/sync', script(printIn('window'))),
      ).then((r) => (r.ok ? r.value : r.error))
      readings.mainFrameDialog = await waitForDialog('a dialog-sized window for the main frame\'s print')
      readings.mainFrameEventsAfter = await run('POST', '/execute/sync', script(readEvents('window'))).catch(
        (e) => `unreadable: ${String(e?.message ?? e).slice(0, 120)}`,
      )
    }
  }

  /**
   * The frame is the app's to remove: `exportToPdf` keeps the hidden iframe attached until the frame's own
   * `afterprint` arrives, with a five-minute backstop for a webview that never fires it. So "the dialog
   * closed and the frame is still here" is a reading about the app's cleanup, and it is worth something only
   * if the dialog really closed — which is what the two attempts and the window list afterwards are for.
   */
  const frameGone = async (timeout, what) =>
    until(
      async () => {
        const count = await run('POST', '/execute/sync', script('return document.querySelectorAll("iframe").length'))
        return count <= (readings.framesBefore ?? 0) ? count : null
      },
      { timeout, what },
    ).catch(() => -1)
  // First the way a window manager closes it: `WM_DELETE_WINDOW`, which a GTK dialog handles as "cancel" —
  // the user's own way out. Every window the export opened is closed, dialog or not.
  for (const w of [readings.dialogWindow, readings.exportFrameDialog, readings.mainFrameDialog, ...readings.printWindows]) {
    if (w && typeof w === 'object' && w.id) closeWindow(w.id)
  }
  readings.framesAfterWindowclose = await frameGone(15_000, 'the export frame to be removed after the dialog closed')
  const printed = readings.dialogWindow ?? readings.exportFrameDialog ?? readings.mainFrameDialog
  if (readings.framesAfterWindowclose < 0 && printed) {
    const { x, y, width, height } = printed
    if ([x, y, width, height].every((n) => typeof n === 'number')) {
      pressKeyAt(x + Math.round(width / 2), y + Math.round(height / 2), 'Escape')
      readings.framesAfterEscape = await frameGone(10_000, 'the export frame to be removed after Escape')
    }
  }
  readings.exportFrameEventsAfterClose = await run(
    'POST',
    '/execute/sync',
    script(readEvents(EXPORT_FRAME_WINDOW)),
  ).catch((e) => `unreadable: ${String(e?.message ?? e).slice(0, 120)}`)
  readings.windowsAfterClose = xWindows()
  // By **id**, not by name: the app's own windows are named "nekowite" too, so a name comparison answers
  // "is any window of that name open", which is always yes.
  readings.dialogStillOpen = [readings.dialogWindow, readings.exportFrameDialog, readings.mainFrameDialog].some(
    (w) => w && readings.windowsAfterClose.some((a) => a.id === w.id),
  )
}
