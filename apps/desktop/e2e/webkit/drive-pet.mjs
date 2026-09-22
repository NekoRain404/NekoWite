/**
 * The desktop pet's own windows.
 *
 * The ball and the character are separate webviews, and every other instrument switches **away** from them:
 * the driver's session attaches to one of the app's windows (on this build, the ball) and `drive-app.mjs`
 * selects the main one for everything it reads. So a pet window whose page failed to render has never had
 * anything looking at it.
 *
 * The two draw different things, which is why the reading is per window rather than one shape for both: the
 * ball is DOM (`.pet-ball` with its orb and face) and the character is a **canvas** (`PetSprite` paints into
 * one), so a reading that only counted text would call a working character window empty. The canvas is read by
 * its backing size rather than by its pixels — `0x0` is a canvas that was never laid out.
 *
 * Split out of `drive-app.mjs`, which owns the session and supplies `run` and `script`.
 */
import { sleep } from './webdriver.mjs'

/** What one pet window's page is showing. */
const PET_WINDOW_SCRIPT = `
const canvas = document.querySelector('canvas')
return {
  readyState: document.readyState,
  title: document.title,
  tauri: Boolean(window.__TAURI_INTERNALS__),
  balls: document.querySelectorAll('.pet-ball').length,
  sprites: document.querySelectorAll('.pet-sprite').length,
  canvases: document.querySelectorAll('canvas').length,
  canvasSize: canvas ? { width: canvas.width, height: canvas.height } : null,
  text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
}
`

/** Read every window the session knows about, and leave it on the main one. */
export async function readPetWindows({ run, script, readings }) {
  const handles = Array.isArray(readings.handles) ? readings.handles : []
  const petWindows = []
  for (const handle of handles) {
    await run('POST', '/window', { handle }).catch(() => undefined)
    const url = await run('GET', '/url').catch(() => '')
    const page = await run('POST', '/execute/sync', script(PET_WINDOW_SCRIPT)).catch(
      (e) => `unreadable: ${String(e?.message ?? e).slice(0, 140)}`,
    )
    petWindows.push({
      handle: String(handle).slice(5, 13),
      url: String(url).slice(0, 80),
      ...(page !== null && typeof page === 'object' ? page : { error: page }),
    })
  }
  readings.petWindows = petWindows
  // Back to the main window: every stage after this one reads the shell, and the driver's session is attached
  // to one window at a time. The pet's pages are the ones that name `desktop-pet`.
  for (const handle of handles) {
    await run('POST', '/window', { handle }).catch(() => undefined)
    const url = await run('GET', '/url').catch(() => '')
    if (!String(url).includes('desktop-pet')) break
  }
  // A short grace period: the switch above is asynchronous in the driver, and the next stage's first read
  // must land on the main window rather than on a pet page mid-switch.
  await sleep(150)
}
