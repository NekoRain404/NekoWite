/**
 * Drive the real application — its own window, its own WebView, its own vault.
 *
 * Every other instrument in this directory drives MiniBrowser: the same engine family, but not the app —
 * no Tauri IPC, no `asset:` protocol, no `tauri.conf.json` CSP, no window built by `wry`. This one starts
 * the **built application** under `tauri-driver` (whose WebDriver proxy hands sessions to the WebView
 * inside it) and reads that page directly. That is the only instrument here that can answer questions
 * about the shipped page rather than about a page that resembles it.
 *
 * ## How a vault gets opened without a folder dialog
 *
 * The app's own rule (`open_file.rs`) is that the *command line* is a fact the renderer cannot
 * manufacture, so a path from it is vouched for exactly like a folder-dialog pick, while a path from the
 * session bus never creates a root. A folder dialog cannot be driven from here, so the probe uses the
 * other half of the same design: it writes the backend's own record of the last vault
 * (`<config dir>/dev.nekowite.app/last-vault`, one line, read by `state/remembered.rs`) into a scratch
 * config directory, and puts the same path in the renderer's `nekowite.vault` key.
 * `VaultRegistry::register` accepts a root it remembers (`vault_confinement.rs`'s `recalled`), which is
 * what lets the app restore a vault it was told about before — no dialog, and no test-only back door.
 *
 * ## Readings, and the control that makes them attributable
 *
 *  1. the app boots at all and its page finished loading (`document.readyState`);
 *  2. it is a **Tauri** page — `window.__TAURI_INTERNALS__` is present, which is what separates it from
 *     the browser demo the same sources also build;
 *  3. `eval` is refused: this app's CSP allows `'wasm-unsafe-eval'` and not `'unsafe-eval'`, so this is
 *     the control proving the policy is in force *in this script context*. WebDriver scripts are injected
 *     into the page realm and an engine may exempt them, so if `eval` were allowed the next reading could
 *     not be attributed — and the probe says so rather than reading green;
 *  4. a blob module import is refused — the assertion `docs/SECURITY.md` §2 rests on, measured here where
 *     it actually ships rather than on a synthetic page carrying the same policy string;
 *  5. the vault opened: the shell's status bar rendered and the note the probe planted is in the tree;
 *  6. the note opened by a native click, its image rendered through the host's asset protocol;
 *  7. real key events reached the editor and `Ctrl+S` put them in the file on disk;
 *  8. with `--print`: the export menu was opened by a native right-click, the PDF export reached a
 *     **GTK print dialog** (visible only in the X tree), the document behind it carries the `@page`
 *     rule and its `asset://` image resolved, and closing the dialog removed the export frame.
 *
 * Usage:
 *   xvfb-run -a -s "-screen 0 1280x800x24 -extension GLX" node e2e/webkit/drive-app.mjs
 *   node e2e/webkit/drive-app.mjs --app <path>          # a different build
 *   node e2e/webkit/drive-app.mjs --print              # and drive the PDF export as far as its dialog
 *
 * Exit: 0 when every reading holds, 1 otherwise. It needs no window manager (nothing here reads
 * geometry) and it writes nothing outside the repository: the app's config, data and state all live in
 * the git-ignored scratch.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { measurePrintDialog } from './drive-print.mjs'
import { seedVault } from './drive-vault.mjs'
import { freeDualPort, sleep, until } from './webdriver.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../..')

/** No request may hang: a proxy that accepts a connection and never answers is a failure to report. */
const REQUEST_TIMEOUT_MS = 15_000

/** Starting the application is not a request like the others: see the session stage below. */
const SESSION_TIMEOUT_MS = 120_000

const APP = (() => {
  const flag = process.argv.indexOf('--app')
  const given = flag === -1 ? null : process.argv[flag + 1]
  const app = given ?? path.join(REPO, 'apps/desktop/src-tauri/target/release/nekowite')
  if (!fs.existsSync(app)) {
    console.error(`FAIL: no application to drive at ${app}`)
    console.error('build one first: pnpm --filter @nekowite/desktop exec tauri build --no-bundle')
    process.exit(1)
  }
  return app
})()

