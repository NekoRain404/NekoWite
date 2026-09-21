/**
 * Does the engine that ships actually refuse `import('blob:…')` under this app's CSP?
 *
 * `docs/SECURITY.md` §2 rests on that refusal — it is the reason a packaged build cannot load a vault
 * plugin — and `docs/DOC-AUDIT.md` §4 lists it as found-but-not-verified: the repository's only CSP test
 * (`e2e/security-csp.spec.ts`) is a Chromium run, and Chromium is not the engine the app embeds. This
 * probe measures it on **WebKitGTK**, through WebKitWebDriver and MiniBrowser, and it carries the two
 * controls that make the answer attributable:
 *
 *  - `control-inline` proves the policy in this experiment is enforced **at all**. An inline script under
 *    `script-src 'self'` must not run. Without that reading, "the blob import was blocked" could mean
 *    "this engine ignores a `<meta>` CSP", which is a different — and much weaker — finding.
 *  - `no-csp` runs the identical module with no policy, so a difference between it and `with-csp` is the
 *    CSP rather than blob module imports not working in MiniBrowser for reasons of their own.
 *
 * The page also records `securitypolicyviolation` events, so a block can be attributed to a directive and
 * a blocked URI rather than inferred from an exception message.
 *
 * Usage:  xvfb-run -a -s "-screen 0 1280x800x24 -extension GLX" node e2e/webkit/probe-csp-blob.mjs
 * Exit:   0 when the readings are consistent with the policy refusing the import, or with the engine
 *         refusing it regardless of policy (both are reported, and both mean a plugin cannot load);
 *         1 when the import is **allowed** under the production policy, which would falsify §2, or when
 *         the inline control shows the policy is not enforced and nothing can be attributed.
 *
 * It needs no window manager: unlike `measure.mjs` this reads no geometry, so the viewport `setWindowRect`
 * cannot honour is irrelevant here.
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

const PROBE_MODULE = `
const out = document.getElementById('result')
const violations = []
document.addEventListener('securitypolicyviolation', (e) => {
  violations.push(e.violatedDirective + '<-' + String(e.blockedURI).split(':')[0])
})
function report(sameOrigin, blob) {
  out.textContent = 'same-origin=' + sameOrigin + '; blob=' + blob + '; violations=' + violations.join(',')
}
let sameOrigin = 'error'
try {
  const mod = await import('./control-module.js')
  sameOrigin = mod.default
} catch (e) {
  sameOrigin = 'error:' + (e && e.message ? e.message : String(e))
}
try {
  const url = URL.createObjectURL(new Blob(['export default "blob-ran"'], { type: 'text/javascript' }))
  const mod = await import(url)
  report(sameOrigin, 'allowed:' + mod.default)
} catch (e) {
  report(sameOrigin, 'blocked:' + (e && e.message ? e.message : String(e)))
}
`

function page({ csp, body }) {
  const meta = csp ? `<meta http-equiv="Content-Security-Policy" content="${csp}">` : ''
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${meta}</head><body>${body}</body></html>`
}

/** The three pages, written into the git-ignored target tree so nothing lands in the sources. */
function writePages(csp) {
  const dir = fs.mkdtempSync(path.join(REPO, 'apps/desktop/src-tauri/target/csp-probe-'))
  fs.writeFileSync(path.join(dir, 'control-module.js'), 'export default "ok"\n')
  fs.writeFileSync(path.join(dir, 'probe-blob.js'), PROBE_MODULE)
  fs.writeFileSync(
    path.join(dir, 'control-inline.html'),
    page({
      csp,
      body: `<div id="result">inline-did-not-run</div><script>document.getElementById('result').textContent='inline-ran'</script>`,
    }),
  )
  fs.writeFileSync(
    path.join(dir, 'with-csp.html'),
    page({ csp, body: `<div id="result">pending</div><script type="module" src="./probe-blob.js"></script>` }),
  )
  fs.writeFileSync(
    path.join(dir, 'no-csp.html'),
    page({ csp: null, body: `<div id="result">pending</div><script type="module" src="./probe-blob.js"></script>` }),
  )
  return dir
}

async function main() {
  const csp = appCsp()
  const dir = writePages(csp)
  const files = new Map(
    fs.readdirSync(dir).map((name) => {
      const ext = path.extname(name)
      const type = ext === '.html' ? 'text/html' : 'text/javascript'
      return [`/${name}`, { body: fs.readFileSync(path.join(dir, name)), type }]
    }),
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
    for (const name of ['control-inline', 'with-csp', 'no-csp']) {
      await wd.navigate(`http://127.0.0.1:${httpPort}/${name}.html`)
      readings[name] = await until(
        async () => {
          const text = await wd.execute(`return document.getElementById('result').textContent`)
          return typeof text === 'string' && text !== 'pending' ? text : null
        },
        { timeout: 10_000, what: `${name} to report` },
      ).catch(() => 'TIMED-OUT')
    }
  } finally {
    try {
      await wd.close()
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
  const inline = readings['control-inline']
  const withCsp = readings['with-csp']
  const noCsp = readings['no-csp']
  const cspEnforced = inline === 'inline-did-not-run'
  const blockedUnderCsp = /blob=blocked:/.test(withCsp)
  const allowedWithout = /blob=allowed:blob-ran/.test(noCsp)
  const blockedWithout = /blob=blocked:/.test(noCsp)

  console.log(JSON.stringify(readings, null, 2))
  if (!cspEnforced) {
    console.error(`FAIL: the inline control RAN (${inline}), so this <meta> policy is not enforced here and`)
    console.error('nothing below can be attributed to it.')
    process.exitCode = 1
    return
  }
  if (!blockedUnderCsp) {
    console.error(`FAIL: under the app's own CSP the blob import was not blocked (${withCsp}).`)
    console.error('docs/SECURITY.md §2 rests on the opposite, and this reading is on the engine that ships.')
    process.exitCode = 1
    return
  }
  console.log('PASS: the inline control did not run (policy enforced), and the blob module import was refused')
  if (allowedWithout) {
    console.log('      under the app CSP while the identical page without it imported the blob successfully:')
    console.log('      the refusal is attributable to script-src, not to MiniBrowser.')
  } else if (blockedWithout) {
    console.log('      even with NO policy on the page. So WebKitGTK refuses blob module imports regardless of')
    console.log('      CSP: the conclusion (a vault plugin cannot load) holds, but §2 attributing it to the CSP')
    console.log('      is over-determined — record that, do not claim the CSP as the cause.')
  } else {
    console.error(`FAIL: unexpected reading without the policy: ${noCsp}`)
    process.exitCode = 1
  }
}

await main()
