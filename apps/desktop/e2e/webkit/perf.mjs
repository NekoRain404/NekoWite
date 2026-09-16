#!/usr/bin/env node
/**
 * The performance runner: the same engine as `measure.mjs`, a different question.
 *
 * `measure.mjs` asks whether the shipped engine *agrees* with a number taken in Chromium;
 * this asks how the app behaves when the document is long and an answer is streaming into the
 * panel beside it. It is a separate entry point rather than a probe in `probes.mjs` for one
 * reason: those probes share a page and run in a fixed order that each one depends on, and a
 * document of tens of thousands of words is not something to leave behind for the next probe.
 * A perf run wants its own page per size and its own process to tear down.
 *
 * It starts the same three things `measure.mjs` starts, for the same reasons and with the same
 * guards: the frozen dev server on a free port (so an edit cannot reload the page under a
 * measurement), `WebKitWebDriver` on a free port, and `MiniBrowser` at the harness page in a
 * window whose content area is exactly 1280x800. Read `measure.mjs`'s header for why the
 * address is a literal and why the driver is signalled by process group; none of that is
 * repeated here.
 *
 * ## The load average, which is part of every number below
 *
 * This machine is shared with work that is nothing to do with this programme, and its load
 * average moves by an order of magnitude over minutes. A frame interval taken under that is
 * partly a measurement of the machine. So every run reads `os.loadavg()` before and after
 * itself and reports both, and every probe reports two kinds of number side by side:
 *
 *   - **timing** (`dt`, latency) — sensitive to contention, and only meaningful with the load
 *     printed beside it;
 *   - **counts** (MutationObserver records, CSS animation starts, DOM writes) — the same on a
 *     busy machine and a quiet one, because they count work rather than time it.
 *
 * The structural questions this programme is asked — does per-chunk cost grow with the length
 * of the conversation, does an entrance animation replay per chunk, does a suspended container
 * move — are all answerable from the counts, and those answers do not need a quiet machine.
 *
 *   node e2e/webkit/perf.mjs --probe stream --agent
 *   node e2e/webkit/perf.mjs --probe typing --scenario doc --words 30000
 *   node e2e/webkit/perf.mjs --probe scroll --scenario doc --words 30000 --agent
 *   node e2e/webkit/perf.mjs --probe panel
 *   node e2e/webkit/perf.mjs --probe follow --agent
 *
 * `--probe all` runs the four probes that share a page in the order they can share it.
 */
import { spawn } from 'node:child_process'
import { loadavg } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebDriver, freePort, sleep, until } from './webdriver.mjs'
import { PROBES, openHarness } from './perf-probes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..', '..')
const VIEWPORT = { width: 1280, height: 800 }
const CHROME_HEIGHT = 36

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? true)
}
function flag(name) {
  return process.argv.includes(`--${name}`)
}

async function startDevServer(port) {
  const child = spawn(
    'pnpm',
    ['dev', '--config', 'e2e/vite.frozen.config.ts', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
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
    { timeout: 180_000, what: `the dev server on ${port}` },
  ).catch((error) => {
    stop(child)
    throw new Error(`${error.message}\n--- server output ---\n${output}`)
  })
  return child
}

function stop(child) {
  if (!child || child.killed || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

function watchdog(ms) {
  const timer = setTimeout(() => {
    process.stderr.write(`\n[perf] watchdog: nothing finished within ${ms}ms\n`)
    process.kill(process.pid, 'SIGKILL')
  }, ms)
  timer.unref()
  return timer
}

/** `loadavg` as three numbers, so a reader can see which of them moved. */
function load() {
  return loadavg().map((value) => Math.round(value * 100) / 100)
}

async function main() {
  const which = arg('probe', 'all')
  const scenario = arg('scenario', 'doc')
  const words = arg('words', '2000')
  const withAgent = flag('agent')
  const loadBefore = load()

  const vitePort = await freePort()
  const driverPort = await freePort()
  if (!vitePort || !driverPort) throw new Error('no free port could be reserved')

  const dev = await startDevServer(vitePort)
  const driver = spawn('/usr/bin/WebKitWebDriver', [`--port=${driverPort}`], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  })

  const wd = new WebDriver(driverPort)
  const results = {
    instrument: 'WebKitGTK via WebKitWebDriver + MiniBrowser, frontend driven directly',
    scenario,
    words: scenario === 'doc' ? Number(words) : null,
    agent: withAgent,
    loadBefore,
    probes: {},
  }
  const names = which === 'all' ? Object.keys(PROBES) : [which]
  for (const name of names) if (!PROBES[name]) throw new Error(`no probe named ${name}`)

  watchdog(Number(arg('watchdog', '1800000')))
  try {
    const capabilities = await wd.session()
    results.engine = {
      browserName: capabilities.browserName,
      browserVersion: capabilities.browserVersion,
      platformName: capabilities.platformName,
    }

    const query = [`scenario=${scenario}`, `words=${words}`, withAgent ? 'agent=1' : '']
      .filter(Boolean)
      .join('&')
    await wd.navigate(`http://127.0.0.1:${vitePort}/e2e/webkit/harness.html?${query}`)

    await wd.setWindowRect({
      width: VIEWPORT.width,
      height: VIEWPORT.height + CHROME_HEIGHT,
      x: 0,
      y: 0,
    })
    await until(
      () => wd.execute(`return innerWidth === ${VIEWPORT.width} && innerHeight === ${VIEWPORT.height}`),
      { timeout: 20_000, what: `a ${VIEWPORT.width}x${VIEWPORT.height} content area` },
    )

    const boot = await openHarness(wd)
    results.boot = boot
    results.viewport = await wd.execute(
      'return { innerWidth: innerWidth, innerHeight: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent }',
    )

    for (const name of names) {
      process.stderr.write(`[perf] probe ${name} (load ${load().join(' ')})\n`)
      const started = Date.now()
      try {
        results.probes[name] = await PROBES[name](wd, { words: Number(words), agent: withAgent })
      } catch (error) {
        results.probes[name] = { error: String(error && error.message ? error.message : error) }
      }
      results.probes[name].wallMs = Date.now() - started
      results.probes[name].loadAfter = load()
    }
  } finally {
    try {
      const logs = await wd.logs()
      if (logs) results.console = logs.map((l) => `${l.level}: ${l.message}`).slice(0, 40)
    } catch {
      // A driver that is already gone cannot answer; the run's numbers are still the result.
    }
    await wd.quit()
    stop(driver)
    stop(dev)
  }

  results.loadAfter = load()
  console.log(JSON.stringify(results, null, 2))
  process.exit(0)
}

await main()
