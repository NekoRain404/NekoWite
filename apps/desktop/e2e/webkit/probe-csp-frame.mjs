/**
 * Does the app's own CSP stop the app's own export frames?
 *
 * `tauri.conf.json` ships `frame-src 'none'`, and three shipped features put a document into an
 * `<iframe>`: the PDF export's print frame and the long-image exporter (`services/export.ts`,
 * `services/export-image.ts`, both `iframe.srcdoc = html`) and the settings dialog's export preview
 * (`ExportPreview.vue`, `:srcdoc`). If this engine applies `frame-src` to a `srcdoc` frame — whose URL
 * is the local scheme `about:srcdoc` — then all three produce an empty frame in a packaged build, and
 * the user-visible result is an export that silently does nothing.
 *
 * **Nothing in the repository could have caught that.** The unit tests for both exporters install a
 * fake `document` and assert against `iframe.srcdoc` (the attribute, never a loaded document), and the
 * Playwright suite is Chromium with a stubbed `__TAURI_INTERNALS__`, so it runs without the app's
 * policy at all. This probe measures it on WebKitGTK, on the policy string read out of the app's own
 * config, and it carries the three controls that make the answer attributable:
 *
 *  - `control-network-with-csp` — under the app's policy, a frame that loads `./child.html` over HTTP.
 *    It must be blocked: that is the reading proving this engine *enforces* `frame-src` at all, without
 *    which "the srcdoc frame loaded" could just mean the directive is inert here.
 *  - `control-network-no-csp` — the identical frame on a page with no policy. It must show the child,
 *    so a block above is the policy rather than a harness that cannot frame anything.
 *  - `srcdoc-no-csp` — the srcdoc frame with no policy. It must show the frame's document, so a block
 *    below is the policy rather than a frame that never loads in MiniBrowser for reasons of its own.
 *
 * The `srcdoc` document is shaped like the exporters' (`<style data-neko-export-page>` and a body), and
 * each page reports `securitypolicyviolation`, so a block is attributed to a directive and a URI rather
 * than inferred from an empty box.
 *
 * Usage:  xvfb-run -a -s "-screen 0 1280x800x24 -extension GLX" node e2e/webkit/probe-csp-frame.mjs
 * Exit:   0 when the readings say the export frames are not what the policy stops (whether because the
 *         engine exempts local-scheme frames, or because it does not enforce `frame-src` here at all —
 *         both are reported, and the second is a different fact about a different guarantee);
 *         1 when the app's policy refuses its own export frame, which is a bug in the shipped app.
 *
 * It needs no window manager: no geometry is read.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebDriver, freePort, sleep, until } from './webdriver.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../..')

/** The policy the packaged app runs under, read from the app's own config rather than retyped. */
function appCsp() {
  const conf = JSON.parse(
    fs.readFileSync(path.join(REPO, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
  )
  const csp = conf?.app?.security?.csp
  if (typeof csp !== 'string' || csp.length === 0) throw new Error('tauri.conf.json has no app.security.csp')
  return csp
}

/** The document a `srcdoc` frame is handed: the exporters' shape, reduced to what a reading needs. */
const SRCDOC_DOCUMENT =
  '<!DOCTYPE html><html><head><style data-neko-export-page>@page{size:A5 portrait;margin:10mm;}</style>' +
  '</head><body><div id="who">srcdoc</div></body></html>'

const CHILD_DOCUMENT = '<!DOCTYPE html><html><body><div id="who">child</div></body></html>'

/**
 * Builds the frame the way the exporters build theirs — `createElement`, then the source, then
 * `appendChild` — because the question is whether *that* sequence survives the policy, not whether some
 * other way of writing a frame does.
 *
 * Two samples, and the second is the one the parent waits for: a blocked frame may still fire `load`
 * (an error document is a document), so the reading that decides is the one taken after the engine has
 * had time to do whatever it is going to do.
 */
const probeModule = (kind) => `
const result = document.getElementById('result')
const later = document.getElementById('later')
const violations = []
document.addEventListener('securitypolicyviolation', (e) => {
  violations.push(e.violatedDirective + '<-' + String(e.blockedURI).split(':')[0])
})
function sample(tag) {
  const doc = frame.contentDocument
  const who = doc && doc.getElementById ? doc.getElementById('who') : null
  return tag + ' who=' + (who ? who.textContent : 'none') +
    ' len=' + (doc && doc.documentElement ? doc.documentElement.innerHTML.length : -1) +
    ' violations=' + violations.join(',')
}
const frame = document.createElement('iframe')
frame.style.display = 'none'
${kind === 'srcdoc' ? `frame.srcdoc = ${JSON.stringify(SRCDOC_DOCUMENT)}` : "frame.src = './child.html'"}
document.body.appendChild(frame)
frame.addEventListener('load', () => { result.textContent = sample('load') }, { once: true })
setTimeout(() => { later.textContent = sample('later') }, 3000)
`

/** Four pages: the two controls, the question, and the control that proves the harness frames at all. */
function writePages(csp) {
  const dir = fs.mkdtempSync(path.join(REPO, 'apps/desktop/src-tauri/target/csp-frame-'))
  fs.writeFileSync(path.join(dir, 'child.html'), CHILD_DOCUMENT)
  const page = (meta, kind, name) => {
    fs.writeFileSync(path.join(dir, `${name}.js`), probeModule(kind))
    fs.writeFileSync(
      path.join(dir, `${name}.html`),
      `<!DOCTYPE html><html><head><meta charset="utf-8">${meta}<title>${name}</title></head>` +
        `<body><div id="result">pending</div><div id="later">pending</div>` +
        `<script src="./${name}.js"></script></body></html>`,
    )
  }
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`
  page(meta, 'network', 'control-network-with-csp')
  page('', 'network', 'control-network-no-csp')
  page(meta, 'srcdoc', 'srcdoc-with-csp')
  page('', 'srcdoc', 'srcdoc-no-csp')
  return dir
}

/** `who=child` / `who=srcdoc` — the reading a loaded frame produces. */
const framed = (reading, who) => new RegExp(`who=${who}\\b`).test(String(reading))

async function main() {
  const csp = appCsp()
  const dir = writePages(csp)
  const files = new Map(
    fs.readdirSync(dir).map((name) => [
      `/${name}`,
      {
        body: fs.readFileSync(path.join(dir, name)),
        type: path.extname(name) === '.html' ? 'text/html' : 'text/javascript',
      },
    ]),
  )
  const server = createServer((req, res) => {
    const file = files.get((req.url ?? '/').split('?')[0])
    if (!file) {
      res.writeHead(404).end('no')
      return
    }
    res.writeHead(200, { 'content-type': file.type }).end(file.body)
  })
  const httpPort = await freePort()
  await new Promise((resolve) => server.listen(httpPort, '127.0.0.1', resolve))

  const driverPort = await freePort()
  const driver = spawn('/usr/bin/WebKitWebDriver', [`--port=${driverPort}`], {
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
  })
  driver.unref()
  const wd = new WebDriver(driverPort)
  const readings = {}
  try {
    await wd.session()
    for (const name of [
      'control-network-with-csp',
      'control-network-no-csp',
      'srcdoc-with-csp',
      'srcdoc-no-csp',
    ]) {
      await wd.navigate(`http://127.0.0.1:${httpPort}/${name}.html`)
      readings[name] = await until(
        async () => {
          const text = await wd.execute(`return document.getElementById('later').textContent`)
          return typeof text === 'string' && text !== 'pending' ? text : null
        },
        { timeout: 15_000, what: `${name} to take its second sample` },
      ).catch(() => 'TIMED-OUT')
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
    fs.rmSync(dir, { recursive: true, force: true })
  }

  await sleep(0)
  const netCsp = readings['control-network-with-csp']
  const netFree = readings['control-network-no-csp']
  const srcdocCsp = readings['srcdoc-with-csp']
  const srcdocFree = readings['srcdoc-no-csp']

  console.log(JSON.stringify(readings, null, 2))
  if (!framed(netFree, 'child')) {
    console.error(`FAIL: the harness cannot frame anything — the no-policy control did not load the child (${netFree})`)
    process.exitCode = 1
    return
  }
  if (!framed(srcdocFree, 'srcdoc')) {
    console.error(`FAIL: the harness cannot load a srcdoc frame at all without a policy (${srcdocFree})`)
    process.exitCode = 1
    return
  }
  if (framed(netCsp, 'child')) {
    // Not a pass: it means this engine does not apply `frame-src` to a network frame, so the srcdoc
    // reading below cannot be attributed to the directive — which is a fact about the guarantee, not
    // about the app, and `connect-src`/`script-src` carry the rest of the policy's weight.
    console.error(`INCONCLUSIVE: this engine did not block the network frame under frame-src 'none' (${netCsp}),`)
    console.error('so its treatment of the srcdoc frame says nothing about the directive.')
    process.exitCode = 1
    return
  }
  if (framed(srcdocCsp, 'srcdoc')) {
    console.log("PASS: the policy that blocks a network frame does not block the app's own srcdoc frame.")
    console.log('      So `frame-src \'none\'` is not what would empty the export frame, the long-image')
    console.log('      frame or the settings preview on the engine that ships:')
    console.log(`        network frame under the app CSP: ${netCsp}`)
    console.log(`        srcdoc frame under the app CSP:  ${srcdocCsp}`)
    return
  }
  console.error(`FAIL: the app's own CSP refuses its own export frame (${srcdocCsp}).`)
  console.error('An empty srcdoc document means the PDF export prints nothing, the long-image export')
  console.error('draws nothing and the settings preview shows an empty box — in a packaged build only,')
  console.error('which is why no unit test and no Chromium run has seen it.')
  process.exitCode = 1
}

await main()
