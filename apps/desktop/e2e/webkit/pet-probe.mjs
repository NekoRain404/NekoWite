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
 *   6. `DesktopPetRoot` — the component `desktop-pet-entry.ts` mounts, and the only thing that
 *      mounts a sprite in the product — driven through a hide and a show, so the sprite is measured
 *      on the parent's `v-if` rather than on a mount the probe performs itself.
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
import { driveBall, verifyBall } from './probe-ball.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..', '..')

/** The pet window's own page, which is what the real window loads. */
const PAGE = '/desktop-pet.html'
/** The sprite box the probe mounts: upstream's 100% size (`index.html:12`, `main.ts:116-117`). */
const SPRITE = { width: 160, height: 180 }
/**
 * The box `DesktopPetRoot` is mounted in, which is the window's own size.
 *
 * Bigger than `SPRITE` on purpose: the root draws the bubble above the character, so a host at the
 * sprite's own height would leave the canvas at the bottom of a box the bubble had already filled.
 * The sprite's *own* box is still `SPRITE` — `DesktopPetRoot` defaults `width`/`height` to it.
 */
const ROOT_BOX = { width: 320, height: 420 }
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
/**
 * The box the bubble step's window stand-in is drawn in: **the widest window the host ever builds**.
 *
 * Wider than `WINDOW` on purpose, and that is the whole point of the number. `character_window_size`
 * is `max(size + 100, 260)` by `round(size * 180 / 160) + 140`, so a 320px character — the slider's
 * ceiling — gets 420x500. At 260 there is *no slack*: the bubble's cap and the window are the same
 * number, so a surface pinned to the left edge and one centred in the middle have identical
 * geometry and the claim below cannot fail. The deviation this step measures needs room to be
 * visible in, which is why the Chromium case swept 320 with 160 as its control.
 *
 * The *height* stays `WINDOW`'s, because the rows' cap is `min(240px, 40vh)` and `vh` is the
 * viewport — the height is what the resize below has to get right.
 */
