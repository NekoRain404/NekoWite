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
 * makes through its own stack arrives as a `CONNECT host:port` line with a timestamp. Five phases, because
 * the claim is about *when*: idle at the welcome screen (nothing may leave), then the agent registry with a
 * **fresh** cache (nothing may leave either — `agent_catalogue_read` is cache-first), then the same command
 * with a **stale** cache (exactly the documented host), then the pet catalogue (which is deliberately not
 * cached, so it goes out every time), and last a note rendered in the editor with a **remote image** in it
 * — the document's second network claim, that rendering never reaches for one.
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
import { seedVault } from './drive-vault.mjs'

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

/**
 * The note the last phase renders: a **remote** image the policy must refuse, a local one it must load,
 * and inline math — because `docs/PRIVACY.md` makes a second claim about what rendering does ("文档里的
 * 远程图片不会被加载 … 因此渲染笔记不会顺带发起网络请求") and it is the same instrument that can check it.
 */
const RENDERER_VAULT = path.join(TARGET, 'probe-egress-vault')
const RENDERER_NOTE = 'egress-probe-note.md'
const RENDERER_TITLE = 'egress-probe-note'
// A host that resolves, not a `.invalid` one: if a future change relaxed `img-src` far enough
// for the image to load, the probe has to see the request it caused, and an unresolvable name
// would fail identically either way.
const REMOTE_IMAGE = 'https://pets.thenightwatcher.online/probe-remote-image.png'
/** What MathLive's own markup contains, and the LaTeX fallback never does. */
const MATH_RENDERED = 'ML__latex'
const RENDERER_ASSET =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="40"><rect width="64" height="40" fill="#22c55e"/></svg>\n'
const RENDERER_CONTENT = `# ${RENDERER_TITLE}

![remote](${REMOTE_IMAGE})

![local](probe-asset.svg)

Inline math $x^2 + y^2 = z^2$ follows.
`
/** A second note, so the math note can be left and re-entered without closing a tab or typing. */
const PLAIN_NOTE = 'egress-plain-note.md'
const PLAIN_TITLE = 'egress-plain-note'
const PLAIN_CONTENT = `# ${PLAIN_TITLE}

Nothing to render here but this sentence.
`

/** The W3C element key, so an element can be clicked through the driver rather than by a page script. */
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'

/**
 * What the editor's image node views report about themselves.
 *
 * `packages/editor-core/src/image/node-view.ts` gives each image a `<figure class="neko-image">` with
 * `data-failed`, a message span and two buttons — and it decides *which* affordance to show by asking
 * whether the src is remote (`isRemoteHttpSrc`): retry is useless for an image the host's policy refuses,
 * so the honest offer is "open in browser". That difference is what this reads.
 */
const RENDERER_FIGURES_SCRIPT = `
const figures = Array.from(document.querySelectorAll('.ProseMirror figure.neko-image'))
return {
  figures: figures.map((figure) => {
    const img = figure.querySelector('img')
    return {
      failed: figure.getAttribute('data-failed'),
      src: (img && img.getAttribute('src') || '').slice(0, 60),
      loaded: img ? Boolean(img.complete && img.naturalWidth > 0) : null,
      message: (figure.querySelector('.neko-image-error-msg') || {}).textContent || null,
      retryHidden: figure.querySelector('.neko-image-error-retry')?.hasAttribute('hidden') ?? null,
      openHidden: figure.querySelector('.neko-image-error-open')?.hasAttribute('hidden') ?? null,
    }
  }),
  math: document.querySelectorAll('.ProseMirror .math-node').length,
  mathInline: document.querySelectorAll('.ProseMirror .math-inline').length,
  mathFields: document.querySelectorAll('.ProseMirror math-field').length,
  mathSample: (document.querySelector('.ProseMirror .math-node')?.textContent ?? '').slice(0, 40),
  text: (document.querySelector('.ProseMirror')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 160),
}
`

const REQUEST_TIMEOUT_MS = 15_000
const SESSION_TIMEOUT_MS = 120_000
/** How long each phase is given for the request to appear. A refused CONNECT is answered at once; this is
 *  patience for DNS, a slow accept and the app's own retry, not for a working endpoint. */
const PHASE_TIMEOUT_MS = 20_000
/** The idle window: how long the app is left alone at the welcome screen before anything is asked of it. */
const IDLE_MS = 10_000
/**
 * When the math node is sampled, in milliseconds after the editor appeared.
 *
 * `math/atoms.ts`'s `renderLatexMarkup` renders real math only when MathLive has loaded, and until then it
 * falls back to the escaped LaTeX. How long that lasts is a question about timing, so it is measured as
 * one: the first sample is taken while the page is still settling and the last one long after any import
 * should have finished. This is what caught the node view rendering once, before the library arrived, and
 * never again — the fix is in `views.ts`, and the assertion below is what keeps it fixed.
 */
