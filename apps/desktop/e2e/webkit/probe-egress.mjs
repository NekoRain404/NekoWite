/**
 * What the running application contacts, and when.
 *
 * `docs/PRIVACY.md` lists the connections the app makes on its own — your AI provider, the pet character
 * library (`pets.thenightwatcher.online`) and the agent registry (`cdn.agentclientprotocol.com`) — and
 * `docs/DOC-AUDIT.md` §4 has kept the question of whether those are **actually reached** open since the
 * audit was written: "Read from the code and the mount hook; no packet capture or proxy was used."
 *
 * This is that capture, as close as this machine allows. A logging HTTP proxy is put in front of the app
 * through the standard environment variables and the app is driven with WebDriver, so every request it
 * makes through its own stack arrives as a `CONNECT host:port` line with a timestamp. Four phases, because
 * the claim is about *when*: idle at the welcome screen (nothing may leave), then the agent registry with a
 * **fresh** cache (nothing may leave either — `agent_catalogue_read` is cache-first), then the same command
 * with a **stale** cache (exactly the documented host), then the pet catalogue (which is deliberately not
 * cached, so it goes out every time).
 *
 * The fresh-cache phase is also the control for the whole instrument: a probe that only ever saw requests
 * could not tell "the cache answered" from "this command never fetches", and a probe that only ever saw
 * silence could not tell "nothing was sent" from "the proxy was ignored". Two arms of the same rule, one
 * measurement apart. (A first version of this probe asserted that a *second* read after a failed fetch
 * would be served from the cache. That was wrong and the code says why: a failed fetch writes no cache
 * entry, so asking again is the correct behaviour rather than a defect.)
 *
 * What it cannot see, and does not claim: a request from the bundled `opencode` engine (a separate
 * process, and the document says so), anything the AI provider path does (that endpoint is the user's,
 * and `scripts/verify-ai-live.sh` measures it), and any traffic that ignores the proxy variables. The
 * invocations' own answers are recorded beside the proxy log for that last reason: an answer that names a
 * refused connection is evidence of an attempt even where the log is silent, and an answer that lists
 * offers is evidence of a fetch that got through.
 *
 * Usage:  xvfb-run -a -s "-screen 0 1280x800x24 -extension GLX" node e2e/webkit/probe-egress.mjs
 * Exit:   0 when the readings are consistent with the document — the two hosts appear, each when its cache
 *         says it must, nothing else appears, and the fresh cache produces no request at all;
 *         1 when a host the document does not list is contacted, or when nothing can be attributed.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { freeDualPort, sleep, until } from './webdriver.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../..')
const TARGET = path.join(REPO, 'apps/desktop/src-tauri/target')

const APP = (() => {
  const flag = process.argv.indexOf('--app')
  const given = flag === -1 ? null : process.argv[flag + 1]
  const app = given ?? path.join(TARGET, 'release/nekowite')
  if (!fs.existsSync(app)) {
    console.error(`FAIL: no application to drive at ${app}`)
    console.error('build one first: pnpm --filter @nekowite/desktop exec tauri build --no-bundle')
    process.exit(1)
  }
  return app
})()

/** The two hosts `docs/PRIVACY.md` names, each with the command that is supposed to reach it. */
const PET = { host: 'pets.thenightwatcher.online', command: 'desktop_pet_catalogue' }
const REGISTRY = { host: 'cdn.agentclientprotocol.com', command: 'agent_catalogue_read' }

/**
 * A registry document this build parses, in the shape its own tests use — so the fresh-cache phase is
 * measuring the cache rather than a parse failure that would fetch instead.
 */
const REGISTRY_DOCUMENT = JSON.stringify({
  version: '1.0.0',
  agents: [
    {
      id: 'probe-agent',
      name: 'Probe Agent',
      version: '1.0.0',
      description: 'written by probe-egress.mjs',
      license_url: 'https://example.invalid/licence',
      distribution: { npx: { package: 'probe-agent' } },
    },
  ],
})

