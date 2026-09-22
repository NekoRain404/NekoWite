/**
 * Can WebKitGTK print at all here — and does it matter who asks?
 *
 * `drive-app.mjs --print` measures what the shipped app does: the export frame is built and filled correctly,
 * `window.print()` returns without throwing, **`beforeprint` never fires**, no dialog window appears, and the
 * frame therefore stays attached until the exporters' five-minute backstop. That is a silent no-op for the
 * user, and the question this probe answers is which half of the stack is responsible: WebKitGTK on this
 * machine, or the embedder (wry/Tauri) the app's page runs inside.
 *
 * So the identical calls are made in **MiniBrowser**, WebKitGTK's own browser, driven the same way:
 *
 *  - `main` — `window.print()` from the page;
 *  - `frame` — `window.print()` from a hidden `srcdoc` frame loaded exactly the way `services/export.ts`
 *    loads its print frame;
 *  - `control-popup` — `window.open()` with a size, which is the control that this instrument *can* see a
 *    new window in this browser. Without it, "no dialog appeared" is a statement about the instrument.
 *
 * `beforeprint`/`afterprint` are recorded on both windows, because they are the engine's own account of
 * whether a print request was accepted: a dialog that fails to appear and a request that was never accepted
 * look identical from the outside.
 *
 * Usage:  xvfb-run -a -s "-screen 0 1280x800x24 -extension GLX" node e2e/webkit/probe-print-dialog.mjs
 * Exit:   0 when the reading is attributable (the popup control appeared) — and it says plainly whether
 *         WebKitGTK printed here or not, since both answers are findings;
 *         1 when nothing can be attributed, which is a failure of this instrument rather than of any build.
 *
 * `GDK_BACKEND=x11` is set on the browser for the same reason the app probe sets it: this machine is a
 * Wayland session, and a GTK dialog would be a compositor surface that `xwininfo` cannot see.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebDriver, freePort, sleep, until } from './webdriver.mjs'
import { closeWindow, screenshotWindow, windowGeometry, windowProperties, xWindows } from './x-windows.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../..')

/** Long enough for a GTK print dialog to appear on a machine whose CUPS socket is stale. */
const PRINT_TIMEOUT_MS = 20_000

