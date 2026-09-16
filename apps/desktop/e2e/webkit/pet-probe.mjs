#!/usr/bin/env node
/**
 * Measure the pet's canvas in WebKitGTK — the engine that ships.
 *
 * Every canvas claim D2 and this task make is taken in Chromium through Playwright, and `wry` on
 * Linux is WebKitGTK: the AppImage bundles it and `tokens.css` names the installed version. `README`
 * of this harness — `measure.mjs` — is the same argument for the editor's surfaces, and this file is
 * the pet's half of it. Playwright's `webkit` is a different port and does not answer the question,
 * so the real thing is started instead:
 *
 *   1. the frozen dev server, on a free port of its own — `vite.frozen.config` so a source edit
 *      cannot hot-reload the page under a measurement, and a free port so the app's own 1420 is
 *      never named, let alone taken;
 *   2. `WebKitWebDriver` on a free port of its own;
 *   3. `MiniBrowser`, driven by the driver, at `/desktop-pet.html` — the pet window's own page;
 *   4. `PetSprite` mounted in it with a sheet built in the page, read back as pixels;
 *   5. `PetBubble` mounted in the same page with the six-row fixture, measured against the height
 *      cap and against the window — 「气泡不越屏」 has two axes and one of them is a pixel height, so
 *      Chromium's answer to it (`desktop-pet-tasks.spec.ts`) is not the engine's answer.
 *
 *   node e2e/webkit/pet-probe.mjs            # JSON on stdout, verdict on stderr
 *   node e2e/webkit/pet-probe.mjs --keep     # leave the window up (debugging only)
 *
 * **What this measures, and what it does not.** It answers the *engine* question: does the sprite's
 * canvas get pixels in WebKitGTK, does the alpha-gutter slicer see the rows this sheet actually
 * drew, do the frames advance, does the hit test agree with the drawn pixels at the display's
 * pixel ratio, and does the bubble's row box come out at the height its cap promises. It does
 * **not** answer anything about the window: MiniBrowser is a different embedding from `wry` — no
 * transparency, no always-on-top, no input regions — so nothing here is evidence about §7.2's
 * compositor rows, and `linux_capabilities::Observations` must not be fed from this run.
 *
 * `MiniBrowser` opens a window on the user's real desktop, because WebKitGTK has no headless mode
 * (2.52's MiniBrowser takes no `--headless` and `WebKitWebDriver --help` offers none). The session
 * is closed the moment the probes return.
 */
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebDriver, freePort, sleep, until } from './webdriver.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..', '..')

/** The pet window's own page, which is what the real window loads. */
const PAGE = '/desktop-pet.html'
/** The sprite box the probe mounts: upstream's 100% size (`index.html:12`, `main.ts:116-117`). */
const SPRITE = { width: 160, height: 180 }
/** The sheet: 8x9 cells of 24px, three frames drawn per row, with a transparent gutter between. */
const SHEET = { cols: 8, rows: 9, cell: 24, frames: 3, inset: 4 }
/** How long to wait for a frame to advance: the idle rate is 3fps, so 1.4s is four frames. */
const FRAME_WAIT_MS = 1400
/**
 * The character window, as `window_host::CHARACTER_WINDOW_SIZE` builds it.
 *
 * The bubble's cap is `min(240px, 40vh)`, and `vh` is the *viewport* — so a measurement of the cap
 * has to be taken at the window's own height rather than in a box that happens to be that size.
 * The sprite probes above run at 480x420 and this resizes for the bubble step.
 */
const WINDOW = { width: 260, height: 320 }
/** MiniBrowser's own chrome, measured rather than assumed: a 420px content area needs 456 (above). */
const WINDOW_CHROME_PX = 36

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? true)
}

/**
 * `--host 127.0.0.1` is load-bearing, not tidiness — `measure.mjs` §4.1 records the run it cost:
 * left to itself Vite binds the name it was started with, and on this machine `localhost` resolves
 * to `::1` only, so a readiness probe against `127.0.0.1` never connects while the server's own log
 * says `ready in 190 ms`.
 */