const BUBBLE_WINDOW = { width: 420, height: 320 }
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

  // The bubble, inside the **product's own root**, in a box the size of the character window.
  //
  // Mounted in this same script rather than in a second page load because the cap is a fraction of
  // the viewport height, and the window has to be resized for that to mean the window — a resize
  // needs the surface already in the document.
  //
  // **This step used to mount PetBubble directly into a div whose own style carried
  // display:flex/flex-direction:column/justify-content:flex-end/gap:6px** — that is, it supplied
  // the flex column .pet-root is, with a different gap and no align-items at all. So the bubble
  // was measured in a layout the product never has, and the two things that column decides — the
  // centring on the cross axis and the room given back on the main one — were measured as whatever
  // the instrument happened to do. The root is the component desktop-pet-entry.ts mounts, and the
  // host below carries a box and nothing else; every rule between them is the product's.
  //
  // The tasks come from the memory double rather than from 'petFixture.ts', so the run that carries
  // a real 36-character session id can be asked for — startRun({ sessionId }) is the host's own
  // way of filing a run, and a fixture with session-1 in it is exactly what hid the row overflow
  // this step now measures. layoutMaxRows is written through the double for the same reason: the
  // cap is a setting, and the row box has to be over it for the cap to be what is measured.
  const memory = await import('/src/platform/gateways/memory-pet.ts');
  const rootComponent = await import('/src/features/desktop-pet/components/DesktopPetRoot.vue');
  const bubbleHost = document.createElement('div');
  bubbleHost.id = 'probe-bubble';
  bubbleHost.style.cssText = 'width:' + win.width + 'px;height:' + win.height + 'px';
  document.body.append(bubbleHost);

  const bubbleGateway = memory.createMemoryPetGateway({ visible: true });
  // One run per fixture row, and the last one under a uuid: 8-4-4-4-12 hex, the shape a real ACP
  // session id has. The other six keep it short so the row that wraps is the one being named.
  // Enough runs that the row box is over its cap whatever the phrases turn out to be, and the last
  // one under a uuid: 8-4-4-4-12 hex, the shape a real ACP session id has. Started last so it ranks
  // first: the ranking is urgency, then most recently changed, and every run here is working.
  for (let i = 0; i < 13; i += 1) bubbleGateway.startRun({ sessionId: 'cycle-' + (i + 1) });
  bubbleGateway.startRun({ sessionId: '0193c0de-4f2a-7c31-9b6e-2d2f0a7b41c8' });
  const bubbleSettings = await bubbleGateway.readSettings('message');
  if (bubbleSettings.status !== 'current') { done({ ok: false, why: 'the double would not read message' }); return; }
  await bubbleGateway.updateSettings({
    domain: 'message',
    revision: bubbleSettings.record.revision,
    values: Object.assign({}, bubbleSettings.record.values, { layoutMaxRows: 10 }),
  });

  const bubbleApp = vue.createApp({
    render: () => vue.h(rootComponent.default, {
      gateway: bubbleGateway,
      connection: bubbleGateway,
      imageUrl: url,
      width: sprite.width,
      height: sprite.height,
      platform: null,
    }),
  });
  bubbleApp.mount(bubbleHost);

  await vue.nextTick();
  // The sheet is a data URL: its decode is asynchronous even so, and a read taken before it commits
  // measures an empty canvas and calls it a failure.
  await new Promise((resolve) => setTimeout(resolve, 250));
  done({ ok: true });
})().catch((error) => done({ ok: false, why: String((error && error.message) || error) }));
`

/**
 * The pet window's own root, mounted the way the window mounts it.
 *
 * `DesktopPetRoot` is what `desktop-pet-entry.ts` hands `createApp`, and it is the only thing that
 * mounts `PetSprite` in the product (`DesktopPetRoot.vue:210`, behind
 * `drawing && imageUrl && !sheetFailure`). The sprite step above mounts the component *directly*,
 * which is why it cannot say anything about that `v-if`: a probe that skips the parent cannot see a
 * sprite the parent refuses to mount, and the branch that mounts it is where the canvas has to exist
 * by the time `onMounted` runs.
 *
 * The host is a double (`memory-pet`, the one `perf/pet.bench.test.ts` drives the same root with):
 * MiniBrowser has no Tauri behind it, so the *host* is the one thing that cannot be the product's
 * here. Everything above it — the entry's root component, its lifecycle, the parent's `v-if`, the
 * sprite's own mount — is.
 *
 * The window's listener bookkeeping is a `Set` of the handlers the window actually holds, not a
 * count of calls: `PetContextMenu` removes three listeners it never added, which is what made an
 * earlier `perf/pet.bench.test.ts` read 0 while the sprite's own listener was attached.
 */
const MOUNT_ROOT = `
const sheetUrl = arguments[0], size = arguments[1], done = arguments[arguments.length - 1];
(async () => {
  const entry = await (await fetch('/src/app/desktop-pet-entry.ts')).text();
  const vueUrl = entry.match(/["']([^"']*\\/deps\\/vue\\.js[^"']*)["']/)?.[1];
  if (!vueUrl) { done({ ok: false, why: 'the dev server serves no vue dependency' }); return; }
  const vue = await import(vueUrl);
  const root = await import('/src/features/desktop-pet/components/DesktopPetRoot.vue');
  const memory = await import('/src/platform/gateways/memory-pet.ts');

  const liveResize = new Set();
  const add = window.addEventListener, remove = window.removeEventListener;
  window.addEventListener = function (type, handler) {
    if (type === 'resize') liveResize.add(handler);
    return add.apply(this, arguments);
  };
  window.removeEventListener = function (type, handler) {
    if (type === 'resize') liveResize.delete(handler);
    return remove.apply(this, arguments);
  };

  // A box and nothing else. It used to carry display:flex/flex-direction:column/
  // justify-content:flex-end/overflow:hidden as well — the product's own .pet-root rules, written
  // a second time by the instrument, with overflow:hidden standing in for the page's rule. A host
  // that supplies the layout it is measuring cannot see the layout change; what a window stand-in
  // owes the product is a size, and html, body { height: 100%; overflow: hidden } is already the
  // page's when the page is desktop-pet.html (which it is).
  const host = document.createElement('div');
  host.id = 'probe-root';
  host.style.cssText = 'width:' + size.width + 'px;height:' + size.height + 'px';
  document.body.append(host);

  const gateway = memory.createMemoryPetGateway({ visible: true });
  let rooted = null;
  // The settings page is another window, so a character changed there reaches this one the way
  // use-pet-window hands it over: one prop, changed under the component that is already up.
  const sheet = vue.ref(sheetUrl);
  const app = vue.createApp({
    render: () =>
      vue.h(root.default, {
        gateway,
        imageUrl: sheet.value,
        width: size.width,
        height: size.height,
        ref: (value) => { rooted = value; },
      }),
  });
  app.mount(host);

  const realGetContext = HTMLCanvasElement.prototype.getContext;
  window.__petRoot = {
    listeners: () => liveResize.size,
    canvas: () => Boolean(document.querySelector('#probe-root canvas.pet-sprite')),
    // Scoped to this host: the page's own entry mounted a second root, and it has no host behind it.
    notice: () => {
      const el = document.querySelector('#probe-root .pet-root__notice');
      return el ? el.textContent.trim() : null;
    },
    choose: (url) => { sheet.value = url; },
    refuseContext: (refuse) => {
      HTMLCanvasElement.prototype.getContext = refuse
        ? function (type, ...rest) {
            // Only this host's canvases: the sheet slicing above draws on detached ones.
            if (type === '2d' && this.closest('#probe-root')) return null;
            return realGetContext.call(this, type, ...rest);
          }
        : realGetContext;
    },
    hide: () => Promise.resolve(rooted && rooted.lifecycle ? rooted.lifecycle.hide() : null),
    show: () => Promise.resolve(rooted && rooted.lifecycle ? rooted.lifecycle.show() : null),
    unmount: () => Promise.resolve(app.unmount()),
    restore: () => {
      window.addEventListener = add;
      window.removeEventListener = remove;
      HTMLCanvasElement.prototype.getContext = realGetContext;
    },
  };
  // The lifecycle asks the host two questions before it draws, and the sheet is a data URL whose
  // decode is asynchronous even so: a read taken before either commits measures an empty host and
  // calls it a failure.
  await new Promise((resolve) => setTimeout(resolve, 500));
  done({ ok: true });
})().catch((error) => done({ ok: false, why: String((error && error.message) || error) }));
`

/** One of the root's own transitions, settled before the driver reads the page again. */
const ROOT_ACTION = `
const name = arguments[0], done = arguments[arguments.length - 1];
window.__petRoot[name]().then(() => setTimeout(() => done(true), 400));
`

const DIGEST = `
const host = arguments[0], done = arguments[arguments.length - 1];
const canvas = document.querySelector(host + ' canvas.pet-sprite');
if (!canvas) { done({ ok: false, why: 'no sprite canvas in ' + host }); return; }
const ctx = canvas.getContext('2d');
// A canvas with no context is a reading this probe takes on purpose, and it has to come back as a
// value the checks can print rather than as a driver error thrown from getImageData: an
// instrument that throws where it should measure reports the same thing for every cause.
if (!ctx) { done({ ok: false, why: 'the canvas has no 2D context' }); return; }
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
   * The parent's `v-if` — the branch the product actually mounts the sprite through.
   *
   * `PetSprite`'s mount body is behind `if (!el) return`, and *if it ever fired* the sprite would be
   * inert rather than absent: a backing store still at WebKit's 300x150 default (nothing sized it),
   * no pixels (no player, no frame callback), no resize listener, and nothing in the window saying
   * so — the parent's sentence covers a sheet that failed to load and not a canvas that never came.
   * Every reading below is that signature inverted, so these four are a check on the guard as much
   * as on the drawing: the sprite step earlier mounts the component directly and cannot see any of
   * it, because a mount the probe performs itself never runs the branch that decides.
   */
  const root = results.root
  const up = root.up
  const again = root.again
  // FAILS IF: the mount body did not run at all — the guard fired, or the parent stopped mounting
  // the sprite. An unsized 300x150 backing store with 0 opaque pixels is that failure exactly. The
  // box is `DesktopPetRoot`'s own (`it` forwards `width`/`height` to the sprite), which is why the
  // reading is compared against the canvas's *client* box rather than against `SPRITE`.
  run(
    'the root mounts a sprite sized to its box and painted',
    `backing ${up.digest?.backing.width}x${up.digest?.backing.height} for a ${up.digest?.client.width}x${up.digest?.client.height} css box (dpr ${up.digest?.dpr}), opaque ${up.digest?.opaque}`,
    up.present === true &&
      up.digest?.ok === true &&
      up.digest.opaque > 0 &&
      up.digest.backing.width === up.digest.client.width * up.digest.dpr &&
      up.digest.client.width === ROOT_BOX.width &&
      up.digest.client.height === ROOT_BOX.height,
  )
  // FAILS IF: the listener is registered after the guard and the guard fired, or a second one is
  // left behind. One is the whole of what the sprite registers (`syncCanvasSize`).
  run(
    'and the window holds exactly one resize listener while it is up',
    `listeners ${up.listeners}`,
    up.listeners === 1,
  )
  // FAILS IF: the re-mount through the parent's `v-if` takes a path the first mount did not — a ref
  // that is only set on the first render, or a player the second instance never builds.
  run(
    'a hide and a show re-mount it, and the second mount is as alive as the first',
    `backing ${again.digest?.backing.width}x${again.digest?.backing.height}, opaque ${again.digest?.opaque}, listeners ${again.listeners}`,
    again.present === true &&
      again.digest?.ok === true &&
      again.digest.opaque > 0 &&
      again.digest.backing.width === up.digest.backing.width &&
      again.listeners === 1,
  )
  // FAILS IF: the unmount stops giving the listener back (§7.1's 关闭/重开无泄漏), or the sprite
  // outlives the branch that mounted it.
  run(
    'and the hidden window and the unmounted one hold neither listener nor canvas',
    `hidden: canvas ${root.hidden.present}, listeners ${root.hidden.listeners}; unmounted: canvas ${root.gone.present}, listeners ${root.gone.listeners}`,
    root.hidden.present === false &&
      root.hidden.listeners === 0 &&
      root.gone.present === false &&
      root.gone.listeners === 0,
  )

  /*
   * Recovery — the half of a failure that is about getting out of it, in the engine that ships. A
   * state a window cannot leave is the defect this pair exists for: a sheet that failed once used to
   * refuse the sprite branch for the rest of the window's life, so picking a working character drew
   * nothing and the window said nothing about why.
   */
  // FAILS IF: the failure is not cleared when the sheet moves — the branch stays refused and the
  // sentence stays up, which is how it read before the fix too. The *pair* discriminates: `broken`
  // without `recovered` is a window that never noticed the character was broken.
  run(
    'a sheet that will not load is stated, and a character that loads draws again',
    `broken: canvas ${root.broken.present}, notice ${JSON.stringify(root.broken.notice)}; recovered: canvas ${root.recovered.present}, opaque ${root.recovered.digest?.opaque}, notice ${JSON.stringify(root.recovered.notice)}`,
    root.broken.present === false &&
      /did not load/.test(root.broken.notice ?? '') &&
      root.recovered.present === true &&
      root.recovered.digest?.ok === true &&
      root.recovered.digest.opaque > 0 &&
      root.recovered.notice === null,
  )
  // FAILS IF: nothing consumes `onUnavailable` — the state `PetSprite` has announced since D2 and
  // that this window did not pass a callback for, which leaves an inert canvas and no sentence. The
  // `restored` half is the other direction: a window that kept the sentence would refuse a canvas
  // that can be painted, and a report that outlives its cause is as wrong as none at all.
  run(
    'a canvas with no 2D context is stated, and a canvas that has one draws again',
    `refused: canvas ${root.unavailable.present}, notice ${JSON.stringify(root.unavailable.notice)}; restored: canvas ${root.restored.present}, opaque ${root.restored.digest?.opaque}, notice ${JSON.stringify(root.restored.notice)}`,
    root.unavailable.present === false &&
      /no 2D context/.test(root.unavailable.notice ?? '') &&
      root.restored.present === true &&
      root.restored.digest?.ok === true &&
      root.restored.digest.opaque > 0 &&
      root.restored.notice === null,
  )
  // FAILS IF: `onUnavailable` starts firing when the canvas is fine — a sentence a user sees while
  // everything works, which is how a real one gets ignored. These three are that same window with
  // nothing wrong with it.
  run(
    'and the working window states nothing at all',
    `up ${JSON.stringify(up.notice)}, re-shown ${JSON.stringify(again.notice)}, hidden ${JSON.stringify(root.hidden.notice)}`,
    up.notice === null && again.notice === null && root.hidden.notice === null,
  )

  // The floating ball's own checks, in `probe-ball.mjs` with the instrument they read.
  checks.push(...verifyBall(results.ball))

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

  /*
   * The height half of 气泡不越屏, and the shape of this check changed when the instrument did.
   *
   * It used to assert that the rows box measured *exactly* the cap (`|rows.height - cap| <= 1`),
   * and that number was the instrument's own: this step mounted `PetBubble` into a div with no
   * sprite in it, so the surface had the whole window to grow into and the box always reached
   * `min(240px, 40vh)`. The product's column has a character in it, and the two are what the window
   * has to hold together: the surface is a *shrinkable* flex item, so what the rows box gets is the
   * smaller of the cap and the room the character leaves. Measured here at a 160x180 character in
   * the 320px window: the cap is 128, the room is 100, and the box takes 100.
   *
   * So the claim is stated as what the product promises rather than as the number the old
   * instrument happened to produce, and it is a stronger one — the old check had no sprite in the
   * column and therefore could not have failed for a surface that pushed the character out.
   */
  run(
    'the rows box never exceeds its cap, and what is over it scrolls',
    `rows ${round(bubble.rows.height)} of a ${cap}px cap, content ${bubble.rowsScroll.scrollHeight}, viewport ${bubble.viewport.width}x${bubble.viewport.height}`,
    bubble.rows.height <= cap + 1 && bubble.rowsScroll.scrollHeight > bubble.rowsScroll.clientHeight,
  )
  // FAILS IF: the bubble stops giving the room back — the surface is a shrinkable flex item of
  // `.pet-root`'s column, and without that it pushes the character past the bottom edge of a window
  // that does not scroll. Measured in Chromium: 348.5px of content in a 320px window, with the
  // character's lower 28.5px past the edge. The sprite's own edge is asserted too, because
  // "everything fits" and "the character stands on the bottom edge" are two claims and a bubble
  // that shrank the *sprite* would satisfy the first while breaking the second.
  run(
    'the bubble gives the height back, so the character stays on the bottom edge',
    `bubble ${round(bubble.bubble.height)} + sprite ${bubble.sprite ? round(bubble.sprite.height) : 'none'} in a ${round(bubble.frame.height)}px window; sprite bottom ${bubble.sprite ? round(bubble.sprite.y + bubble.sprite.height) : 'n/a'} of ${round(bubble.frame.y + bubble.frame.height)}`,
    bubble.sprite !== null &&
      bubble.bubble.y >= bubble.frame.y - 1 &&
      Math.abs(bubble.sprite.y + bubble.sprite.height - (bubble.frame.y + bubble.frame.height)) <= 1,
  )
  // FAILS IF: the surface around the box grows what the box does not — a footer, a second list, a
  // padding change. 60px is the ceiling the Playwright case states: the measured chrome (padding,
  // border) is 14px, and the rest is the room the count, fold and pager rows need.
  run(
    'and the surface is that box plus its chrome',
    `bubble ${round(bubble.bubble.width)}x${round(bubble.bubble.height)} (${round(bubble.bubble.height - bubble.rows.height)}px of chrome)`,
    bubble.bubble.height <= cap + 60 + 1,
  )
  // The two claims that need the *column*, and that the old instrument could not see because it
  // wrote the column itself. Both are 气泡不越屏's horizontal half, one for the surface and one for
  // what is inside it.
  //
  // FAILS IF: `align-self: stretch` comes back on `.pet-root__bubble` — a stretched flex item that
  // cannot reach its stretched size sits at the *start* edge, which is the window's left edge
  // whatever the window's width. Measured in Chromium at a 320px character (a 420px window) the
  // surface came out at x=0..260 with a 160px right gap against the sprite's 50..370.
  const gapLeft = bubble.bubble.x - bubble.frame.x;
  const gapRight = bubble.frame.x + bubble.frame.width - (bubble.bubble.x + bubble.bubble.width);
  run(
    'the bubble is centred over the character',
    `gaps ${round(gapLeft)} / ${round(gapRight)} in a ${round(bubble.frame.width)}px window, sprite ${
      bubble.sprite ? `${round(bubble.sprite.x)}..${round(bubble.sprite.x + bubble.sprite.width)}` : 'none'
    }`,
    Math.abs(gapLeft - gapRight) <= 1,
  )
  // FAILS IF: `session` (or `agent`) stops being allowed to break — `PET_BUBBLE_FIXED_TOKEN_STYLE`
  // is `flex: 0 0 auto` plus `nowrap`, so a field that took it back can neither shrink nor break.
  // Measured in Chromium at a 36-character uuid: the box that scrolls came out 258 wide against a
  // 242px client, and the `session` field reached 16px past its own row.
  const past = bubble.fields.filter((f) => f.pastRow > 1);
  run(
    'and every field of every row stays inside the row that holds it',
    `widest overhang ${round(Math.max(0, ...bubble.fields.map((f) => f.pastRow)))}px, rows scrolling ${
      bubble.rowsScroll.scrollWidth
    }/${bubble.rowsScroll.clientWidth}${past.length ? `, past: ${past.map((f) => f.token + ' +' + round(f.pastRow)).join(', ')}` : ''}`,
    past.length === 0 && bubble.rowsScroll.scrollWidth - bubble.rowsScroll.clientWidth <= 1,
  )
  // FAILS IF: the message payload stops reaching this window. The run filed under a uuid is the
  // seventh of seven, so a bubble drawing its compiled-in cap of five cannot be showing it; and the
  // phrase list is written through the same `message` domain, so a page that stopped reading one
  // would be the "control that lies" this whole change is about.
  run(
    'the rows the settings asked for are the rows drawn',
    `${bubble.fields.filter((f) => f.token === 'session').length} session fields, ${bubble.pages} pager dots, text ${JSON.stringify(bubble.text.slice(0, 60))}`,
    bubble.fields.some((f) => (f.text || '').indexOf('0193c0de-4f2a-7c31-9b6e-2d2f0a7b41c8') !== -1),
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
// One entry per field of every row, with how far it reaches past the row that holds it. A field
// whose right edge is past its row's right edge is past the surface, whatever the two scrollWidths
// say — the row is a flex container with visible overflow, so it reports no scroll of its own.
const fields = [];
for (const row of frame.querySelectorAll('.pet-task__row')) {
  const rowBox = box(row);
  for (const field of row.querySelectorAll('.pet-task__field')) {
    const b = box(field);
    fields.push({
      token: field.getAttribute('data-token'),
      text: field.textContent || '',
      pastRow: b.x + b.width - (rowBox.x + rowBox.width),
    });
  }
}
done({
  ok: true,
  viewport: { width: innerWidth, height: innerHeight },
  frame: box(frame),
  bubble: box(bubble),
  rows: box(rows),
  rowsScroll: {
    scrollWidth: rows.scrollWidth,
    clientWidth: rows.clientWidth,
    scrollHeight: rows.scrollHeight,
    clientHeight: rows.clientHeight,
  },
  fields,
  // The characters the surface is drawing, so a case can say the layout it asked for is the layout
  // it got rather than only measuring boxes.
  text: (bubble.textContent || '').trim(),
  pages: frame.querySelectorAll('.pet-task__page').length,
  // The character, for the placement claim: the bubble is centred *over it*, not merely centred.
  sprite: (function () {
    const canvas = frame.querySelector('canvas.pet-sprite');
    return canvas ? box(canvas) : null;
  })(),
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
  const results = { engine: null, page: null, states: {}, hit: {}, advanced: null, root: {}, ball: {}, bubble: null }
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
    const mounted = await wd.executeAsync(MOUNT, [SPRITE, SHEET, BUBBLE_WINDOW])
    if (!mounted?.ok) throw new Error(`the mount failed: ${mounted?.why}`)

    stage('read the page')
    results.page = await wd.execute(
      `const notice = document.querySelector('.pet-root__notice');
       return { path: location.pathname, notice: notice ? notice.textContent : null,
                hasAppShell: Boolean(document.querySelector('.panes, .status-bar, .settings-overlay')),
                bodyBackground: getComputedStyle(document.body).backgroundColor };`,
    )

    stage('digest: idle')
    results.states.idle = await wd.executeAsync(DIGEST, ['#probe-pet'])
    // The two points the hit test is read at: the middle of the CSS box, and a corner the sprite's
    // own fit cannot reach (it is anchored bottom-centre inside the box).
    const points = { centre: { x: SPRITE.width / 2, y: SPRITE.height * 0.85 }, corner: { x: 2, y: 2 } }
    results.hit.centreAlpha = await wd.executeAsync(ALPHA_AT, [points.centre])
    results.hit.cornerAlpha = await wd.executeAsync(ALPHA_AT, [points.corner])

    stage('wait a few frames')
    await sleep(FRAME_WAIT_MS)
    results.advanced = await wd.executeAsync(DIGEST, ['#probe-pet'])

    stage('digest: working and waiting')
    await wd.execute('window.__petProbe.setState("working"); return true;')
    await sleep(400)
    results.states.working = await wd.executeAsync(DIGEST, ['#probe-pet'])
    await wd.execute('window.__petProbe.setState("waiting"); return true;')
    await sleep(400)
    results.states.waiting = await wd.executeAsync(DIGEST, ['#probe-pet'])
    await wd.execute('window.__petProbe.setState("idle"); return true;')
    await sleep(400)

    stage('hit test')
    results.hit.centre = await wd.execute(
      `return window.__petProbe.hitTest(${points.centre.x}, ${points.centre.y});`,
    )
    results.hit.corner = await wd.execute(
      `return window.__petProbe.hitTest(${points.corner.x}, ${points.corner.y});`,
    )

    // The parent's `v-if`, driven rather than assumed: the root is mounted with the sheet the sprite
    // step above built, and then hidden and shown again, which unmounts and re-mounts the sprite
    // through the same branch the product's window does. Run before the window is resized for the
    // bubble: this step is about the canvas, not the viewport, and a 480x420 page is the one the
    // sprite numbers above were taken on.
    stage('mount the product root')
    const rootSheet = await wd.execute('return window.__petProbe.sheetURL;')
    const rootMounted = await wd.executeAsync(MOUNT_ROOT, [rootSheet, ROOT_BOX])
    if (!rootMounted?.ok) throw new Error(`the root mount failed: ${rootMounted?.why}`)

    const readRoot = async (name) => {
      // One page read, not three: three round-trips can describe three different moments.
      const [present, listeners, notice] = await wd.execute(
        'const r = window.__petRoot; return [r.canvas(), r.listeners(), r.notice()];',
      )
      const digest = present ? await wd.executeAsync(DIGEST, ['#probe-root']) : null
      results.root[name] = { present, listeners, notice, digest }
    }

    stage('root: while it is up')
    await readRoot('up')
    stage('root: hidden')
    await wd.executeAsync(ROOT_ACTION, ['hide'])
    await readRoot('hidden')
    stage('root: shown again')
    await wd.executeAsync(ROOT_ACTION, ['show'])
    await readRoot('again')

    // Read on a window that was already up — one opened *on* a broken character is a rarer shape of
    // this defect than one that breaks under the user — and settled by the 500ms the first mount
    // gets, because the re-render, the load and its verdict all land inside it.
    const chooseSheet = async (url) => {
      await wd.execute(`window.__petRoot.choose(${JSON.stringify(url)}); return true;`)
      await sleep(500)
    }
    const cycle = async () => {
      await wd.executeAsync(ROOT_ACTION, ['hide'])
      await wd.executeAsync(ROOT_ACTION, ['show'])
    }

    stage('root: a sheet that will not load')
    await chooseSheet('/__no-such-character__.png')
    await readRoot('broken')
    stage('root: the user picks a character that loads')
    await chooseSheet(rootSheet)
    await readRoot('recovered')
    // §7.1 unmounts the sprite on hide, so being shown again is a canvas that has never been asked
    // for a context — which is the retry, and a context refused for an element is refused for good.
    stage('root: a canvas whose 2D context is refused')
    await wd.execute('window.__petRoot.refuseContext(true); return true;')
    await cycle()
    await readRoot('unavailable')
    stage('root: the context is back')
    await wd.execute('window.__petRoot.refuseContext(false); return true;')
    await cycle()
    await readRoot('restored')

    stage('root: unmounted')
    await wd.executeAsync(ROOT_ACTION, ['unmount'])
    await readRoot('gone')
    // The window stand-in is put back before anything else runs on the page: a patched
    // `addEventListener` left in place would change what the bubble step's own mounts register.
    await wd.execute('window.__petRoot.restore(); return true;')

    // The floating ball — D11b's surface, mounted nowhere in the product, so this is its only run
    // in the engine that ships. Its instrument, steps and verdict are `probe-ball.mjs`.
    const ballSheet = await wd.execute('return window.__petProbe.sheetURL;')
    results.ball = await driveBall(wd, { digest: DIGEST, sheetUrl: ballSheet, stage })

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