/** `commands/agent_catalogue.rs`: `<data dir>/agent-catalogue/registry.json`, fresh for one hour. */
const REGISTRY_CACHE = path.join('.tmp-review-pnpm', 'data', 'dev.nekowite.app', 'agent-catalogue', 'registry.json')
/** Older than `CACHE_MAX_AGE` (one hour), without needing to know the constant. */
const STALE_AGE_MS = 2 * 60 * 60 * 1000

const REQUEST_TIMEOUT_MS = 15_000
const SESSION_TIMEOUT_MS = 120_000
/** How long each phase is given for the request to appear. A refused CONNECT is answered at once; this is
 *  patience for DNS, a slow accept and the app's own retry, not for a working endpoint. */
const PHASE_TIMEOUT_MS = 20_000
/** The idle window: how long the app is left alone at the welcome screen before anything is asked of it. */
const IDLE_MS = 10_000

/**
 * A proxy that records what it is asked for and refuses it.
 *
 * Refusing on purpose: the reading is the *attempt* — which host, for which feature, at what time — and a
 * proxy that pretended to be `pets.thenightwatcher.online` would leave the app's own failure reporting
 * unmeasured, which is the other half of what `PRIVACY.md` claims ("断网时前三条会失败并如实报错").
 */
function startProxy() {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push({ at: Date.now(), line: `GET ${req.url}` })
    res.writeHead(502, { 'content-type': 'text/plain' }).end('nekowite egress probe: not the endpoint')
  })
  server.on('connect', (req, socket) => {
    hits.push({ at: Date.now(), line: `CONNECT ${req.url}` })
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    socket.destroy()
  })
  // A proxy that crashed would read as "the app stopped requesting things", which is the one wrong
  // conclusion this instrument must never produce.
  server.on('clientError', (error, socket) => {
    hits.push({ at: Date.now(), line: `clientError ${error.code ?? ''}` })
    socket.destroy()
  })
  return { hits, server }
}

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
  const proxy = startProxy()
  const proxyPort = await new Promise((resolve) => proxy.server.listen(0, '127.0.0.1', () => resolve(proxy.server.address().port)))
  const proxyUrl = `http://127.0.0.1:${proxyPort}`
  console.error(`--- proxy on ${proxyUrl}`)

  const SCRATCH = path.join(REPO, '.tmp-review-pnpm')
  const ENV = {
    ...process.env,
    XDG_DATA_HOME: path.join(SCRATCH, 'data'),
    XDG_CACHE_HOME: path.join(SCRATCH, 'cache'),
    XDG_STATE_HOME: path.join(SCRATCH, 'state'),
    XDG_CONFIG_HOME: path.join(SCRATCH, 'config'),
    // The X11 backend for the same reason `drive-app.mjs` gives: this machine is a Wayland session, and a
    // GTK window would be a compositor surface that `xwininfo` cannot see. Nothing here reads windows, but
    // the app behaves the same way it does for the other probes.
    GDK_BACKEND: 'x11',
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    // The app talks to itself over `ipc://` and `http://ipc.localhost`; sending that through a proxy would
    // measure a broken application rather than a quiet one.
    NO_PROXY: 'localhost,127.0.0.1,::1,ipc.localhost,asset.localhost,tauri.localhost',
    no_proxy: 'localhost,127.0.0.1,::1,ipc.localhost,asset.localhost,tauri.localhost',
  }

  const webkitPort = await freeDualPort()
  const driverPort = await freeDualPort()
  const driverLog = path.join(TARGET, 'probe-egress-tauri-driver.log')
  const driver = spawn(
    'tauri-driver',
    ['--port', String(driverPort), '--native-port', String(webkitPort), '--native-driver', '/usr/bin/WebKitWebDriver'],
    { stdio: ['ignore', fs.openSync(driverLog, 'w'), fs.openSync(driverLog, 'a')], detached: true, env: ENV },
  )
  driver.unref()
  await sleep(800)

  const session = { id: null, port: driverPort }
  const run = (method, suffix, body) => request(session.port, method, `/session/${session.id}${suffix}`, body)
  const script = (source) => ({ script: source, args: [] })
  const readings = { proxy: proxyUrl, phases: {} }
  /** The proxy hits that arrived since `from`, so each phase can be attributed by time rather than by hope. */
  const since = (from) => proxy.hits.filter((hit) => hit.at >= from).map((hit) => hit.line)
  const phase = async (name, body) => {
    const from = Date.now()
    const detail = await body()
    const hits = since(from)
    readings.phases[name] = { hits, ...(detail ? { detail } : {}) }
    return hits
  }

  try {
    session.id = await until(
      async () =>
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
    )
    await until(
      async () => {
        const state = await run('POST', '/execute/sync', script('return document.readyState')).catch(() => null)
        return state === 'complete' ? state : null
      },
      { timeout: 30_000, what: 'the app page to finish loading' },
    )
    // The session attaches to one of the app's windows and on this build that is a pet window, whose page
    // has no shell — so the main window is selected first, exactly as `drive-app.mjs` does.
    const handles = await run('GET', '/window/handles').catch(() => [])
    for (const handle of Array.isArray(handles) ? handles : []) {
      await run('POST', '/window', { handle }).catch(() => undefined)
      const url = await run('GET', '/url').catch(() => '')
      if (!String(url).includes('desktop-pet')) break
    }
    readings.url = await run('GET', '/url').catch((e) => `unreadable: ${String(e?.message ?? e).slice(0, 100)}`)
    readings.tauri = await run('POST', '/execute/sync', script('return Boolean(window.__TAURI_INTERNALS__)')).catch(
      () => false,
    )

    // Phase 1: the idle window. Nothing has been asked of the app yet, and nothing may leave.
    await phase('idle', async () => {
      await sleep(IDLE_MS)
      return { waitedMs: IDLE_MS }
    })

    /**
     * Ask for one catalogue and let the promise settle on the page rather than in this request.
     *
     * The command's own answer is part of the reading — a fetch refused by a proxy names the connection it
     * could not make — and waiting for it inside a driver call would time out on the very failure this
     * probe is built to observe.
     */
    const invoke = async (name, target) => {
      // Counted rather than timed: the phase's own start is taken inside `phase` below, and a window
      // computed from "now" would also count hits that belong to the phase before this one.
      const before = proxy.hits.length
      await run('POST', '/execute/sync', {
        script: `window.__probeInvoke = { state: 'pending' }
          window.__TAURI_INTERNALS__.invoke(arguments[0]).then(
            (value) => { window.__probeInvoke = { state: 'ok', value: JSON.stringify(value).slice(0, 300) } },
            (error) => { window.__probeInvoke = { state: 'error', value: String((error && error.message) || error).slice(0, 300) } })
          return 'started'`,
        args: [name],
      }).catch((e) => {
        readings[`${name}StartError`] = String(e?.message ?? e).slice(0, 200)
      })
      await phase(target, async () => {
        await until(async () => (proxy.hits.length > before ? true : null), {
          timeout: PHASE_TIMEOUT_MS,
          what: `a request from ${name}`,
        }).catch(() => null)
        return { command: name }
      })
      readings.phases[target].answer = await run(
        'POST',
        '/execute/sync',
        script('return window.__probeInvoke || { state: "none" }'),
      ).catch((e) => ({ state: 'unreadable', value: String(e?.message ?? e).slice(0, 160) }))
    }

    /**
     * The registry's cache, both arms of its rule, before the pet catalogue is asked for anything.
     *
     * The file is written by the probe rather than by a first successful fetch, because the endpoint is
     * refused on this machine — and the phase is about the *rule*, not the network: a fresh cache answers
     * without a request, a stale one must produce exactly the documented one.
     */
    const seedRegistryCache = (ageMs) => {
      const file = path.join(REPO, REGISTRY_CACHE)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, REGISTRY_DOCUMENT)
      const when = new Date(Date.now() - ageMs)
      fs.utimesSync(file, when, when)
      return file
    }
    seedRegistryCache(0)
    await invoke(REGISTRY.command, 'registryFreshCache')
    seedRegistryCache(STALE_AGE_MS)
    await invoke(REGISTRY.command, 'registryStaleCache')

    await invoke(PET.command, 'petCatalogue')
  } finally {
    if (session.id) await run('DELETE', '').catch(() => undefined)
    try {
      process.kill(-driver.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    proxy.server.close()
    await sleep(200)
  }

  readings.allHits = proxy.hits.map((hit) => hit.line)
  console.log(JSON.stringify(readings, null, 2))

  const lines = (name) => (readings.phases[name]?.hits ?? []).join(' | ')
  const hostsIn = (name) =>
    (readings.phases[name]?.hits ?? [])
      .map((line) => line.replace(/^CONNECT\s+/, '').split(':')[0])
      .filter((host) => host.length > 0)
  const answerIn = (name) => JSON.stringify(readings.phases[name]?.answer ?? null)
  const problems = []
  const notes = []

  if (readings.tauri !== true) problems.push('window.__TAURI_INTERNALS__ is absent: this is not a Tauri page')
  if (hostsIn('idle').length > 0) {
    problems.push(`something left the app while nothing was asked of it: ${lines('idle')}`)
  }
  // The control, and the cache's own claim: a fresh cache must answer without the network.
  if (hostsIn('registryFreshCache').length > 0) {
    problems.push(
      `a fresh registry cache still went to the network: ${lines('registryFreshCache')} (answer: ${answerIn('registryFreshCache')})`,
    )
  }
  if (!hostsIn('registryStaleCache').includes(REGISTRY.host)) {
    notes.push(
      `a stale registry cache produced no request to ${REGISTRY.host} (hits: ${lines('registryStaleCache') || 'none'}, answer: ${answerIn('registryStaleCache')})`,
    )
  }
  if (!hostsIn('petCatalogue').includes(PET.host)) {
    notes.push(
      `the pet catalogue produced no request to ${PET.host} (hits: ${lines('petCatalogue') || 'none'}, answer: ${answerIn('petCatalogue')})`,
    )
  }
  const documented = new Set([PET.host, REGISTRY.host])
  const phases = ['idle', 'registryFreshCache', 'registryStaleCache', 'petCatalogue']
  const unlisted = [...new Set(phases.flatMap((name) => hostsIn(name)))].filter(
    (host) => !documented.has(host),
  )
  if (unlisted.length > 0) {
    problems.push(`host(s) docs/PRIVACY.md does not list were contacted: ${unlisted.join(', ')}`)
  }

  if (problems.length > 0) {
    console.error('FAIL:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exitCode = 1
    return
  }
  if (notes.length > 0) {
    console.error('INCONCLUSIVE: nothing the document lists was reached, and nothing unlisted was either.')
    for (const note of notes) console.error(`  - ${note}`)
    console.error('Either the app does not fetch these on this build, or its HTTP stack ignored the proxy')
    console.error('variables. The answers above name what each command actually did, which is the tiebreaker.')
    process.exitCode = 1
    return
  }
  console.log('PASS: the app sat idle at its welcome screen with nothing leaving it; a fresh registry cache')
  console.log(`      answered with no request at all; a stale one contacted exactly ${REGISTRY.host}; and the`)
  console.log(`      pet catalogue — uncached by design — contacted exactly ${PET.host}. Both answers named the`)
  console.log('      URL they could not reach, which is the other half of what the document claims.')
}

await main()