async function startDevServer(port) {
  const child = spawn(
    'pnpm',
    ['dev', '--config', 'e2e/vite.frozen.config.ts', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    // `detached` puts `pnpm` and the `vite` it execs in one process group, so `stop()` can signal
    // the GROUP: killing the `pnpm` wrapper alone leaves `vite` bound with no parent.
    { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  let output = ''
  child.stdout.on('data', (b) => (output += String(b)))
  child.stderr.on('data', (b) => (output += String(b)))
  await until(
    async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${PAGE}`, { signal: AbortSignal.timeout(2000) })
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

/** Stop a process this file started, and everything it started. Only PIDs this file owns. */
function stop(child) {
  if (!child || child.killed || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

/**
 * The in-page mount, run as one asynchronous script.
 *
 * `executeAsync` because every step of it is a promise: a dynamic `import` of the dev server's
 * compiled modules (a page has no import map), the image decode, and the first frame.
 */
const MOUNT = `
const sprite = arguments[0], sheetSpec = arguments[1], win = arguments[2], done = arguments[arguments.length - 1];
(async () => {
  const entry = await (await fetch('/src/app/desktop-pet-entry.ts')).text();
  const vueUrl = entry.match(/["']([^"']*\\/deps\\/vue\\.js[^"']*)["']/)?.[1];
  if (!vueUrl) { done({ ok: false, why: 'the dev server serves no vue dependency' }); return; }
  const vue = await import(vueUrl);
  const component = await import('/src/features/desktop-pet/components/PetSprite.vue');

  // The window's mount point is where the real entry mounted itself. A second host beside it keeps
  // both in the document, which is what a window with a stated absence plus a sprite looks like.
  const host = document.createElement('div');
  host.id = 'probe-pet';
  document.body.append(host);

  // A dense sheet: SpritePlayer indexes the clips array with the state's row (clips[row]) and the
  // clips are the sheet's *drawn* row blocks, so a sheet with empty rows would collapse the index
  // space and row 7 would draw whatever block is seventh.
  const canvas = document.createElement('canvas');
  canvas.width = sheetSpec.cols * sheetSpec.cell;
  canvas.height = sheetSpec.rows * sheetSpec.cell;
  const ctx = canvas.getContext('2d');
  for (let row = 0; row < sheetSpec.rows; row++) {
    for (let frame = 0; frame < sheetSpec.frames; frame++) {
      ctx.fillStyle = 'hsl(' + ((row * 40 + frame * 8) % 360) + ' 70% 55%)';
      ctx.fillRect(
        frame * sheetSpec.cell + sheetSpec.inset - frame,
        row * sheetSpec.cell + sheetSpec.inset,
        sheetSpec.cell - sheetSpec.inset * 2 + frame * 2,
        sheetSpec.cell - sheetSpec.inset * 2,
      );
    }
  }
  const url = canvas.toDataURL('image/png');

  const mood = vue.ref('idle');
  const api = vue.ref(null);
  const app = vue.createApp({
    render: () => vue.h('div', { style: 'width:' + sprite.width + 'px;height:' + sprite.height + 'px' }, [
      vue.h(component.default, { ref: api, imageUrl: url, state: mood.value, width: sprite.width, height: sprite.height }),
    ]),
  });
  app.mount(host);
  window.__petProbe = {
    sheetURL: url,
    sheetSize: { width: canvas.width, height: canvas.height },
    setState: (next) => { mood.value = next; },
    hitTest: (x, y) => (api.value ? api.value.hitTest(x, y) : null),
    app,
  };

  // The bubble, in a box the size of the character window. Mounted in this same script rather than
  // in a second page load because the cap is a fraction of the viewport height, and the window has
  // to be resized for that to mean the window — a resize needs the surface already in the document.
  //
  // The fixture is the one the Playwright case uses, imported from the dev server rather than
  // copied: six long-Chinese rows behind two agents, which is what makes the row box taller than
  // any cap. A second copy of it here would be a second answer to "how tall is the content".
  const fixture = await import('/e2e/support/petFixture.ts');
  const bubbleComponent = await import('/src/features/desktop-pet/components/PetBubble.vue');
  const bubbleHost = document.createElement('div');
  bubbleHost.id = 'probe-bubble';
  bubbleHost.style.cssText =
    'width:' + win.width + 'px;height:' + win.height + 'px;display:flex;flex-direction:column;' +
    'justify-content:flex-end;gap:6px;overflow:hidden';
  document.body.append(bubbleHost);
  vue.createApp({
    render: () => vue.h(bubbleComponent.default, {
      tasks: fixture.petTasks(),
      layout: { maxTasks: 6 },
      phrases: fixture.petPhrases(),
      now: 1700000010000,
      agentLabels: { memory: 'Memory', opencode: 'OpenCode' },
    }),
  }).mount(bubbleHost);

  await vue.nextTick();
  // The sheet is a data URL: its decode is asynchronous even so, and a read taken before it commits
  // measures an empty canvas and calls it a failure.
  await new Promise((resolve) => setTimeout(resolve, 250));
  done({ ok: true });
})().catch((error) => done({ ok: false, why: String((error && error.message) || error) }));
`

/**
 * What is on the canvas, as numbers.
 *
 * Alpha decides "drawn" (§12's 非空透明像素), the four channels decide "the same" — and the *sprite
 * rect* is read back from the component's own placement rather than inferred, so the hit test below
 * is compared against where the pet believes it is.
 */
const DIGEST = `
const canvas = document.querySelector('#probe-pet canvas.pet-sprite'), done = arguments[arguments.length - 1];
if (!canvas) { done({ ok: false, why: 'no sprite canvas' }); return; }
const ctx = canvas.getContext('2d');
const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
const data = image.data;
let opaque = 0, transparent = 0, hash = 2166136261;
for (let i = 0; i < data.length; i += 4) {
  if (data[i + 3] > 16) opaque += 1; else transparent += 1;
  hash = Math.imul(hash ^ data[i], 16777619);
  hash = Math.imul(hash ^ data[i + 1], 16777619);
  hash = Math.imul(hash ^ data[i + 2], 16777619);
  hash = Math.imul(hash ^ data[i + 3], 16777619);
}
done({
  ok: true,
  hash: (hash >>> 0).toString(16),
  opaque, transparent,
  backing: { width: canvas.width, height: canvas.height },
  client: { width: canvas.clientWidth, height: canvas.clientHeight },
  dpr: devicePixelRatio,
});
`

/** The invariants, each named with the mutation that would turn it red. */
function verify(results) {
  const checks = []
  const run = (name, detail, holds) => checks.push({ name, detail, holds: Boolean(holds) })

  // FAILS IF: the run picked up a different engine — MiniBrowser from a different WebKitGTK, or a
  // driver that reported something else entirely. The name is `MiniBrowser` (WebKitGTK's own example
  // browser, which `webdriver.mjs` explains is what WebKitWebDriver drives) and the version is the
  // WebKitGTK version, so the check is about the *version*: `tokens.css` and this whole programme
  // name the installed 2.52.6, and a number taken on another one is a number about another engine.
  run(
    'the engine is the one this programme measures on',
    `${results.engine.browserName} ${results.engine.browserVersion} on ${results.engine.platformName}`,
    results.engine.platformName === 'linux' && /^2\.\d+\.\d+/.test(results.engine.browserVersion ?? ''),
  )

  const idle = results.states.idle
  // FAILS IF: the sheet never loaded (a CORS taint on the data URL, a decode that never commits), or
  // the canvas was sized to zero. Both leave `opaque` at 0 while everything else still "works".
  run('the sprite drew pixels at all', `opaque ${idle.opaque} of ${idle.opaque + idle.transparent}`, idle.opaque > 0)
  // FAILS IF: the frame filled its cell — a fit that ignores the sheet's transparent margins, or a
  // clear that never ran. Zero transparent pixels is the "not empty" half of 非空透明像素.
  run('and left the margins transparent', `transparent ${idle.transparent}`, idle.transparent > 0)

  // FAILS IF: the backing store stopped being the CSS box times the display's ratio — the D2
  // deviation that keeps pixel art from being resampled by the compositor.
  const ratio = idle.backing.width / idle.client.width
  run(
    'the backing store is the CSS box at device resolution',
    `${idle.client.width}x${idle.client.height} css → ${idle.backing.width}x${idle.backing.height} backing (dpr ${idle.dpr}, ratio ${ratio})`,
    Math.abs(ratio - idle.dpr) < 0.01 && idle.client.width === SPRITE.width,
  )

  // FAILS IF: the state stops choosing the row. The sheet gives every row its own colour, so a
  // repaint that ignored the state would leave the digest identical.
  run(
    'a state change draws a different row',
    `idle ${idle.hash} → working ${results.states.working.hash}`,
    idle.hash !== results.states.working.hash,
  )
  run(
    'and a third row is a third picture',
    `working ${results.states.working.hash} → waiting ${results.states.waiting.hash}`,
    results.states.waiting.hash !== results.states.working.hash &&
      results.states.waiting.hash !== idle.hash,
  )

  // FAILS IF: the frame loop stops advancing — the frame index frozen, or the clock stopped. The
  // wait is 1.4s against a 333ms frame, so this is four frames of slack.
  run(
    'the frames advance on their own',
    `idle ${results.states.idle.hash} → +${FRAME_WAIT_MS}ms ${results.advanced.hash}`,
    results.advanced.hash !== idle.hash,
  )

  // FAILS IF: the hit test's CSS→backing scaling is dropped, or the sprite rect stops following the
  // drawn sprite. Both are §7.2's drag-versus-click boundary, and both are checked *against the
  // drawn pixels* rather than against the rect alone.
  run(
    'the hit test agrees with the pixels',
    `centre ${results.hit.centre} (alpha ${results.hit.centreAlpha}), corner ${results.hit.corner} (alpha ${results.hit.cornerAlpha})`,
    results.hit.centre === true && results.hit.corner === false,
  )

  /*
   * 气泡不越屏, height axis — in this engine rather than in Chromium.
   *
   * The cap is `min(240px, 40vh)` and the window is 320 tall, so the box may be 128px. The numbers
   * are mirrored here rather than imported for the reason the Playwright case states: a check that
   * read the constant would follow any change to it and go on passing, which is the failure mode
   * this whole measurement exists to catch.
   */
  const bubble = results.bubble
  const cap = Math.min(240, 0.4 * (bubble?.viewport.height ?? 0))
  const round = (value) => Math.round(value * 10) / 10

  // FAILS IF: the cap stopped being applied (`maxHeight` dropped, or the element it is applied to
  // changed), or the content stopped being tall enough to fill it — 128 is what a box at its cap
  // measures, and both failure modes leave a different number.
  run(
    'the rows box is capped here too',
    `rows ${round(bubble.rows.height)} of a ${cap}px cap in a ${bubble.viewport.width}x${bubble.viewport.height} window`,
    Math.abs(bubble.rows.height - cap) <= 1,
  )
  // FAILS IF: the surface around the box grows what the box does not — a footer, a second list, a
  // padding change. 60px is the ceiling the Playwright case states: the measured chrome (padding,
  // border) is 14px, and the rest is the room the count, fold and pager rows need.
  run(
    'and the surface is that box plus its chrome',
    `bubble ${round(bubble.bubble.width)}x${round(bubble.bubble.height)} (${round(bubble.bubble.height - bubble.rows.height)}px of chrome)`,
    bubble.bubble.height <= cap + 60 + 1,
  )
  // FAILS IF: the surface leaves the window it is drawn in. Measured against the window stand-in
  // and not the viewport: this page also carries the entry's own notice above it.
  run(
    'and it stays inside the window',
    `bubble ${round(bubble.bubble.x)},${round(bubble.bubble.y)} → ${round(bubble.bubble.x + bubble.bubble.width)},${round(bubble.bubble.y + bubble.bubble.height)} in ${round(bubble.frame.x)},${round(bubble.frame.y)} → ${round(bubble.frame.x + bubble.frame.width)},${round(bubble.frame.y + bubble.frame.height)}`,
    bubble.bubble.x >= bubble.frame.x - 1 &&
      bubble.bubble.x + bubble.bubble.width <= bubble.frame.x + bubble.frame.width + 1 &&
      bubble.bubble.y >= bubble.frame.y - 1 &&
      bubble.bubble.y + bubble.bubble.height <= bubble.frame.y + bubble.frame.height + 1,
  )

  return {
    passed: checks.filter((c) => c.holds).length,
    failed: checks.filter((c) => !c.holds).length,
    results: checks,
  }
}

/** Alpha at a CSS point, read out of the canvas the same way the hit test does. */
const ALPHA_AT = `
const pt = arguments[0], done = arguments[arguments.length - 1];
const canvas = document.querySelector('#probe-pet canvas.pet-sprite');
if (!canvas) { done(null); return; }
const kx = canvas.width / (canvas.clientWidth || 1), ky = canvas.height / (canvas.clientHeight || 1);
const ctx = canvas.getContext('2d');
done(ctx.getImageData(Math.floor(pt.x * kx), Math.floor(pt.y * ky), 1, 1).data[3]);
`

/**
 * The bubble's boxes, as CSS pixels, in the window it is drawn in.
 *
 * Three rects and not one: the *surface* is what a host sizes a window for, the *rows box* is where
 * the cap is applied (the element that grows), and the frame is the window stand-in — so a check
 * can say which of the three disagreed. `getBoundingClientRect` rather than `offsetHeight` because
 * WebKitGTK returns fractional layout here and rounding it away first would hide a 1px miss.
 */
const BUBBLE_GEOMETRY = `
const done = arguments[arguments.length - 1];
const frame = document.getElementById('probe-bubble');
const bubble = frame && frame.querySelector('.pet-bubble');
const rows = frame && frame.querySelector('.pet-task__scroll');
if (!frame || !bubble || !rows) { done({ ok: false, why: 'the bubble is not in the page' }); return; }
const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
done({
  ok: true,
  viewport: { width: innerWidth, height: innerHeight },
  frame: box(frame),
  bubble: box(bubble),
  rows: box(rows),
});
`

async function main() {
  const keep = Boolean(arg('keep', false))
  const vitePort = await freePort()
  const driverPort = await freePort()
  if (!vitePort || !driverPort) throw new Error('no free port could be reserved')

  const dev = await startDevServer(vitePort)
  const driver = spawn('/usr/bin/WebKitWebDriver', [`--port=${driverPort}`], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  })

  const wd = new WebDriver(driverPort)
  const results = { engine: null, page: null, states: {}, hit: {}, advanced: null, bubble: null }
  const watchdog = setTimeout(() => {
    process.stderr.write('\n[webkit-pet] watchdog: nothing finished in 300s\n')
    process.kill(process.pid, 'SIGKILL')
  }, 300_000)
  watchdog.unref()

  try {
    stage('session')
    results.engine = await wd.session()

    const url = `http://127.0.0.1:${vitePort}${PAGE}`
    stage(`navigate ${url}`)
    await wd.navigate(url)

    // AFTER the navigation, and verified rather than requested: a `setWindowRect` issued before the
    // first navigation is accepted and then discarded, and the run then measures MiniBrowser's
    // default viewport believing it is the one it asked for (measure.mjs §5.2 — it cost a run).
    stage('set viewport')
    await wd.setWindowRect({ width: 480, height: 420 + 36, x: 0, y: 0 })
    await until(() => wd.execute('return innerWidth === 480 && innerHeight === 420'), {
      timeout: 10_000,
      what: 'a 480x420 content area',
    })

    stage('mount the sprite')
    const mounted = await wd.executeAsync(MOUNT, [SPRITE, SHEET, WINDOW])
    if (!mounted?.ok) throw new Error(`the mount failed: ${mounted?.why}`)

    stage('read the page')
    results.page = await wd.execute(
      `const notice = document.querySelector('.pet-root__notice');
       return { path: location.pathname, notice: notice ? notice.textContent : null,
                hasAppShell: Boolean(document.querySelector('.panes, .status-bar, .settings-overlay')),
                bodyBackground: getComputedStyle(document.body).backgroundColor };`,
    )

    stage('digest: idle')
    results.states.idle = await wd.executeAsync(DIGEST)
    // The two points the hit test is read at: the middle of the CSS box, and a corner the sprite's
    // own fit cannot reach (it is anchored bottom-centre inside the box).
    const points = { centre: { x: SPRITE.width / 2, y: SPRITE.height * 0.85 }, corner: { x: 2, y: 2 } }
    results.hit.centreAlpha = await wd.executeAsync(ALPHA_AT, [points.centre])
    results.hit.cornerAlpha = await wd.executeAsync(ALPHA_AT, [points.corner])

    stage('wait a few frames')
    await sleep(FRAME_WAIT_MS)
    results.advanced = await wd.executeAsync(DIGEST)

    stage('digest: working and waiting')
    await wd.execute('window.__petProbe.setState("working"); return true;')
    await sleep(400)
    results.states.working = await wd.executeAsync(DIGEST)
    await wd.execute('window.__petProbe.setState("waiting"); return true;')
    await sleep(400)
    results.states.waiting = await wd.executeAsync(DIGEST)
    await wd.execute('window.__petProbe.setState("idle"); return true;')
    await sleep(400)

    stage('hit test')
    results.hit.centre = await wd.execute(
      `return window.__petProbe.hitTest(${points.centre.x}, ${points.centre.y});`,
    )
    results.hit.corner = await wd.execute(
      `return window.__petProbe.hitTest(${points.corner.x}, ${points.corner.y});`,
    )

    // The bubble's cap is a fraction of the window's height, so the window has to be the character's
    // before the bubble means anything: the same 320px `window_host::CHARACTER_WINDOW_SIZE` builds.
    // The sprite probes above are done at this point — they are about the canvas, not the viewport —
    // and the height is verified rather than requested for the reason the first resize is
    // (`setWindowRect` is accepted and discarded if it is issued at the wrong moment).
    //
    // **The width is not set to 260 and cannot be.** Measured: asking for a 260px content width
    // gives 299 (outer 299x356), so MiniBrowser or the window manager enforces a floor around 299px
    // and a request below it is silently rounded up. The height is what the cap reads, and the box
    // the bubble is drawn in is the 260px element in the page — so the width floor costs this probe
    // nothing; it would matter to anything that had to measure a 260px *viewport*.
    stage('resize to the character window')
    await wd.setWindowRect({
      width: WINDOW.width,
      height: WINDOW.height + WINDOW_CHROME_PX,
      x: 0,
      y: 0,
    })
    await until(() => wd.execute(`return innerHeight === ${WINDOW.height};`), {
      timeout: 10_000,
      what: `a ${WINDOW.height}px content height`,
    })

    stage('bubble geometry')
    results.bubble = await wd.executeAsync(BUBBLE_GEOMETRY)
    if (!results.bubble?.ok) throw new Error(`the bubble is not measurable: ${results.bubble?.why}`)

    const logs = await wd.logs()
    if (logs) results.console = logs.map((l) => `${l.level}: ${l.message}`).slice(0, 20)
    results.verdict = verify(results)
  } finally {
    stage('teardown')
    await wd.quit()
    if (!keep) {
      stop(driver)
      stop(dev)
    }
    clearTimeout(watchdog)
  }

  console.log(JSON.stringify(results, null, 2))
  process.stderr.write(
    `\n[webkit-pet] ${results.verdict.passed} passed, ${results.verdict.failed} failed\n` +
      results.verdict.results.map((r) => `  ${r.holds ? 'ok  ' : 'FAIL'} ${r.name} — ${r.detail}`).join('\n') +
      '\n',
  )
  // The drivers and the dev server are children of this process and their handles keep the event
  // loop alive after the session is over, which turns a finished run into a hang with the answer
  // already printed.
  process.exit(results.verdict.failed ? 1 : 0)
}

/** Progress on stderr, so a hang says which step hung. Stdout stays pure JSON. */
function stage(name) {
  process.stderr.write(`[webkit-pet] ${name}\n`)
}

await main()