const MATH_SAMPLE_AT_MS = [4_000, 12_000, 24_000]

/** Whether MathLive arrived, and what the math node is made of, at one moment. */
const MATH_SAMPLE_SCRIPT = `
const node = document.querySelector('.ProseMirror .math-node')
const styles = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))
return {
  mathNodes: document.querySelectorAll('.ProseMirror .math-node').length,
  hasMathLive: Boolean(window.MathLive),
  // \`loadMathLive\` imports the library's stylesheet with the module, and the bundler injects that as a
  // style tag or a link — evidence that the import *succeeded*, where \`window.MathLive\` is only evidence
  // that a global was set (an ESM bundle need not set one).
  mathLiveStyles: styles.filter((s) => /ML__|mathlive/i.test(s.textContent || s.getAttribute('href') || '')).length,
  markup: node ? node.innerHTML.slice(0, 120) : null,
  text: node ? (node.textContent || '').slice(0, 40) : null,
}
`

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
  /** The W3C element lookup, so the note row can be clicked through the driver rather than by a script. */
  const findElement = async (using, value) => {
    const found = await run('POST', '/element', { using, value })
    return found?.[ELEMENT_KEY] ?? null
  }
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
    // Everything sent while the app was starting and while this session was being attached. The idle
    // window below opens *after* that, so without this bucket a boot-time request would be judged by
    // nothing — and "nothing left the app" would silently mean "nothing left it during the windows the
    // probe happened to create".
    readings.phases.boot = { hits: proxy.hits.map((hit) => hit.line) }

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

    /**
     * The last phase: a vault is opened and a note is rendered, and **nothing may leave** — not the
     * remote image the note names, and nothing else.
     *
     * A window of a few seconds after the editor appears, because the image node view resolves its src
     * asynchronously and a fetch that were going to happen would happen then.
     */
    seedVault({
      dir: RENDERER_VAULT,
      configHome: ENV.XDG_CONFIG_HOME,
      files: {
        'probe-asset.svg': RENDERER_ASSET,
        [RENDERER_NOTE]: RENDERER_CONTENT,
        [PLAIN_NOTE]: PLAIN_CONTENT,
      },
    })
    await phase('renderer', async () => {
      await run('POST', '/execute/sync', {
        script: `localStorage.setItem('nekowite.vault', arguments[0]); return true`,
        args: [RENDERER_VAULT],
      })
      // `{}` rather than no body: this driver refuses a POST with an empty body, which reads as a driver
      // capability until the body is sent.
      await run('POST', '/refresh', {})
      await until(
        async () =>
          (await run('POST', '/execute/sync', script('return document.querySelectorAll(".status-btn").length >= 1')).catch(
            () => false,
          ))
            ? true
            : null,
        { timeout: 30_000, what: 'the shell to render with a vault open' },
      ).catch(() => null)
      const row = await until(
        async () => findElement('xpath', `//*[contains(text(), "${RENDERER_TITLE}")]`).catch(() => null),
        { timeout: 20_000, what: 'the note row in the tree' },
      ).catch(() => null)
      if (row) await run('POST', `/element/${row}/click`, {})
      // The note's own text, not the presence of an editor: the app renders an empty `.ProseMirror` before
      // the document lands, so the weaker wait let the sampling below start on a note that was not there —
      // three samples of `mathNodes: 0` and a first reading that looked like the math bug it was measuring.
      // The assertion downstream is what caught it, which is why a recorded reading nothing reads is worth
      // less than one that can fail.
      await until(
        async () =>
          (await run('POST', '/execute/sync', {
            script:
              'const p = document.querySelector(".ProseMirror"); return p && p.innerText.includes(arguments[0]) ? true : null',
            args: ['Inline math'],
          }).catch(() => null))
            ? true
            : null,
        { timeout: 20_000, what: 'the note to open in the editor' },
      ).catch(() => null)
      // Given to the renderer to settle: the node view resolves `asset://` and the refused remote src
      // asynchronously, and a reading taken before that would see neither. The math node is sampled on
      // the way, because "does it still show the LaTeX source" is a question about time.
      const samples = []
      let waited = 0
      for (const at of MATH_SAMPLE_AT_MS) {
        await sleep(Math.max(0, at - waited))
        waited = at
        samples.push({
          at,
          ...(await run('POST', '/execute/sync', script(MATH_SAMPLE_SCRIPT)).catch((e) => ({
            unreadable: String(e?.message ?? e).slice(0, 140),
          }))),
        })
      }
      readings.mathSamples = samples
      /**
       * The warm arm: leave the math note and come back to it.
       *
       * If the formula renders the second time, the library is loaded by then and the fault is the
       * render-once timing above; if it still shows the LaTeX source, the library never arrived and the
       * fault is the import. Two clicks — no typing into the user's note, and no closing a tab.
       */
      const openNote = async (title) => {
        const row = await until(
          async () => findElement('xpath', `//*[contains(text(), "${title}")]`).catch(() => null),
          { timeout: 15_000, what: `the row for ${title}` },
        ).catch(() => null)
        if (row) await run('POST', `/element/${row}/click`, {})
        await until(
          async () =>
            (await run('POST', '/execute/sync', {
              script: 'return document.querySelector(".ProseMirror") && document.querySelector(".ProseMirror").innerText.includes(arguments[0]) ? true : null',
              args: [title],
            }).catch(() => null))
              ? true
              : null,
          { timeout: 15_000, what: `${title} to be open` },
        ).catch(() => null)
      }
      await openNote(PLAIN_TITLE)
      await openNote(RENDERER_TITLE)
      await sleep(3_000)
      readings.mathAfterReopen = await run('POST', '/execute/sync', script(MATH_SAMPLE_SCRIPT)).catch((e) => ({
        unreadable: String(e?.message ?? e).slice(0, 140),
      }))
      return { rendered: RENDERER_NOTE }
    })
    readings.rendererFigures = await run('POST', '/execute/sync', script(RENDERER_FIGURES_SCRIPT)).catch(
      (e) => `unreadable: ${String(e?.message ?? e).slice(0, 160)}`,
    )

    /**
     * The control this instrument was missing: a request **from the webview**, not from the Rust side.
     *
     * Every other arm proves the proxy sees `reqwest`'s traffic; none proved it sees WebKit's, and the
     * renderer phase's claim is about an `<img>` the webview would fetch. A top-level navigation is the one
     * request the page can make that no directive in `tauri.conf.json` restricts, so it is the honest
     * control: if this line never reaches the proxy, "the renderer sent nothing" cannot be attributed to
     * the webview's stack, and the probe says which half it measured instead of quoting it as both.
     */
    await phase('webviewControl', async () => {
      await run('POST', '/execute/sync', {
        script: `window.location.href = arguments[0]; return 'navigating'`,
        args: ['http://egress-control.invalid/'],
      }).catch(() => undefined)
      await sleep(4_000)
      return { url: 'http://egress-control.invalid/' }
    })
    // A last window before teardown, for anything deferred to the end of the phase above.
    await phase('settle', async () => {
      await sleep(3_000)
      return { waitedMs: 3_000 }
    })
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
  /**
   * The host a proxy line names, or null when it names none.
   *
   * Only well-formed lines count, which is the whole reason this is a function: `hostsIn` used to strip a
   * leading `CONNECT ` and split on `:`, so a plain-HTTP `GET http://host/…` became the host `GET http`
   * and the probe's own `clientError …` record became one too — an instrument that reported its own
   * bookkeeping as egress, and blamed the renderer for it.
   */
  const hostOf = (line) => {
    if (line.startsWith('CONNECT ')) return line.slice('CONNECT '.length).split(':')[0] || null
    if (line.startsWith('GET ')) {
      try {
        return new URL(line.slice('GET '.length)).hostname || null
      } catch {
        return null
      }
    }
    return null
  }
  /** The hosts a phase contacted. Diagnostics (`clientError …`) are recorded but never read as hosts. */
  const hostsIn = (name) => (readings.phases[name]?.hits ?? []).map(hostOf).filter((host) => host !== null)
  const diagnosticsIn = (name) => (readings.phases[name]?.hits ?? []).filter((line) => hostOf(line) === null)
  const answerIn = (name) => JSON.stringify(readings.phases[name]?.answer ?? null)
  const problems = []
  const notes = []
  const PHASES = ['boot', 'idle', 'registryFreshCache', 'registryStaleCache', 'petCatalogue', 'renderer', 'webviewControl', 'settle']
  readings.proxyDiagnostics = PHASES.flatMap((name) => diagnosticsIn(name))

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
  // The renderer's claim, in two halves: nothing left the app while it drew a note that names a remote
  // image — and the app said so on the image itself rather than showing a silently broken one.
  if (hostsIn('renderer').length > 0) {
    problems.push(
      `rendering a note sent something out of the app: ${lines('renderer')} — the note names ${REMOTE_IMAGE}, which the policy is supposed to refuse before any connection`,
    )
  }
  const figures = readings.rendererFigures
  if (figures === null || typeof figures !== 'object') {
    notes.push(`the renderer's image nodes could not be read (${figures})`)
  } else if (!Array.isArray(figures.figures) || figures.figures.length === 0) {
    notes.push(`the note rendered no image at all (editor text: ${JSON.stringify(figures.text ?? null)})`)
  } else {
    const remote = figures.figures.find((figure) => String(figure.src).startsWith('https://')) ?? null
    if (remote === null) {
      problems.push(`no image node kept the remote src, so the refusal was not measured: ${JSON.stringify(figures.figures)}`)
    } else {
      if (remote.failed !== 'true') problems.push(`the remote image is not marked failed: ${JSON.stringify(remote)}`)
      if (!remote.message) problems.push(`the remote image shows no message: ${JSON.stringify(remote)}`)
      if (remote.loaded === true) problems.push(`the remote image actually loaded: ${JSON.stringify(remote)}`)
      if (remote.openHidden !== false || remote.retryHidden !== true) {
        problems.push(
          `the remote image offers the wrong affordance (retry is useless for what the policy refuses): ${JSON.stringify(remote)}`,
        )
      }
    }
  }
  // `egress-control.invalid` is the probe's own navigation, sent on purpose to prove the webview honours
  // the proxy variables — the app never names it, and it is excluded here rather than reported as egress.
  const documented = new Set([PET.host, REGISTRY.host, 'egress-control.invalid'])
  const unlisted = [...new Set(PHASES.flatMap((name) => hostsIn(name)))].filter(
    (host) => !documented.has(host),
  )
  if (unlisted.length > 0) {
    problems.push(`host(s) docs/PRIVACY.md does not list were contacted: ${unlisted.join(', ')}`)
  }
  // The formula, asserted rather than printed: the samples are what caught the node view rendering its
  // fallback for ever, and a reading nothing reads cannot catch it a second time.
  const samples = Array.isArray(readings.mathSamples) ? readings.mathSamples : []
  if (samples.length === 0) {
    notes.push('the math node was never sampled')
  } else {
    const late = samples.filter((sample) => (sample.at ?? 0) >= 12_000)
    const unrendered = late.filter((sample) => !String(sample.markup ?? '').includes(MATH_RENDERED))
    if (unrendered.length > 0) {
      problems.push(
        `the formula is still the LaTeX source text after ${unrendered.map((s) => `${s.at}s`).join(', ')}: ${JSON.stringify(unrendered)}`,
      )
    }
    if (readings.mathAfterReopen && !String(readings.mathAfterReopen.markup ?? '').includes(MATH_RENDERED)) {
      problems.push(`the formula did not render after leaving the note and returning: ${JSON.stringify(readings.mathAfterReopen)}`)
    }
  }
  const localFigure = Array.isArray(figures?.figures)
    ? figures.figures.find((figure) => String(figure.src).startsWith('asset://')) ?? null
    : null
  if (localFigure === null) {
    problems.push('the note rendered no local image with an asset:// src, so the targeted half of the refusal is unmeasured')
  } else if (localFigure.failed === 'true' || localFigure.loaded !== true) {
    problems.push(`the local image beside the refused one did not load: ${JSON.stringify(localFigure)}`)
  }

  /**
   * Whether the control landed. Kept as a recorded limitation rather than a failure: the Rust-side phases
   * are measured either way, and calling the whole probe red because WebKitGTK ignores a proxy variable
   * would hide readings that are sound.
   */
  if (hostsIn('webviewControl').includes('egress-control.invalid')) {
    readings.webviewProxyControl = 'established — a navigation from the page reached the proxy'
  } else {
    readings.webviewProxyControl = 'NOT established — no request from the webview reached the proxy'
    notes.push(
      'a top-level navigation from the page never reached the proxy, so the renderer phase measured the request paths the probe can see, not every path WebKit could take',
    )
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
  const math = readings.rendererFigures?.math
  console.log('PASS: the app sat idle at its welcome screen with nothing leaving it; a fresh registry cache')
  console.log(`      answered with no request at all; a stale one contacted exactly ${REGISTRY.host}; the pet`)
  console.log(`      catalogue — uncached by design — contacted exactly ${PET.host}; and rendering a note that`)
  console.log(`      names ${REMOTE_IMAGE} sent nothing anywhere, with the image marked failed and offered`)
  console.log(`      "open in browser" instead of a retry that could never work (${math} math node(s), rendered).`)
  console.log(`      Webview control: ${readings.webviewProxyControl}.`)
}

await main()