/** Everything the app writes goes to the repository's scratch, never to the invoking user's home. */
const SCRATCH_ROOT = path.join(REPO, '.tmp-review-pnpm')
const ENV = {
  ...process.env,
  XDG_DATA_HOME: path.join(SCRATCH_ROOT, 'data'),
  XDG_CACHE_HOME: path.join(SCRATCH_ROOT, 'cache'),
  XDG_STATE_HOME: path.join(SCRATCH_ROOT, 'state'),
  XDG_CONFIG_HOME: path.join(SCRATCH_ROOT, 'config'),
  // **The X11 backend, on purpose, and it is not a preference.** This machine is a Wayland session
  // (`WAYLAND_DISPLAY` is set), and GTK prefers Wayland when it is offered — so the app's windows, and
  // every GTK dialog it opens, would be compositor surfaces that `xwininfo` and `xdotool` cannot see.
  // Measured while writing `--print`: `xwininfo -root -children` listed **zero** windows for a *running*
  // app, which reads exactly like "no print dialog ever appeared". Forcing the app onto the probe's own
  // `Xvfb` display is what makes the dialog observable at all; the cost is that the dialog reading is the
  // X11 GTK backend's, and the print machinery behind it is WebKitGTK's either way.
  GDK_BACKEND: 'x11',
}

const NOTE = 'probe-note.md'
/** The note's H1, which is the text the tree shows: a note without frontmatter is titled by its heading. */
const NOTE_TITLE = 'drive-probe-note'
/**
 * What the probe types. ASCII and no spaces, so every character is one key event, and **unique to this
 * run** so the text found afterwards can only be this run's keystrokes. (`seedProbeVault` rewrites the note
 * before each run, so a fixed token could not survive in the *file* — but the editor could still be
 * holding a buffer from an earlier session, and a reading that cannot tell those apart is worth one
 * `process.pid` to make unambiguous.)
 */
const TYPED_TOKEN = `probe-typed-${process.pid}`
/** The scratch vault's directory name; the shell shows it, so the verdict can too. */
const VAULT_DIR = path.join(REPO, 'apps/desktop/src-tauri/target/drive-app-vault')
/**
 * Whether this run also drives the PDF export. Off by default because that export ends in a **modal GTK
 * print dialog**: the run has to open one and close it again, which is a heavier, more environment-bound
 * reading than the rest — and one a machine with no print backend at all can only fail.
 */
const PRINT = process.argv.includes('--print')
/** Where the dialog's own picture is written: the git-ignored target tree, beside the other probe output. */
const PRINT_SHOT_DIR = path.join(REPO, 'apps/desktop/src-tauri/target/drive-app-print')

/** The probe's vault: one note, the image beside it, and the record that makes it the last one opened. */
function seedProbeVault() {
  return seedVault({
    dir: VAULT_DIR,
    configHome: ENV.XDG_CONFIG_HOME,
    files: {
      // An image beside the note, referenced the ordinary way. Whatever the editor renders for it has to
      // come through the host: the frontend asks for a media path, `commands/fs/media.rs` grants that one
      // file on the asset scope, and the window fetches `asset://…`. Nothing in a browser test can prove
      // that chain.
      'probe-asset.svg':
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="40"><rect width="64" height="40" fill="#3b82f6"/></svg>\n',
      [NOTE]: `# ${NOTE_TITLE}\n\n![probe](probe-asset.svg)\n\nWritten by drive-app.mjs.\n`,
    },
  })
}

/** Progress on stderr as it happens: a probe that dies silently names nothing. */
const stage = (what) => console.error(`--- ${what}`)

