#!/usr/bin/env node
/**
 * Measure the running app in WebKitGTK — the engine that ships.
 *
 * Every geometry and animation number this programme holds was taken in
 * Chromium through Playwright. `wry` on Linux is WebKitGTK, the AppImage
 * bundles it, and `tokens.css` names the installed version (2.52.6) because the
 * surface-arrival spring is a `linear()` sample set and `linear()` landed in
 * 2.44. Playwright's `webkit` is a different port and does not answer the
 * question, so this starts the real thing instead:
 *
 *   1. the frozen dev server, on a free port of its own — `vite.frozen.config`
 *      so a source edit cannot hot-reload the page under a measurement, and a
 *      free port so the app's own 1420 is never named, let alone taken;
 *   2. `WebKitWebDriver` on a free port of its own;
 *   3. `MiniBrowser`, driven by the driver, at the harness page;
 *   4. the probes in `probes.mjs`, which return numbers and never screenshots.
 *
 *   node e2e/webkit/measure.mjs                 # every probe, JSON on stdout
 *   node e2e/webkit/measure.mjs --only panel    # one probe
 *   node e2e/webkit/measure.mjs --scenario plain
 *   node e2e/webkit/measure.mjs --agent         # the harness stands in for the agent IPC too
 *   node e2e/webkit/measure.mjs --chat          # the rail gets a seeded chat conversation
 *
 * `--agent` is the one flag that changes the page rather than the run: the harness's `?agent=1`
 * installs the IPC stand-in the agent panel needs and switches the rail to it. It is a flag and
 * not a scenario because it is orthogonal to which document is open, and because the probes
 * that do not care about the panel must keep measuring the same page they always did — with it
 * absent, `harness.html` is byte for byte the document it was.
 *
 * `--chat` is the same contract for the other body the rail can host: `?chat=1` seeds a
 * conversation through the product's own stored document, which is what the chat transcript
 * needs in order to overflow. The two are separate flags because they are mutually exclusive on
 * the page — the agent panel takes the rail over — and each probe reports itself skipped under
 * the other's flag rather than measuring a panel that is not there.
 *
 * The run records whether it was asked for the panel (`results.agent`, `results.chat`), so a
 * skipped agent-panel probe can be told apart from a run that asked and got nothing: the first
 * claims nothing, the second is the failure this whole file is arranged to make visible.
 *
 * `MiniBrowser` opens a window on the user's real desktop, because WebKitGTK
 * has no headless mode (2.52's MiniBrowser takes no `--headless` and
 * `WebKitWebDriver --help` offers none). It is set to 1280x836 so its CONTENT
 * area is exactly 1280x800, the viewport the Chromium measurements used, and
 * the session is closed the moment the probes return.
 */
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebDriver, freePort, sleep, until } from './webdriver.mjs'
import { ALL_PROBES } from './probes.mjs'
import { openNote } from './probe-support.mjs'
import { verify } from './verify.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..', '..')

/** Content area 1280x800, the viewport every Chromium number was taken at. */
const VIEWPORT = { width: 1280, height: 800 }
/** MiniBrowser's window chrome between the outer window and the content box. */
const CHROME_HEIGHT = 36

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? true)
}

/**
 * `--host 127.0.0.1` is load-bearing, not tidiness.
 *
 * Left to itself Vite binds the name it was started with, and on this machine
 * `localhost` resolves to `::1` ONLY — so a plain `http://localhost:<port>` is
 * reachable from `curl` (which tries both families) and unreachable from
 * anything that picks one. Making the address a literal removes the whole
 * class: one IPv4 address, named the same way by the server, the readiness
 * probe, and MiniBrowser's navigation.
 */