/**
 * One page: the two print listeners on the main window, a hidden `srcdoc` frame with the same two on its own
 * window, and a `#result` the probe waits on. No CSP here (MiniBrowser loads this over HTTP), so the inline
 * script is the page's own.
 */
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>print-probe</title></head><body>
<div id="result">pending</div>
<script>
window.__events = []
addEventListener('beforeprint', () => window.__events.push('main:beforeprint'))
addEventListener('afterprint', () => window.__events.push('main:afterprint'))
const frame = document.createElement('iframe')
frame.style.display = 'none'
frame.srcdoc = '<!DOCTYPE html><html><body><div id="who">srcdoc</div></body></html>'
frame.addEventListener('load', () => {
  const w = frame.contentWindow
  w.__events = []
  w.addEventListener('beforeprint', () => w.__events.push('frame:beforeprint'))
  w.addEventListener('afterprint', () => w.__events.push('frame:afterprint'))
  document.getElementById('result').textContent = 'ready'
}, { once: true })
document.body.appendChild(frame)
</script></body></html>`

/** Every window the root owns, minus the ones that were there before — with what they are. */
function newWindows(before, shotDir) {
  return xWindows()
    .filter((w) => !before.some((b) => b.id === w.id))
    .map((w) => {
      let geometry = {}
      try {
        geometry = windowGeometry(w.id)
      } catch {
        geometry = {}
      }
      let properties = {}
      try {
        properties = windowProperties(w.id)
      } catch {
        properties = {}
      }
      try {
        screenshotWindow(w.id, path.join(shotDir, `${w.id.replace('0x', '')}-${w.name || 'unnamed'}.png`))
      } catch {
        /* a picture is a convenience here, never a reading */
      }
      return { ...w, ...geometry, ...properties }
    })
}

const dialogShaped = (w) =>
  (w.width ?? 0) >= 150 && (w.height ?? 0) >= 100 && /IsViewable/.test(w.mapState ?? '') && !/TOOLTIP/.test(w._NET_WM_WINDOW_TYPE ?? '')

async function main() {
  const shotDir = path.join(REPO, 'apps/desktop/src-tauri/target/print-dialog-probe')
  fs.mkdirSync(shotDir, { recursive: true })
  const server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE))
  const httpPort = await freePort()
  await new Promise((resolve) => server.listen(httpPort, '127.0.0.1', resolve))

  const driverPort = await freePort()
  const driver = spawn('/usr/bin/WebKitWebDriver', [`--port=${driverPort}`], {
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
    // The X11 backend on purpose: see this file's header.
    env: { ...process.env, GDK_BACKEND: 'x11' },
  })
  driver.unref()
  const wd = new WebDriver(driverPort)
  const readings = {}
  try {
    await wd.session()
    await wd.navigate(`http://127.0.0.1:${httpPort}/probe.html`)
    readings.pageReady = await until(
      async () => ((await wd.execute(`return document.getElementById('result').textContent`)) === 'ready' ? true : null),
      { timeout: 15_000, what: 'the probe page to finish loading its frame' },
    ).catch(() => false)

    const printAndWatch = async (label, call) => {
      const before = xWindows()
      readings[`${label}Call`] = await wd.execute(call).catch((e) => `threw:${String(e?.message ?? e).slice(0, 120)}`)
      readings[`${label}Dialog`] = await until(
        async () => newWindows(before, shotDir).find(dialogShaped) ?? null,
        { timeout: PRINT_TIMEOUT_MS, what: `a window for ${label}` },
      ).catch(() => null)
      readings[`${label}Windows`] = newWindows(before, shotDir)
      readings[`${label}Events`] = await wd.execute(`return window.__events.join(',') || 'none'`).catch(() => 'unreadable')
      readings[`${label}FrameEvents`] = await wd
        .execute(`const f=document.querySelector('iframe'); return (f && f.contentWindow && f.contentWindow.__events || []).join(',') || 'none'`)
        .catch(() => 'unreadable')
      if (readings[`${label}Dialog`]) closeWindow(readings[`${label}Dialog`].id)
    }

    await printAndWatch('main', `window.print(); return window.__events.join(',') || 'none-synchronously'`)
    await printAndWatch(
      'frame',
      `const f = document.querySelector('iframe'); f.contentWindow.print(); return window.__events.join(',') || 'none-synchronously'`,
    )
    /**
     * The control: a window this instrument must see, in this display, while it is watching.
     *
     * `window.open()` was tried first and produced **nothing** in MiniBrowser (its popup policy refuses, and
     * the reading said "opened" while no window existed) — which made the whole run inconclusive rather than
     * wrong. `xmessage` is a real X client started by this probe, so the control no longer depends on the
     * browser's own policy: if this window is not seen, nothing else here can be attributed.
     */
    const beforeControl = xWindows()
    const control = spawn('xmessage', ['-timeout', '20', 'nekowite print-probe control window'], {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, GDK_BACKEND: 'x11' },
    })
    control.unref()
    readings.controlWindow = await until(
      async () => newWindows(beforeControl, shotDir).find((w) => (w.width ?? 0) >= 50) ?? null,
      { timeout: 10_000, what: 'the xmessage control window' },
    ).catch(() => null)
    readings.controlWindows = newWindows(beforeControl, shotDir)
    try {
      process.kill(-control.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  } finally {
    try {
      await wd.quit()
    } catch {
      /* the session may already be gone */
    }
    try {
      process.kill(-driver.pid, 'SIGKILL')
    } catch {
      /* already dead */
    }
    server.close()
  }

  await sleep(0)
  console.log(JSON.stringify(readings, null, 2))
  if (!readings.controlWindow) {
    console.error('INCONCLUSIVE: the xmessage control window never appeared, so this instrument cannot see a')
    console.error(`new window in this display at all: ${JSON.stringify(readings.controlWindows ?? [])}`)
    process.exitCode = 1
    return
  }
  const printed = /beforeprint/.test(readings.mainEvents ?? '') || readings.mainDialog !== null
  console.log(
    `CONTROL: an xmessage window started by this probe was seen (${readings.controlWindow.width}x${readings.controlWindow.height}),`,
  )
  console.log('         so "no dialog appeared" below is a reading about printing, not about this probe.')
  if (printed) {
    console.log(`PASS: WebKitGTK's own browser accepted window.print() from the page (${readings.mainEvents})`)
    console.log(`      and ${readings.mainDialog ? `showed a dialog (${readings.mainDialog.width}x${readings.mainDialog.height})` : 'showed no dialog'};`)
    console.log(`      from a hidden srcdoc frame it read ${readings.frameEvents}${readings.frameDialog ? ' with a dialog' : ' with no dialog'}.`)
    console.log("      The app's silent no-op is therefore the embedder's or the app's, not this engine's on this machine.")
  } else {
    console.log(`NOTE: WebKitGTK's own browser also did nothing for window.print() (${readings.mainEvents});`)
    console.log(`      from the hidden srcdoc frame as well (${readings.frameEvents}). DOM printing reaches no`)
    console.log('      dialog in this build/environment, whoever embeds it — which is weaker than an app defect')
    console.log('      and must not be reported as one. `drive-app.mjs --print` measures the app half.')
  }
}

await main()