/**
 * What the export frame is holding, read from the page while its dialog is up.
 *
 * The frame is `display: none` and its document is written by `renderForPrint`, so this reads the three
 * things that decide whether the export is real: the document arrived, the `@page` rule the settings
 * asked for is inside it, and its `asset://` image resolved (`naturalWidth > 0` — the failure a browser
 * test with a stubbed host cannot have). It counts frames rather than assuming the export's is the only
 * one, so the "was it cleaned up" reading afterwards is a difference and not a guess.
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

async function request(port, method, suffix, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  const res = await fetch(`http://127.0.0.1:${port}${suffix}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const json = text === '' ? null : JSON.parse(text)
  if (!res.ok) throw new Error(`${method} ${suffix} -> ${res.status}: ${json?.value?.message ?? text}`)
  return json?.value
}

async function main() {
  stage('seed the vault')
  const vault = seedProbeVault()

  stage('ports')
  // A port that is free for Node to bind is not necessarily free for WebKitWebDriver, which binds
  // `local` rather than `127.0.0.1`: this sandbox keeps sockets in LISTEN whose owning processes are
  // already gone (`ss -ltnpe` shows the port, `ps` shows nobody), and one of them can be handed out by
  // `freePort()` and then refuse the driver. So the ports are chosen by trying: spawn, read the driver's
  // own log, and move on if it says it could not listen. The attempt count is printed, because a probe
  // that needs four tries is telling its reader something about the machine.
  const webkitPort = await freeDualPort()
  const driverPort = await freeDualPort()
  // Both proxies write to files, not to the terminal: when a session is refused the driver's own
  // sentence ("Unable to listen for HTTP server at host local and port N") is the only evidence there
  // is, and a probe that says only "timed out waiting for a session" costs its reader the hour this
  // comment was written after.
  const logDir = path.join(REPO, 'apps/desktop/src-tauri/target')
  const webkitLog = path.join(logDir, 'drive-app-webkit.log')
  const driverLog = path.join(logDir, 'drive-app-tauri-driver.log')
  // **`tauri-driver` starts the native driver itself** — that is what `--native-driver` is for. Spawning
  // one here as well put two WebKitWebDriver instances on one port: whichever lost the bind wrote
  // "Unable to listen for HTTP server at host local and port N" into the *inherited* log, the winner was
  // orphaned, and every session hung until the client gave up (`hyper::Error(IncompleteMessage)` in
  // tauri-driver's log). The first runs of this probe happened to win that race, which is what made it
  // look like a port-privacy problem. So: one spawn, tauri-driver's, and this file only chooses the ports.
  let driver = spawn(
    'tauri-driver',
    ['--port', String(driverPort), '--native-port', String(webkitPort), '--native-driver', '/usr/bin/WebKitWebDriver'],
    { stdio: ['ignore', fs.openSync(driverLog, 'w'), fs.openSync(driverLog, 'a')], detached: true, env: ENV },
  )
  driver.unref()
  await sleep(800)
  if (fs.existsSync(driverLog) && fs.readFileSync(driverLog, 'utf8').includes('Unable to listen')) {
    console.error('FAIL: a driver could not bind its port; its own words follow')
    console.error(driverLog.includes('x') ? '' : '')
    console.error(fs.readFileSync(driverLog, 'utf8').trim().slice(0, 400))
    process.exit(1)
  }
  console.error(`--- ports native=${webkitPort} proxy=${driverPort}`)

  /** The drivers' own last words, for a failure that would otherwise name only a timeout. */
  const driverTail = () => {
    const tail = (file) =>
      fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !/^\s*$/.test(l)).slice(-4).join('\n    ')
        : '(no log)'
    return `tauri-driver:\n    ${tail(driverLog)}\n  WebKitWebDriver:\n    ${tail(webkitLog)}`
  }

  const session = { id: null, port: driverPort }
  const run = (method, suffix, body) => request(session.port, method, `/session/${session.id}${suffix}`, body)
  const script = (source) => ({ script: source, args: [] })
  /** One key down/up pair, in the driver's actions format. */
  const keyPair = (value) => [
    { type: 'keyDown', value },
    { type: 'keyUp', value },
  ]

  /** Type `text` as real key events — never a synthetic KeyboardEvent, which would test a listener. */
  async function typeText(text) {
    await run('POST', '/actions', {
      actions: [{ type: 'key', id: 'keyboard', actions: [...text].flatMap((ch) => keyPair(ch)) }],
    })
  }

  /** Ctrl+S. `\uE009` is the WebDriver codepoint for the control key. */
  async function pressCtrlS() {
    await run('POST', '/actions', {
      actions: [
        {
          type: 'key',
          id: 'keyboard',
          actions: [
            { type: 'keyDown', value: '\uE009' },
            { type: 'keyDown', value: 's' },
            { type: 'keyUp', value: 's' },
            { type: 'keyUp', value: '\uE009' },
          ],
        },
      ],
    })
  }

  /** The W3C element key, and the element id behind it. */
  const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'
  async function findElement(using, value) {
    const found = await run('POST', '/element', { using, value })
    return found?.[ELEMENT_KEY] ?? null
  }

  const readings = {}
  try {
    stage('session')
    // Both proxies bind asynchronously; the first attempt is retried rather than raced.
    session.id = await until(
      async () =>
        // The session is the heavy one: tauri-driver does not answer until WebKitWebDriver has launched
        // the app and its first page is up, and an app that boots straight into a vault takes longer than
        // one that shows the welcome screen. A 15 s deadline turned that into `hyper::Error
        // (IncompleteMessage)` in the driver's log — the client hanging up mid-request — which is a
        // failure of this probe's patience rather than of the app.
        request(
          session.port,
          'POST',
          '/session',
          { capabilities: { alwaysMatch: { 'tauri:options': { application: APP } } } },
          SESSION_TIMEOUT_MS,
        )
          .then((value) => value?.sessionId ?? null)
          .catch(() => null),
      { timeout: SESSION_TIMEOUT_MS, what: 'tauri-driver to accept a session' },
    ).catch((e) => {
      console.error(`${e.message}\n  ${driverTail()}`)
      throw e
    })

    stage('page')
    readings.readyState = await until(
      async () => {
        const state = await run('POST', '/execute/sync', script('return document.readyState')).catch(() => null)
        return state === 'complete' ? state : null
      },
      { timeout: 30_000, what: 'the app page to finish loading' },
    )
    readings.title = await run('POST', '/execute/sync', script('return document.title'))
    // This app has more than one window (the editor, and the desktop pet's ball and character), and the
    // driver's session is attached to one of them. Which one is the difference between reading the app and
    // reading a pet window, so it is recorded before anything is asserted about the shell.
    readings.handles = await run('GET', '/window/handles').catch((e) => `unsupported: ${String(e?.message ?? e).slice(0, 120)}`)
    // **Which window the session is attached to is not this probe's choice.** The app opens three pages
    // — the editor and the desktop pet's ball and character — and the driver attaches to one of them; on
    // this build it is the ball, whose page has no shell at all. Every reading about the editor therefore
    // has to select the main window first, or it measures a pet window and reports the app broken.
    if (Array.isArray(readings.handles)) {
      for (const handle of readings.handles) {
        await run('POST', '/window', { handle })
        const url = await run('GET', '/url')
        readings.urls = { ...(readings.urls ?? {}), [String(handle).slice(5, 13)]: url }
        if (!String(url).includes('desktop-pet')) break
      }
    }
    readings.url = await run('GET', '/url').catch((e) => `unreadable: ${String(e?.message ?? e).slice(0, 120)}`)
    readings.tauri = await run('POST', '/execute/sync', script('return Boolean(window.__TAURI_INTERNALS__)'))

    stage('csp control (eval)')
    readings.evalAllowed = await run(
      'POST',
      '/execute/sync',
      script(`try { eval('1 + 1'); return 'allowed' } catch (e) { return 'blocked' }`),
    )

    stage('csp blob import')
    readings.blobImport = await run('POST', '/execute/async', {
      script: `const done = arguments[arguments.length - 1]
        const url = URL.createObjectURL(new Blob(['export default 1'], { type: 'text/javascript' }))
        import(url).then(() => done('allowed'), (e) => done('blocked:' + (e && e.message ? e.message : e)))`,
      args: [],
    })

    stage('open the vault')
    // The renderer's own key, then a reload: this is the path a returning user takes, and `recalled` in
    // `vault_confinement.rs` is what accepts the root.
    await run('POST', '/execute/sync', {
      script: `localStorage.setItem('nekowite.vault', arguments[0]); return true`,
      args: [vault],
    })
    // `{}` rather than no body: this driver refuses a POST with an empty body ("Invalid JSON in request
    // body"), which reads as a driver capability until the body is sent.
    await run('POST', '/refresh', {})
    readings.railButtons = await until(
      async () => {
        const count = await run('POST', '/execute/sync', script('return document.querySelectorAll(".status-btn").length'))
        return count >= 1 ? count : null
      },
      { timeout: 30_000, what: 'the shell to render with a vault open' },
    ).catch(async () => {
      // A probe that fails without saying what the page shows costs the next reader the same hour this
      // cost. These three readings are what a stuck vault restore looks like from the outside.
      // Errors are recorded, not swallowed to null: a null reading cannot tell "the page says nothing"
      // from "the command failed", and that difference is the whole diagnosis.
      const detail = (e) => String(e?.message ?? e).slice(0, 200)
      readings.vaultKey = await run('POST', '/execute/sync', {
        script: `return localStorage.getItem('nekowite.vault')`,
        args: [],
      }).catch(detail)
      readings.pageText = await run('POST', '/execute/sync', {
        script: 'return document.body.innerText.slice(0, 300)',
        args: [],
      }).catch(detail)
      readings.url = await run('GET', '/url').catch(detail)
      return 0
    })
    // The note is asserted by its **title**, not by its file name: the tree lists what the note says it
    // is (`# drive-probe-note`), and the first version of this probe failed on that difference while the
    // vault was in fact open — the page text it samples below is what showed it.
    // Polled, not read once: the tree renders the note after the vault's index pass announces itself
    // (`正在建立索引 0/0`), and a single read landed just before the row existed — the sample below, taken
    // milliseconds later, already contained it. A reading that depends on which side of a render it lands
    // is the shape of every flake this programme has had to diagnose.
    readings.noteVisible = await until(
      async () =>
        run('POST', '/execute/sync', {
          script: `return document.body.innerText.includes(arguments[0])`,
          args: [NOTE_TITLE],
        }).catch(() => false),
      { timeout: 20_000, what: `the tree to list "${NOTE_TITLE}"` },
    ).catch(() => false)
    readings.vaultVisible = await run('POST', '/execute/sync', {
      script: `return document.body.innerText.includes(arguments[0])`,
      args: [path.basename(vault)],
    })
    // Always sampled, not only on failure: a reading of "false" is worth nothing without the text it was
    // read from, and this is the cheapest way for the next reader to see what the page said.
    readings.pageTextSample = await run('POST', '/execute/sync', {
      script: 'return document.body.innerText.replace(/\s+/g, " ").slice(0, 200)',
      args: [],
    })
    stage('open the note')
    // A **native** click, through the driver's own element endpoint rather than a script's `.click()`:
    // the point of this probe is the real application, so its inputs go through the real event path.
    const row = await findElement('xpath', `//*[contains(text(), "${NOTE_TITLE}")]`)
    readings.rowFound = row !== null
    if (row) await run('POST', `/element/${row}/click`, {})

    stage('the editor')
    readings.editorText = await until(
      async () => {
        const text = await run(
          'POST',
          '/execute/sync',
          script('return document.querySelector(".ProseMirror")?.innerText ?? ""'),
        )
        return String(text).includes(NOTE_TITLE) ? String(text).replace(/\s+/g, ' ').slice(0, 120) : null
      },
      { timeout: 20_000, what: 'the note to open in the editor' },
    ).catch((e) => `TIMED-OUT: ${e.message}`)

    stage('the image, through the asset protocol')
    readings.images = await run(
      'POST',
      '/execute/sync',
      // `.ProseMirror-separator` is ProseMirror's own inline separator — an `<img>` with no src that it
      // puts beside a node view. The first version of this reading counted it and reported a broken image
      // in a note whose image had loaded; the context fields below are what identified it, so they stay.
      script(`return Array.from(document.querySelectorAll('.ProseMirror img:not(.ProseMirror-separator)')).map((img) => ({
        src: (img.getAttribute('src') ?? '').slice(0, 48),
        loaded: img.complete && img.naturalWidth > 0,
        naturalWidth: img.naturalWidth,
        parent: img.parentElement?.className?.toString().slice(0, 40) ?? null,
        outer: img.outerHTML.slice(0, 120),
      }))`),
    )

    stage('type into the editor')
    // Real key events, through the driver's actions endpoint: a script that dispatches a synthetic
    // KeyboardEvent would prove that a listener works, not that the editor accepts input from the
    // window. The caret goes where a reader would put it — a click on the editor — and the token is
    // typed one key at a time.
    const editor = await findElement('css selector', '.ProseMirror')
    readings.editorFound = editor !== null
    if (editor) {
      await run('POST', `/element/${editor}/click`, {})
      await typeText(TYPED_TOKEN)
      readings.typed = await until(
        async () => {
          const text = await run('POST', '/execute/sync', script('return document.querySelector(".ProseMirror")?.innerText ?? ""'))
          return String(text).includes(TYPED_TOKEN) ? true : null
        },
        { timeout: 10_000, what: 'the typed token to appear in the editor' },
      ).catch(() => false)
    }

    stage('save with Ctrl+S, and read the file from disk')
    // The ground truth is the file, not the UI: the probe reads the note from the filesystem after the
    // save, so a save that only updated the view would fail here.
    await pressCtrlS()
    readings.savedToDisk = await until(
      async () => (fs.readFileSync(path.join(vault, NOTE), 'utf8').includes(TYPED_TOKEN) ? true : null),
      { timeout: 15_000, what: 'the token to reach the file on disk' },
    ).catch(() => false)
    readings.fileSize = fs.statSync(path.join(vault, NOTE)).size

    if (PRINT) {
      stage('export PDF: the menu, the dialog, and the document behind it')
      await measurePrintDialog({ run, script, findElement, readings, shotDir: PRINT_SHOT_DIR })
    }
  } finally {
    if (session.id) await run('DELETE', '').catch(() => undefined)
    for (const child of [driver]) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    // **Not** a name-based `pkill -f <app>`: the pattern would also match this probe's own command line
    // when it is started with `--app`, and this repository already has that lesson on the record
    // (`agent_exit_teardown_test`'s `Drop` kills by pid for the same reason). Killing the two child
    // groups takes the app they launched with them.
    await sleep(200)
  }

  console.log(JSON.stringify(readings, null, 2))
  const problems = []
  if (readings.readyState !== 'complete') problems.push(`the page never finished loading (${readings.readyState})`)
  if (readings.tauri !== true) problems.push('window.__TAURI_INTERNALS__ is absent: this is not a Tauri page')
  if (!(readings.railButtons >= 1)) problems.push('the shell did not render: no status bar after the vault was opened')
  if (readings.editorFound !== true) problems.push('no .ProseMirror element to type into')
  if (readings.typed !== true) problems.push('the typed token never appeared in the editor')
  if (readings.savedToDisk !== true) {
    problems.push(`the typed token never reached ${NOTE} on disk after Ctrl+S`)
  }
  if (readings.rowFound !== true) problems.push('the note row was not found in the tree')
  if (typeof readings.editorText !== 'string' || readings.editorText.startsWith('TIMED-OUT')) {
    problems.push(`the note never opened in the editor (${readings.editorText})`)
  }
  const images = Array.isArray(readings.images) ? readings.images : []
  if (images.length === 0) problems.push('the editor rendered no <img> for the note that references one')
  else if (!images.every((i) => i.loaded)) problems.push(`an image did not render: ${JSON.stringify(images)}`)
  if (readings.vaultVisible !== true) {
    problems.push(`the vault (${path.basename(VAULT_DIR)}) is not named on the page; it reads: ${readings.pageTextSample}`)
  }
  if (readings.noteVisible !== true) {
    problems.push(`the planted note titled "${NOTE_TITLE}" is not listed; the page reads: ${readings.pageTextSample}`)
  }
  if (PRINT) {
    if (readings.cardFound !== true) problems.push('no note card to right-click for the export menu')
    if (readings.menuItemFound !== true) problems.push('the note menu never offered the PDF export')
    // `window.print()` on a hidden `srcdoc` frame is the whole PDF export. If no dialog appears, the user
    // pressed the item and nothing happened — there is no error to read, which is why this is measured as a
    // window rather than as a result code. The two hand-made attempts (`drive-print.mjs`) are what attribute
    // it: "this frame cannot print" and "printing reaches no dialog here at all" are different findings, and
    // the print events say which side of the request failed.
    const printedDialog = readings.dialogWindow ?? readings.exportFrameDialog ?? readings.mainFrameDialog
    // Either the system printed, or the app said why it could not. What must never happen again is
    // neither — that is the silent no-op this pair of probes exists to catch, and the fix is only real if
    // the built application actually says something.
    if (printedDialog == null && !readings.exportNotice) {
      const opened = (readings.printWindows ?? [])
        .map((w) => `${w.id} ${w.width}x${w.height} ${w._NET_WM_WINDOW_TYPE ?? 'no type'}`)
        .join(', ')
      problems.push(
        `no print dialog appeared and the app said nothing about it. Windows it did open: [${opened}]. A print repeated inside the app's own frame returned "${readings.exportFramePrint}" (events after: ${readings.exportFrameEventsAfter}), and one from the main frame returned "${readings.mainFramePrint}" (events after: ${readings.mainFrameEventsAfter})`,
      )
    }
    const printFrame = readings.printFrame
    if (printFrame === null || typeof printFrame !== 'object') {
      problems.push(`the export frame could not be read (${printFrame})`)
    } else if (printFrame.srcdocFrames === 0) {
      problems.push('no srcdoc frame was attached: the export never rendered a document to print')
    } else {
      if (!(printFrame.docLength > 0)) problems.push('the export frame holds an empty document')
      if (!printFrame.pageRule) problems.push('the exported document carries no @page rule from the settings')
      const printImages = Array.isArray(printFrame.images) ? printFrame.images : []
      if (printImages.length === 0) {
        problems.push('the exported document references no image, though the note has one')
      } else if (!printImages.every((i) => i.loaded)) {
        problems.push(`an image did not resolve in the exported document: ${JSON.stringify(printImages)}`)
      }
    }
    const closed = [readings.framesAfterWindowclose, readings.framesAfterEscape].some(
      (n) => typeof n === 'number' && n >= 0,
    )
    // The cleanup is judged only when a dialog actually appeared. With no dialog there is nothing to
    // dismiss and nothing to expect: the frame is designed to stay until the exporters' five-minute
    // backstop, so calling that a failure would be blaming the app for a print that never began.
    if (printedDialog != null && !closed) {
      // The cleanup is judged only when a close actually happened. A probe that could not dismiss the
      // dialog has not measured the app's `afterprint` path, and reporting that as a defect would blame
      // the app for the probe's own limitation — so the two cases are kept apart.
      if (readings.dialogStillOpen === false) {
        problems.push(
          `the print dialog closed but the export frame stayed attached (frames ${readings.framesBefore} -> ${readings.windowsAfterClose?.length ?? '?'} windows, still ${readings.framesBefore !== 0 ? 'more' : 'one'}), so it lingers until the exporters' five-minute backstop`,
        )
      } else {
        readings.printCleanupUnmeasured =
          'the probe could not dismiss the print dialog, so `afterprint` and the frame cleanup were not measured'
      }
    }
  }
  if (problems.length > 0) {
    console.error('FAIL:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exitCode = 1
    return
  }
  if (readings.evalAllowed !== 'blocked') {
    console.error('INCONCLUSIVE: `eval` was not refused in this script context, so the WebDriver script is')
    console.error(`exempt from the page policy here and the blob reading cannot be attributed to it: ${readings.blobImport}`)
    console.error('Take that reading with `probe-csp-blob.mjs`, which runs the attempt from the page itself.')
    process.exitCode = 1
    return
  }
  if (!String(readings.blobImport).startsWith('blocked')) {
    console.error(`FAIL: the CSP refused \`eval\` but not a blob module import in the app itself: ${readings.blobImport}`)
    process.exitCode = 1
    return
  }
  console.log('PASS: the built app answered WebDriver with its own vault open — Tauri page, shell rendered,')
  console.log('      the note opened by a native click, its image rendered through the host\'s asset protocol,')
  console.log(`      "${TYPED_TOKEN}" typed as real key events and saved to disk with Ctrl+S — and the`)
  console.log('      production CSP is in force inside it: `eval` refused (the control) and a blob module')
  console.log('      import refused with it.')
  if (PRINT) {
    const dialog = [readings.dialogWindow, readings.exportFrameDialog, readings.mainFrameDialog]
      .filter(Boolean)
      .map((w) => `"${w.name || w.id}" ${w.width}x${w.height}`)
      .join(', ')
    const printImages = Array.isArray(readings.printFrame?.images) ? readings.printFrame.images : []
    const after = readings.framesAfterWindowclose >= 0 ? readings.framesAfterWindowclose : readings.framesAfterEscape
    console.log(`      Its PDF export rendered the note into its print frame ("${String(readings.printFrame?.pageRule ?? '').trim().slice(0, 44)}", ${printImages.length} image(s) resolved)`)
    if (dialog) {
      console.log(`      and reached a real GTK print dialog (${dialog}); closing it left the frame count at ${after}.`)
    } else {
      console.log(`      but reached no print dialog (${readings.exportFramePrint} / ${readings.mainFramePrint});`)
      console.log(`      the app's own notice, read out of the toast stack: ${readings.exportNotice ?? '(none)'}`)
    }
  }
}

await main()