async function startDevServer(port) {
  const child = spawn(
    'pnpm',
    [
      'dev',
      '--config',
      'e2e/vite.frozen.config.ts',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    // `detached` puts `pnpm` and the `vite` it execs in one process group, so
    // `stop()` can signal the GROUP. Killing the `pnpm` wrapper alone does
    // nothing to the server it started — `vite` stays bound to its port with no
    // parent, and a harness run that leaks one per invocation fills the machine
    // with servers nobody can see. This device is a leak the first version of
    // this harness had, and it left five of them behind.
    { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  let output = ''
  child.stdout.on('data', (b) => (output += String(b)))
  child.stderr.on('data', (b) => (output += String(b)))
  await until(
    async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/e2e/webkit/harness.html`, {
          signal: AbortSignal.timeout(2000),
        })
        return res.ok
      } catch {
        return false
      }
    },
    { timeout: 120_000, what: `the dev server on ${port}` },
  ).catch((error) => {
    stop(child)
    throw new Error(`${error.message}\n--- server output ---\n${output}`)
  })
  return child
}

/**
 * Stop a process this file started, and everything it started.
 *
 * The group signal is the point: a bare `child.kill()` reaches `pnpm` and not
 * the server, and the guard below is the other half of GOVERNANCE's rule — only
 * a PID this file owns is ever signalled, and a negative PID is only ever the
 * group of one of those.
 */
function stop(child) {
  if (!child || child.killed || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

/**
 * A watchdog, because every wait below is a wait on a browser that a driver
 * talks to over a socket, and a MiniBrowser that dies leaves the client holding
 * a request that never answers. Without it a dead run is indistinguishable from
 * a slow one — which is what the first attempt at this cost.
 */
function watchdog(ms) {
  const timer = setTimeout(() => {
    process.stderr.write(`\n[webkit] watchdog: nothing finished within ${ms}ms\n`)
    process.kill(process.pid, 'SIGKILL')
  }, ms)
  timer.unref()
  return timer
}

async function main() {
  const only = arg('only')
  const scenario = arg('scenario', 'long')
  // Presence, not a value: `arg` reads the token AFTER a flag, so `--agent --only x` would hand
  // back `--only` and a switch spelled this way would silently be off.
  const agent = process.argv.includes('--agent')
  // The chat panel's half of the same idea, and the reason it is a second flag rather than one
  // with two values: the agent panel takes the rail over, so a page prepared for one is a page
  // that cannot host the other. A run asks for at most one of them, and the one it did not ask
  // for reports itself skipped.
  const chat = process.argv.includes('--chat')

  const vitePort = await freePort()
  const driverPort = await freePort()
  if (!vitePort || !driverPort) throw new Error('no free port could be reserved')

  const dev = await startDevServer(vitePort)
  // WebKitWebDriver spawns MiniBrowser itself, so the driver's environment is
  // MiniBrowser's: this is where GDK/display settings would go if a run needed
  // them. Nothing is set today, so the app is driven on the same display stack
  // the user's window uses.
  // Detached for the same reason as the dev server: the driver starts MiniBrowser
  // as its own child, and killing the driver is not the same as killing the
  // browser it launched.
  const driver = spawn('/usr/bin/WebKitWebDriver', [`--port=${driverPort}`], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  })

  const wd = new WebDriver(driverPort)
  const results = { engine: null, viewport: null, scenario, agent, chat, only, probes: {} }
  watchdog(Number(arg('watchdog', '300000')))
  try {
    stage('session')
    const capabilities = await wd.session()
    results.engine = {
      browserName: capabilities.browserName,
      browserVersion: capabilities.browserVersion,
      platformName: capabilities.platformName,
    }

    const url =
      `http://127.0.0.1:${vitePort}/e2e/webkit/harness.html?scenario=${scenario}` +
      (agent ? '&agent=1' : '') +
      (chat ? '&chat=1' : '')
    stage(`navigate ${url}`)
    await wd.navigate(url)

    // AFTER the navigation, and verified rather than requested. A `setWindowRect`
    // issued while the session is still on the driver's blank page is accepted
    // and then discarded — the app's own first navigation resets the window to
    // MiniBrowser's default 1024x768, and the run measures a 1024x732 viewport
    // believing it is 1280x800. Nothing downstream can see that: every rect is
    // still internally consistent. (Cost: one run.)
    stage('set viewport')
    await wd.setWindowRect({
      width: VIEWPORT.width,
      height: VIEWPORT.height + CHROME_HEIGHT,
      x: 0,
      y: 0,
    })
    await until(
      () =>
        wd.execute(
          `return innerWidth === ${VIEWPORT.width} && innerHeight === ${VIEWPORT.height}`,
        ),
      { timeout: 10_000, what: `a ${VIEWPORT.width}x${VIEWPORT.height} content area` },
    )

    stage('open note')
    await openNote(wd)

    results.viewport = await wd.execute(
      'return { innerWidth: innerWidth, innerHeight: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent }',
    )

    for (const probe of ALL_PROBES) {
      if (only && probe.name !== only) continue
      // probes share one page and the order is the point: each leaves the
      // document where the next expects it.
      stage(`probe ${probe.name}`)
      results.probes[probe.name] = await probe.run(wd)
    }
  } finally {
    stage('teardown')
    const logs = await wd.logs()
    if (logs) results.console = logs.map((l) => `${l.level}: ${l.message}`).slice(0, 40)
    await wd.quit()
    stop(driver)
    stop(dev)
  }

  // The numbers always, the verdict as well. A run that only prints cannot be a
  // gate; a run that only asserts cannot be read, and "the engine disagrees" is
  // a claim that has to be visible as numbers before it is a claim about a check.
  if (!only || only !== 'inspect') results.verdict = verify(results)

  console.log(JSON.stringify(results, null, 2))
  if (results.verdict) {
    process.stderr.write(
      `\n[webkit] ${results.verdict.passed} passed, ${results.verdict.failed} failed\n` +
        results.verdict.results
          .map((r) => `  ${r.holds ? 'ok  ' : 'FAIL'} ${r.name} — ${r.detail}`)
          .join('\n') +
        '\n',
    )
  }
  // Forced exit is needed for the driver's lingering handles, but only after
  // both pipe buffers drain; immediate exit truncates large machine-readable reports.
  await Promise.all([
    new Promise((resolve) => process.stdout.write('', resolve)),
    new Promise((resolve) => process.stderr.write('', resolve)),
  ])
  process.exit(results.verdict?.failed ? 1 : 0)
}

/** Progress on stderr, so a hang says which step hung. Stdout stays pure JSON. */
function stage(name) {
  process.stderr.write(`[webkit] ${name}\n`)
}

await main()
