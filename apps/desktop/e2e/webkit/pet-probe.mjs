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

/**
 * The bubble's own text size the two pages are compared at.
 *
 * The largest of the three buttons the settings page offers (`PET_NUMBER_RULES['message.fontSize']`
 * is 10/12/14), written through the message domain on both pages so the number one page draws is the
 * number the other is measured against. It is deliberately not the app's body size (13px at that
 * point in the run) and not the `11px` the preview used to declare.
 */
const MESSAGE_SIZE = 14

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

  // The message domain's theme, driven the way 气泡与消息 drives it: a write to the message domain
  // through the host, which publishes pet-settings-changed — and the window re-reads because of
  // that frame. Written rather than mounted, because the claim is not "a bubble mounted with a
  // theme looks right" but "choosing a theme changes the bubble that is already on the desktop".
  window.__petBubble = {
    setMessage: async (values) => {
      const read = await bubbleGateway.readSettings('message');
      if (read.status !== 'current') return 'the double would not read message';
      const update = await bubbleGateway.updateSettings({
        domain: 'message',
        revision: read.record.revision,
        values: Object.assign({}, read.record.values, values),
      });
      return update.status;
    },
    // The app's own appearance, driven the way the app window drives it: a publish the *host*
    // relays, which every mounted window hears on the pet-host-appearance channel. The double
    // stands in for the host (MiniBrowser has no Tauri behind it); what is measured is the page.
    //
    // A host that cannot publish is *stated* rather than thrown, and the reason is the instrument
    // itself: this step is also read against the tree from before the channel existed, to say what
    // the page drew with nothing published. That reading is the change's own baseline, so the step
    // has to survive a double with no such method.
    setHostAppearance: (values) =>
      typeof bubbleGateway.publishHostAppearance === 'function'
        ? bubbleGateway.publishHostAppearance(values)
        : 'the host has no appearance to publish',
  };

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

  /*
   * The bubble's theme, which is the one 气泡与消息 setting whose effect is the whole desktop rather
   * than the surface: a user picks Light or Dark and the bubble beside their character changes.
   *
   * The check is not "light and dark differ". It is that each theme's bubble is drawn from **this
   * page's own palette for that theme** — the `--app-elevated` and `--app-text` `palettes.css`
   * declares on `:root` and on `[data-theme="dark"]` — so an invented colour (which is what the
   * settings page's own preview uses, and what a careless fix would copy) fails it. The bubble's
   * background is the palette colour at the setting's alpha, so the two RGB channels are read and
   * the alpha is left out of the comparison.
   */
  const theme = results.theme
  /**
   * The channels of a computed colour, as 0..255.
   *
   * **Measured, and it is why this is not a one-line regex**: both engines report a `color-mix`'s
   * computed value in CSS Color 4 syntax — `color(srgb 1 0.996078 0.984314 / 0.92)` in WebKitGTK
   * here, and the same shape in Chromium through `desktop-pet-bubble.spec.ts` — so a parser that
   * only knew `rgb()` would read the bubble's background as `null` and report a working theme as a
   * failure. The legacy form is kept for a computed value that came out of a plain declaration.
   */
  const channels = (value) => {
    const modern = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value ?? '')
    if (modern) return modern.slice(1).map((part) => Math.round(Number(part) * 255))
    const legacy = /rgba?\(([^)]+)\)/.exec(value ?? '')
    return legacy ? legacy[1].split(',').slice(0, 3).map((part) => Math.round(parseFloat(part))) : null
  }
  const hexChannels = (value) => {
    const match = /^#([0-9a-f]{6})$/i.exec(value ?? '')
    if (!match) return null
    const n = parseInt(match[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const closeTo = (a, b) => Boolean(a && b) && a.slice(0, 3).every((n, i) => Math.abs(n - b[i]) <= 1)
  const luminance = (rgb) => (rgb ? 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] : null)

  run(
    'choosing a theme is a write the host applies',
    `light ${theme?.light?.write}, dark ${theme?.dark?.write}, system ${theme?.system?.write}`,
    theme?.light?.write === 'applied' && theme?.dark?.write === 'applied' && theme?.system?.write === 'applied',
  )
  // FAILS IF: the window never reads `message.theme` — which is where this defect started. The
  // control was stored, had a three-way button row and was read by the settings page's preview
  // alone, so the bubble on the desktop did not move whatever the user picked.
  //
  // Light is the *absence* of the attribute and not `data-theme="light"`, which is the one spelling
  // this check has to know about: `:root` is where `palettes.css` declares the light palette, so no
  // block in that table matches a `light` value, and the page's own rule is "say `dark`, or say
  // nothing" (`pet-bubble-theme.ts`'s `applyPetPageTheme`). A reader expecting the literal string
  // would be reading the instrument's idea of the light theme rather than the stylesheet's.
  run(
    'and the pet window’s page carries it',
    `light ${JSON.stringify(theme?.light?.theme)} (${theme?.light?.colorScheme}), dark ${JSON.stringify(theme?.dark?.theme)} (${theme?.dark?.colorScheme})`,
    (theme?.light?.theme === null || theme?.light?.theme === 'light') &&
      theme?.dark?.theme === 'dark' &&
      theme?.light?.colorScheme === 'light' &&
      theme?.dark?.colorScheme === 'dark',
  )
  // FAILS IF: the bubble is drawn from a colour of its own rather than from the page's palette —
  // the settings page's preview hard-codes `#f7f7f5` / `#23211f` for exactly this override, and a
  // second copy of that table in the pet window is how the two would come apart.
  const lightDrawnFromPalette = closeTo(channels(theme?.light?.background), hexChannels(theme?.light?.elevated))
  const darkDrawnFromPalette = closeTo(channels(theme?.dark?.background), hexChannels(theme?.dark?.elevated))
  run(
    'and it is drawn from the palette this page resolved for that theme',
    `light ${theme?.light?.background} over ${theme?.light?.elevated}; dark ${theme?.dark?.background} over ${theme?.dark?.elevated}`,
    lightDrawnFromPalette && darkDrawnFromPalette,
  )
  // FAILS IF: the palette is selected but the surface that shows it does not follow — the two
  // halves of the same claim, measured on the bubble's own element rather than on the root.
  const lightLuminance = luminance(channels(theme?.light?.background))
  const darkLuminance = luminance(channels(theme?.dark?.background))
  run(
    'so the bubble on the desktop changes when the user picks one',
    `luminance light ${lightLuminance === null ? 'n/a' : Math.round(lightLuminance)} vs dark ${
      darkLuminance === null ? 'n/a' : Math.round(darkLuminance)
    }`,
    lightLuminance !== null && darkLuminance !== null && lightLuminance > 128 && darkLuminance < 128,
  )
  // FAILS IF: `system` stops resolving to the engine's own preference. That is the one theme signal
  // a page of its own can observe: this window may not read the application's store (§7.1, and
  // `app/desktop-pet-entry.test.ts` refuses `^stores/` from its graph), and the app resolves its
  // own `system` setting the same way (`stores/appearance.ts:109-116`), from the same engine
  // preference — which is also why the two agree on a default install, where the app's theme
  // setting is `system` (`stores/appearance-schema.ts:66`).
  run(
    'and “follow the system” is the engine’s own preference',
    `systemDark ${theme?.system?.systemDark} → ${JSON.stringify(theme?.system?.theme)}`,
    theme?.system?.theme === (theme?.system?.systemDark ? 'dark' : 'light'),
  )

  /*
   * The app's own appearance, which the window used to carry none of.
   *
   * What each check is about is a *user-visible* consequence rather than an attribute: the palette
   * the page resolved (so a state dot or a hover is the user's accent), the contrast the
   * accessibility setting asked for, and the size the menu is drawn at — the surface that had been
   * drawing at `tokens.css`'s 15px whatever anybody chose.
   */
  const appearance = results.appearance
  run(
    'the app’s axes reach the page that draws the desktop',
    `forest ${JSON.stringify(appearance?.forest?.theme)}/${appearance?.forest?.accent}/${appearance?.forest?.colorScheme}/${appearance?.forest?.contrast}; highContrast ${JSON.stringify(appearance?.highContrast?.theme)}/${appearance?.highContrast?.accent}/${appearance?.highContrast?.colorScheme}/${appearance?.highContrast?.contrast}`,
    appearance?.forest?.theme === 'dark' &&
      appearance?.forest?.accent === 'teal' &&
      appearance?.forest?.colorScheme === 'forest' &&
      appearance?.forest?.contrast === 'normal' &&
      appearance?.highContrast?.theme === 'light' &&
      appearance?.highContrast?.accent === 'coral' &&
      appearance?.highContrast?.colorScheme === 'sunset' &&
      appearance?.highContrast?.contrast === 'high',
  )
  // FAILS IF: the attribute is written but nothing resolves through it — the defect this replaces
  // was not "no attribute" but "the palette's fallback", so what is checked is the *resolved* token
  // on the page root. Each expected value is the member's own declaration in `palettes.css`
  // (`[data-accent="teal"]` at `:129`, `[data-contrast="high"][data-accent="coral"]` at `:277`),
  // read from the table rather than picked: the point is that the page resolved *that* member, and
  // not the `#343532` fallback the light half declares.
  run(
    'and the accent the page resolved is the user’s, not the palette’s fallback',
    `forest ${appearance?.forest?.resolvedAccent} over ${appearance?.forest?.resolvedElevated}; highContrast ${appearance?.highContrast?.resolvedAccent} over ${appearance?.highContrast?.resolvedElevated}`,
    appearance?.forest?.resolvedAccent === '#2e9e8f' &&
      appearance?.forest?.resolvedElevated === '#243020' &&
      appearance?.highContrast?.resolvedAccent === '#c22818' &&
      appearance?.highContrast?.resolvedElevated === '#ffffff',
  )
  // FAILS IF: the size reaches the root and not the surfaces that read it — the menu is
  // `font-size: var(--app-body-size, 12px)`, so a page that never wrote the property drew every
  // item at the fallback, which is the defect this step exists for.
  run(
    'the body size the app was given is the size the window’s menu draws at',
    `16px → ${appearance?.forest?.menuFontSize} (inherited ${appearance?.forest?.inheritedBodySize}); 13px → ${appearance?.highContrast?.menuFontSize} (inherited ${appearance?.highContrast?.inheritedBodySize})`,
    appearance?.forest?.bodySize === '16px' &&
      appearance?.forest?.inheritedBodySize === '16px' &&
      appearance?.forest?.menuFontSize === '16px' &&
      appearance?.highContrast?.bodySize === '13px' &&
      appearance?.highContrast?.menuFontSize === '13px',
  )
  // FAILS IF: the menu never opened, which would make the reading above vacuously `null`.
  run(
    'and the surface that was measured is the window’s own menu',
    `menu drawn: ${appearance?.forest?.menu}, ${appearance?.highContrast?.menu}`,
    appearance?.forest?.menu === true && appearance?.highContrast?.menu === true,
  )

  /*
   * The other two fields of the same domain, measured the same way — one write each, read off the
   * page. `message.fontSize` and `message.dot` were stored and read by nobody until they crossed the
   * appearance payload, so what each check is about is that a *write* changes what is drawn.
   */
  const message = results.message
  run(
    'a text size written on the settings page is the size the bubble draws at',
    `10px → ${JSON.stringify(message?.smallPlain?.fontSize)}, 14px → ${JSON.stringify(message?.largeClaude?.fontSize)}`,
    message?.smallPlain?.fontSize === '10px' && message?.largeClaude?.fontSize === '14px',
  )
  // FAILS IF: the size reaches the surface but not the rows inside it. Upstream sets
  // `--bubble-font-size` on the document root and everything inherits (`main.ts:104`), and a
  // component that set `font-size` on itself alone would leave the rows at the app's body size.
  run(
    'and the rows inside the bubble are drawn at it too',
    `row 10px → ${JSON.stringify(message?.smallPlain?.rowFontSize)}, 14px → ${JSON.stringify(message?.largeClaude?.rowFontSize)}`,
    message?.smallPlain?.rowFontSize === '10px' && message?.largeClaude?.rowFontSize === '14px',
  )
  // FAILS IF: the dot's shape stops following `message.dot`. Both styles are the same state colour
  // and differ in form — a disc is round, upstream's `claude` is a glyph on a square box
  // (`references/desktop-pet/windows/src/styles.css:149`) — so the reading is the box's radius and
  // the glyph's presence, never a colour.
  run(
    'a dot style written on the settings page is the shape the rows draw',
    `plain ${JSON.stringify(message?.smallPlain?.dot)} / ${JSON.stringify(message?.smallPlain?.dotGlyph)}, claude ${JSON.stringify(message?.largeClaude?.dot)} / ${JSON.stringify(message?.largeClaude?.dotGlyph)}`,
    message?.smallPlain?.dot === '50%' &&
      message?.smallPlain?.dotGlyph === 'none' &&
      message?.largeClaude?.dot === '0px' &&
      message?.largeClaude?.dotGlyph !== 'none',
  )

  /*
   * The settings page's own preview — the corner of the size claim Chromium cannot answer for.
   *
   * The bubble's size lives in two pages, and the two readings compared here were taken in
   * **WebKitGTK**, one page each: the desktop's bubble (the `message` step above, on
   * `desktop-pet.html`) and the stage inside the settings dialog (the `preview` step, on the app's
   * page). The claim is the equality of those two measured numbers for one written setting — not
   * "the stage is fixed at 11px" nor "the two differ", neither of which says which number either
   * page drew.
   */
  const preview = results.preview
  run(
    'the settings preview draws the bubble at the size the desktop drew it at, in this engine',
    `stage ${JSON.stringify(preview?.fontSize)} via --pet-bubble-size ${JSON.stringify(preview?.property)} on the app’s page vs ${JSON.stringify(message?.largeClaude?.fontSize)} on the desktop’s; the app’s body ${JSON.stringify(preview?.shellBodySize)}, the stage’s own inherited ${JSON.stringify(preview?.stageBodySize)}`,
    preview?.fontSize === message?.largeClaude?.fontSize &&
      // Both directions, because an equality is satisfiable by two wrong answers: `11px` is what the
      // component used to declare, and the sizes the stage *could* have fallen back to — the app's
      // body size, which is also what the stage inherits now that the dialog is inside the shell's
      // scope — are not the setting. `14px` is `MESSAGE_SIZE`, mirrored here rather than read for the
      // reason above.
      preview?.fontSize === '14px' &&
      preview?.fontSize !== '11px' &&
      preview?.fontSize !== preview?.shellBodySize &&
      preview?.fontSize !== preview?.stageBodySize,
  )

  /*
   * The bubble's **box**, which is the third round of this same defect and the one the first two
   * skipped: the preview declared `padding: 5px 8px`, `line-height: 1.4`, `var(--app-radius-lg)`, a
   * border mixed toward transparent, no shadow and no family, while the desktop drew `6px 8px`,
   * `1.5`, `var(--app-radius)`, the palette's `--app-border`, `var(--app-shadow-card)` and
   * `var(--app-font)`.
   *
   * The two readings are the ones the `message` step and the `preview` step took **in WebKitGTK**,
   * one page each, so this is the same equality the Chromium case states and in the engine that
   * ships. `fontFamily` is deliberately not among the five, for the reason the Chromium case gives:
   * the pet window's page is never told which family the user chose, so that pair would assert the
   * gap rather than the fix. It is reported instead.
   */
  const BOX = ['paddingTop', 'lineHeight', 'borderRadius', 'boxShadow', 'borderColor']
  run(
    'the settings preview draws the box the desktop’s bubble draws, in this engine',
    BOX.map(
      (name) =>
        `${name} ${JSON.stringify(preview?.[name])} vs ${JSON.stringify(message?.largeClaude?.[name])}`,
    ).join('; '),
    BOX.every((name) => preview?.[name] === message?.largeClaude?.[name]) &&
      // Fenced, the way the size half is: the padding the stage declared, the leading it declared,
      // the radius rung it drew and the shadow it did not have. An equality alone is satisfiable by
      // two surfaces that both changed; these are the numbers this defect was measured at.
      preview?.paddingTop === '6px' &&
      preview?.paddingTop !== '5px' &&
      preview?.borderRadius !== '10px' &&
      preview?.boxShadow !== 'none' &&
      preview?.borderColor === message?.largeClaude?.borderColor,
  )

  /*
   * And the scope itself: what the dialog resolved against what `.shell` published and what the page
   * root answers with.
   *
   * The dialog used to be teleported to `body` (`SettingsPanel.vue:112`), which put the whole of it
   * outside `.shell` — the one element carrying `data-theme`, `data-color-scheme`, `data-accent`,
   * `data-contrast` and the seven inline `--app-*` properties — so it drew `palettes.css`'s light
   * `:root` block while the app drew the dark `forest` scheme the user had chosen. Three readings
   * per property, one per element, which is what makes `root` a fence rather than a restatement: the
   * appearance step above drove this page to dark/`forest`/serif/leading 2, none of which the root
   * block can produce.
   */
  run(
    'and the dialog draws the appearance the shell published, not the page root’s',
    `overlay in ${JSON.stringify(preview?.overlayParent)}; elevated ${JSON.stringify(preview?.dialogElevated)} = shell ${JSON.stringify(preview?.shellElevated)} ≠ root ${JSON.stringify(preview?.rootElevated)}; font ${JSON.stringify(preview?.dialogFont)} = shell ${JSON.stringify(preview?.shellFont)} ≠ root ${JSON.stringify(preview?.rootFont)}; leading ${JSON.stringify(preview?.dialogLineHeight)} = shell ${JSON.stringify(preview?.shellLineHeight)} ≠ root ${JSON.stringify(preview?.rootLineHeight)}; body size ${JSON.stringify(preview?.dialogBodySize)} = shell ${JSON.stringify(preview?.shellBodySize)}`,
    preview?.overlayParent === 'shell' &&
      preview?.dialogElevated === preview?.shellElevated &&
      preview?.dialogElevated !== preview?.rootElevated &&
      preview?.dialogFont === preview?.shellFont &&
      preview?.dialogFont !== preview?.rootFont &&
      preview?.dialogLineHeight === preview?.shellLineHeight &&
      preview?.dialogLineHeight !== preview?.rootLineHeight &&
      preview?.dialogBodySize === preview?.shellBodySize,
  )
  /*
   * The select's own popup, which is the dialog's defect one component over and in this engine.
   *
   * `SelectMenu.vue` teleported it to `body`, which is outside `.shell` — the same sentence as the
   * dialog's, with a wider blast radius: every one of the app's 22 lists. It is teleported still
   * (an ancestor with a `transform`/`backdrop-filter`/`contain` becomes the containing block of a
   * `position: fixed` box, and the settings overlay is already one), but into the shell — so the
   * three readings below are one property per element, and the root is the fence.
   */
  run(
    'and a select’s popup draws it too — the list is inside the shell and not on the page body',
    `list in ${JSON.stringify(preview?.popup?.parent)}; elevated ${JSON.stringify(preview?.popup?.elevated)} = shell ${JSON.stringify(preview?.shellElevated)} ≠ root ${JSON.stringify(preview?.rootElevated)}; font ${JSON.stringify(preview?.popup?.font)} = shell ≠ root ${JSON.stringify(preview?.rootFont)}; a row’s family ${JSON.stringify(preview?.popup?.rowFont)}; row ${JSON.stringify(preview?.popup?.rowColor)} vs trigger ${JSON.stringify(preview?.popup?.triggerColor)}; face ${JSON.stringify(preview?.popup?.background)}, shadow ${JSON.stringify(preview?.popup?.shadow)}, ${JSON.stringify(preview?.popup?.gap)}px off the trigger`,
    preview?.popup?.parent === 'shell' &&
      preview?.popup?.elevated === preview?.shellElevated &&
      preview?.popup?.elevated !== preview?.rootElevated &&
      preview?.popup?.font === preview?.shellFont &&
      preview?.popup?.font !== preview?.rootFont &&
      preview?.popup?.rowFont === preview?.shellFont &&
      // The pair: two elements that each declare `color: var(--app-text)`, and the closed control is
      // the one that was always right — it never left the shell.
      preview?.popup?.rowColor === preview?.popup?.triggerColor &&
      // And it is still placed by the recipe: four pixels off the edge it opened from, so the
      // retarget moved what the list *resolves* and not where it *is*.
      Math.abs((preview?.popup?.gap ?? 0) - 4) < 0.5,
  )

  /*
   * The app's **inherited** size and leading, which is the other half of the same defect: they were
   * stated on `body` (`style.css:3`) and `body` is outside `.shell`, so `var(--app-body-size)`
   * resolved there to the token block's `15px` and the whole application inherited that result at
   * every setting. The shell now declares them beside the `font-family` it has always re-declared
   * for the same reason (`appShell-chrome.css:52-53`).
   *
   * Four numbers, and the app's page is the one that decides them: a stored `99` the read clamps to
   * the control's ceiling (20, the check below reads the same number), a leading of 2 driven through
   * the field above, the page root's `15px` token block, and `body`'s own computed size — which is
   * that same `15px` and the number a surface outside the shell still gets.
   */
  run(
    'and the app inherits the size and leading the shell publishes, not the page body’s',
    `shell drew ${JSON.stringify(preview?.shellFontSize)} at leading ${JSON.stringify(preview?.shellLineHeightPx)} while publishing ${JSON.stringify(preview?.shellFontSizeProp)} / ${JSON.stringify(preview?.shellLineHeightProp)}; an element that declares none drew ${JSON.stringify(preview?.contentFontSize)} / ${JSON.stringify(preview?.contentLineHeight)}; the page root carries ${JSON.stringify(preview?.rootBodySize)} and the body drew ${JSON.stringify(preview?.bodyFontSize)}`,
    preview?.shellFontSize === '20px' &&
      preview?.shellFontSize === preview?.shellFontSizeProp &&
      // The leading is a number, so the shell's own box is its size times it: 20 × 2.
      preview?.shellLineHeightPx === '40px' &&
      preview?.shellLineHeightProp === '2' &&
      preview?.contentFontSize === preview?.shellFontSize &&
      preview?.contentLineHeight === preview?.shellLineHeightPx &&
      // Both directions: the number must not be the token block's, and not the one `body` drew.
      preview?.shellFontSize !== preview?.rootBodySize &&
      preview?.shellFontSize !== preview?.bodyFontSize,
  )
  // FAILS IF: the body size above the control's ceiling is drawn at the ceiling by *one* window and
  // verbatim by the other — the third defect, in the engine that ships. The app's number is what its
  // own shell read from the blob it was loaded with (99, written before the page came up), and the
  // pet window's is what its page wrote from the value published to it (the same 99, in the
  // appearance step above). One setting, one size, two windows.
  run(
    'and one stored body size is one size in both windows',
    `a stored ${CORRUPT_BODY_SIZE}: the app’s shell drew ${JSON.stringify(preview?.shellBodySize)}, the pet’s page carried ${JSON.stringify(appearance?.overRange?.bodySize)} (inherited ${JSON.stringify(appearance?.overRange?.inheritedBodySize)}, menu at ${JSON.stringify(appearance?.overRange?.menuFontSize)})`,
    preview?.shellBodySize === '20px' &&
      appearance?.overRange?.bodySize === preview?.shellBodySize &&
      appearance?.overRange?.inheritedBodySize === preview?.shellBodySize &&
      appearance?.overRange?.menuFontSize === preview?.shellBodySize,
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

/**
 * What the pet window's page resolves for one `message.theme`, after writing that theme through
 * the host.
 *
 * Read off the **element**, not off the component: the claim is about what is on the desktop, and
 * the desktop gets the page root's resolved palette. `--app-elevated` and `--app-text` come off the
 * document element because that is where `palettes.css` declares them (`:root` for light,
 * `[data-theme="dark"]` for dark) — and the bubble's own computed background is compared against
 * them, so "the bubble is drawn from this page's palette" is measured rather than asserted. A
 * colour invented in the component (which is what the settings page's preview does) would pass a
 * "light and dark differ" check and fail this one.
 *
 * `data-theme` is read as an attribute rather than through `color-scheme`, because the attribute is
 * what the stylesheet's selectors match; `color-scheme` is read beside it as the second half of the
 * same state — it is what the engine paints scrollbars and form controls from, and the rows box in
 * this very surface scrolls.
 */
const BUBBLE_THEME = `
const value = arguments[0], done = arguments[arguments.length - 1];
(async () => {
  const status = await window.__petBubble.setMessage(value);
  // The window re-reads on the published change, and that read is a promise this script cannot
  // await: the frame arrives through the store's own listener, the read follows it, and the render
  // follows the read. One turn of the event loop plus a frame is what the three need.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const frame = document.getElementById('probe-bubble');
  const bubble = frame && frame.querySelector('.pet-bubble');
  if (!bubble) { done({ ok: false, why: 'the bubble is not in the page' }); return; }
  const root = getComputedStyle(document.documentElement);
  const dot = frame.querySelector('.pet-task__dot');
  const row = frame.querySelector('.pet-task__row');
  done({
    ok: true,
    write: status,
    theme: document.documentElement.getAttribute('data-theme'),
    colorScheme: root.colorScheme,
    systemDark: matchMedia('(prefers-color-scheme: dark)').matches,
    elevated: root.getPropertyValue('--app-elevated').trim(),
    pageText: root.getPropertyValue('--app-text').trim(),
    background: getComputedStyle(bubble).backgroundColor,
    color: getComputedStyle(bubble).color,
    fontSize: getComputedStyle(bubble).fontSize,
    // The bubble's *box*, for the comparison against the settings preview on the app's page: the two
    // surfaces drew a different one in every dimension — 5px 8px / 1.4 / --app-radius-lg and no
    // shadow, against 6px 8px / 1.5 / --app-radius / --app-shadow-card — which is what the preview
    // step's own readings are held against below.
    paddingTop: getComputedStyle(bubble).paddingTop,
    lineHeight: getComputedStyle(bubble).lineHeight,
    borderRadius: getComputedStyle(bubble).borderRadius,
    boxShadow: getComputedStyle(bubble).boxShadow,
    borderColor: getComputedStyle(bubble).borderTopColor,
    rowFontSize: row ? getComputedStyle(row).fontSize : null,
    // The dot's two styles differ in shape and in nothing else: a disc is round, upstream's
    // claude style is a glyph on a square box (references/desktop-pet/windows/src/styles.css:149).
    // The glyph reading is the generated content, so a square box with no glyph in it is not a pass.
    dot: dot ? getComputedStyle(dot).borderRadius : null,
    dotGlyph: dot ? getComputedStyle(dot, '::before').content : null,
  });
})().catch((error) => done({ ok: false, why: String((error && error.message) || error) }));
`

/**
 * The app's own appearance, as the pet window's page draws it (§1's 「保留现有主题、强调色」).
 *
 * The claim is the one the port report filed as missing: the window used to carry **none** of the
 * app's four axes — no `data-theme`, `data-accent`, `data-color-scheme`, `data-contrast` — and no
 * body size, so `palettes.css`'s fallbacks and `tokens.css`'s 15px were what a user saw whatever
 * they had chosen. What is read here is the page root, which is where both the attributes and the
 * property belong (`use-pet-page-appearance.ts`), plus two *consumers*: the resolved `--app-accent`
 * every hover and dot reads, and the menu's own font size, which is the surface nobody had ever
 * asked about (`PetContextMenu.vue:249` is `font-size: var(--app-body-size, 12px)`).
 *
 * `setHostAppearance` is the host's half of the channel the app window uses
 * (`desktop_pet_publish_host_appearance` → `pet-host-appearance`); the page's half is what this
 * reads. Written rather than mounted, because a window that is already open has to follow a change
 * made in Settings — the same shape as the theme step above.
 */
const APPEARANCE = `
const value = arguments[0], done = arguments[arguments.length - 1];
(async () => {
  // A host with no appearance to publish is a *state of this instrument*, not a pass: the reading
  // below then says what the page draws with nothing published, which is exactly what this step
  // measures the change against. An older harness has no such method.
  const published = typeof window.__petBubble.setHostAppearance === 'function'
    ? window.__petBubble.setHostAppearance(value)
    : 'the host has no appearance to publish';
  // The publish is a promise the page hears through its subscription, and the render follows it.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const page_ = document.documentElement;
  const frame = document.getElementById('probe-bubble');
  const bubble = frame && frame.querySelector('.pet-bubble');
  if (!bubble) { done({ ok: false, why: 'the bubble is not in the page' }); return; }
  // The menu, opened the way the window opens it: a right-click on the bubble, which the surface
  // turns into the composition's own event. It is the only surface in this window that has always
  // drawn at the app's body size, and it is the reason the size has to reach a page at all.
  bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 24, clientY: 24 }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  const menu = document.querySelector('.pet-menu');
  const root = getComputedStyle(page_);
  done({
    ok: true,
    published,
    theme: page_.getAttribute('data-theme'),
    colorScheme: page_.getAttribute('data-color-scheme'),
    accent: page_.getAttribute('data-accent'),
    contrast: page_.getAttribute('data-contrast'),
    bodySize: page_.style.getPropertyValue('--app-body-size'),
    resolvedAccent: root.getPropertyValue('--app-accent').trim(),
    resolvedElevated: root.getPropertyValue('--app-elevated').trim(),
    inheritedBodySize: getComputedStyle(frame).getPropertyValue('--app-body-size').trim(),
    menu: Boolean(menu),
    menuFontSize: menu ? getComputedStyle(menu).fontSize : null,
  });
})().catch((error) => done({ ok: false, why: String((error && error.message) || error) }));
`

/**
 * The settings page's own preview, in the engine that ships.
 *
 * **What this step is here for.** The bubble's size lives in two pages: the desktop's bubble (the
 * `message` step above, read off `desktop-pet.html`) and the stage in the settings dialog, which is
 * the *app's* page. Chromium answers the pair for the app's page (`desktop-pet-appearance.spec.ts`)
 * and the probe above answers the pet half in WebKitGTK; this step is the missing corner, so the
 * claim "one setting, one size, two windows" is measured in the product's engine on both sides.
 *
 * **The host is mounted in the product's own mount point.** The preview is drawn by
 * `DesktopPetSettings.vue` into the settings dialog's content box, so the dialog is opened the way a
 * user opens it — the status bar's settings button, then the rail's Appearance row — and the
 * container is mounted into `.dialog-content`, which is what the Chromium case does too. A host
 * appended to `document.body` would have been a page the product never has, which is the mistake the
 * bubble step's own comment records.
 *
 * `fontSize` is written through the message domain before the mount, the same write the pet step
 * above made, so the number compared against is the number *that* page drew.
 */
const PREVIEW = `
const wrote = arguments[0], done = arguments[arguments.length - 1];
(async () => {
  const entry = await (await fetch('/src/main.ts')).text();
  const vueUrl = entry.match(/["']([^"']*\\/deps\\/vue\\.js[^"']*)["']/)?.[1];
  if (!vueUrl) { done({ ok: false, why: 'the dev server serves no vue dependency' }); return; }
  const vue = await import(vueUrl);
  const container = await import('/src/features/desktop-pet-settings/components/DesktopPetSettings.vue');
  const memory = await import('/src/platform/gateways/memory-pet.ts');

  const gateway = memory.createMemoryPetGateway({ visible: true });
  const loaded = await gateway.readSettings('message');
  if (loaded.status !== 'current') { done({ ok: false, why: 'the double would not read message' }); return; }
  await gateway.updateSettings({
    domain: 'message',
    revision: loaded.record.revision,
    values: Object.assign({}, loaded.record.values, { fontSize: wrote, quickBubbles: ['The desktop bubble.'] }),
  });

  const content = document.querySelector('.dialog-content');
  if (!content) { done({ ok: false, why: 'the settings dialog has no content box' }); return; }
  const host = document.createElement('div');
  host.id = 'probe-preview';
  content.append(host);
  const app = vue.createApp({ render: () => vue.h(container.default, { gateway, page: 'bubble' }) });
  app.mount(host);
  await vue.nextTick();
  // The container's own reads are promises and the stage is drawn once they land (§5.3), which is
  // the same settle the Chromium case needs.
  await new Promise((resolve) => setTimeout(resolve, 400));

  const ask = host.querySelector('.pet-preview__ask');
  if (!ask) { done({ ok: false, why: 'the stage drew no button to ask for the bubble' }); return; }
  ask.click();
  await new Promise((resolve) => setTimeout(resolve, 250));

  const bubble = host.querySelector('.pet-preview__bubble');
  const stage = host.querySelector('.pet-preview__stage');
  if (!bubble || !stage) { done({ ok: false, why: 'the stage drew no bubble to measure' }); return; }
  const shell = document.querySelector('.shell');
  const dialog = document.querySelector('.settings-dialog');
  const overlay = document.querySelector('.settings-overlay');
  const style = getComputedStyle(bubble);
  const surface = (el, name) => (el ? getComputedStyle(el).getPropertyValue(name).trim() : null);
  const page_ = document.documentElement;

  /*
   * The select's popup, which is the same defect one component over: it was teleported to the page
   * body, so every one of the app's 22 lists resolved the page root's tokens. Read here rather than
   * in the step above because this is where the dialog is measured; the trigger is the same one, and
   * the list is closed again before anything else reads the page.
   */
  let popupRead = null;
  const trigger = document.querySelector('#settings-ui-font');
  if (trigger) {
    trigger.click();
    await new Promise((resolve) => setTimeout(resolve, 450));
    const list = document.querySelector('.select-popup');
    const row = list ? list.querySelector('.select-option') : null;
    if (list && row) {
      const listBox = list.getBoundingClientRect();
      const triggerBox = trigger.getBoundingClientRect();
      const above = triggerBox.top - listBox.bottom;
      const below = listBox.top - triggerBox.bottom;
      popupRead = {
        parent: list.parentElement ? String(list.parentElement.className) : null,
        elevated: surface(list, '--app-elevated'),
        font: surface(list, '--app-font'),
        background: getComputedStyle(list).backgroundColor,
        shadow: getComputedStyle(list).boxShadow,
        // Two elements that both declare the same text colour property — the row and the closed
        // control it belongs to — so the pair is the engine's answer and not a table written twice.
        rowColor: getComputedStyle(row).color,
        triggerColor: getComputedStyle(trigger).color,
        rowFont: getComputedStyle(row).fontFamily,
        gap: above > 0 ? above : below,
      };
      // Closed with Escape and NOT by clicking a row: a row commits the value it carries, and the
      // first row of this list is the default interface font — which would put the shell back on
      // system-ui for every reading after this one (it did, and the check below said so).
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  done({
    ok: true,
    // The two readings the size claim is made of: what the stage drew, and which property carried it.
    fontSize: style.fontSize,
    property: bubble.style.getPropertyValue('--pet-bubble-size'),
    // The box the third round of this work is about — the same properties the desktop's bubble is
    // read for in the message step above, so the two are compared as strings in one engine.
    paddingTop: style.paddingTop,
    lineHeight: style.lineHeight,
    borderRadius: style.borderRadius,
    boxShadow: style.boxShadow,
    borderColor: style.borderTopColor,
    // The body sizes, for the fence: the app's own (from the stored blob the page was loaded with)
    // and the one the stage inherits. Those two were different numbers for as long as the dialog was
    // teleported to the page body; they are one number now, and the check below says so.
    shellBodySize: shell ? shell.style.getPropertyValue('--app-body-size').trim() : null,
    stageBodySize: surface(stage, '--app-body-size'),
    // And the scope itself, read off three elements the same way the Chromium case reads two: what
    // the shell published, what the dialog resolved, and what the page root — the block a surface
    // outside the shell's scope falls back to — answers with.
    overlayParent: overlay ? String(overlay.parentElement && overlay.parentElement.className) : null,
    shellElevated: surface(shell, '--app-elevated'),
    shellFont: surface(shell, '--app-font'),
    shellLineHeight: surface(shell, '--app-line-height'),
    dialogElevated: surface(dialog, '--app-elevated'),
    dialogFont: surface(dialog, '--app-font'),
    dialogLineHeight: surface(dialog, '--app-line-height'),
    dialogBodySize: surface(dialog, '--app-body-size'),
    dialogText: dialog ? getComputedStyle(dialog).color : null,
    rootElevated: surface(page_, '--app-elevated'),
    rootBodySize: surface(page_, '--app-body-size'),
    rootFont: surface(page_, '--app-font'),
    rootLineHeight: surface(page_, '--app-line-height'),
    // The select's list — where it was rendered, what it resolved and how far off its trigger it
    // sits (SelectMenu.vue's popupHost and place), plus the row/trigger colour pair.
    popup: popupRead,
    // And the *inherited* typography, which is the second half of this round: what the engine
    // computed for the shell and for an element that declares no size of its own, against the
    // property the shell publishes and against the two numbers a fallback would land on (the page
    // root's token block, and body, where style.css:3 states the declaration).
    shellFontSize: shell ? getComputedStyle(shell).fontSize : null,
    shellLineHeightPx: shell ? getComputedStyle(shell).lineHeight : null,
    shellFontSizeProp: surface(shell, '--app-body-size'),
    shellLineHeightProp: surface(shell, '--app-line-height'),
    contentFontSize: content ? getComputedStyle(content).fontSize : null,
    contentLineHeight: content ? getComputedStyle(content).lineHeight : null,
    bodyFontSize: getComputedStyle(document.body).fontSize,
  });
})().catch((error) => done({ ok: false, why: String((error && error.message) || error) }));
`

/**
 * The body size written into the stored blob before the app page loads.
 *
 * Above the Appearance control's ceiling (12..20) and unreachable through it, which is the whole of
 * the state it stands for: a hand-edited blob, a half-written save, a downgrade. The app's own shell
 * drew it verbatim until `stores/appearance-schema.ts`'s read was held to the control's range.
 */
const CORRUPT_BODY_SIZE = 99

/** A roomy window for the app page: the settings dialog is 176px of rail plus a content column. */
const APP_WINDOW = { width: 900, height: 700 }

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
  const results = { engine: null, page: null, states: {}, hit: {}, advanced: null, root: {}, ball: {}, bubble: null, theme: null, message: null, appearance: null, preview: null }
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

    // The theme, last and one theme at a time: each read is taken after a write the host published,
    // and the surface has to have finished re-rendering before the colour means anything. Written
    // in the order light → dark → system so the last one leaves the page on the *rule* rather than
    // on a forced value.
    stage('bubble theme')
    results.theme = {}
    for (const value of ['light', 'dark', 'system']) {
      const read = await wd.executeAsync(BUBBLE_THEME, [{ theme: value }])
      if (!read?.ok) throw new Error(`the ${value} theme is not measurable: ${read?.why}`)
      results.theme[value] = read
    }

    // The `message` domain's other two drawn fields, one write each, read off the same page: the
    // bubble's own text size and the shape of a row's state dot. Both were stored and read by
    // nobody until they crossed this payload, so what is measured is what a *write* changes.
    stage('bubble size and dot')
    results.message = {}
    for (const [name, write] of [
      ['smallPlain', { fontSize: 10, dot: 'plain' }],
      ['largeClaude', { fontSize: MESSAGE_SIZE, dot: 'claude' }],
    ]) {
      const read = await wd.executeAsync(BUBBLE_THEME, [write])
      if (!read?.ok) throw new Error(`the ${name} message write is not measurable: ${read?.why}`)
      results.message[name] = read
    }

    /*
     * The app's own appearance (§1's 「保留现有主题、强调色」), which is the half the window never had:
     * the theme it draws on, the accent its rows are dotted with, the scheme and the contrast the
     * user chose in Appearance, and the body size every menu item is drawn at. Two publishes, so
     * each reading is a *change* rather than a mount — a window that is already open is exactly the
     * case the channel exists for — and the theme member is `system` by now (the step above left it
     * there), which is what makes the app's own theme decide the palette.
     */
    stage('app appearance')
    results.appearance = {}
    for (const [name, published] of [
      ['forest', { theme: 'dark', colorScheme: 'forest', accent: 'teal', highContrast: false, bodyFontSize: 16 }],
      ['highContrast', { theme: 'light', colorScheme: 'sunset', accent: 'coral', highContrast: true, bodyFontSize: 13 }],
      // And the third defect's own state: a body size above the control's ceiling, which the app's
      // own page cannot produce through its UI. The window's rule for a published value
      // (`pet-page-appearance.ts`'s `petBodySizeOf`, 12..20) is what this reading is about, and the
      // app's half of the same number is read in the `preview` step at the end of this run.
      // `dark`/`default` rather than `light`/`default`, and it is an instrument decision: this is
      // the last publish, so it is the palette the pet window's page is left on when the `preview`
      // step at the end of the run compares the two surfaces' boxes. The app's own appearance is
      // driven to the same pair there (`dark`, scheme untouched), so the two pages draw the same
      // `--app-border` and `--app-shadow-card` and a difference between them is a difference in the
      // *box* rather than in the palette. Nothing about this reading is about the theme: every
      // assertion on it is about the body size.
      ['overRange', { theme: 'dark', colorScheme: 'default', accent: 'ink', highContrast: false, bodyFontSize: CORRUPT_BODY_SIZE }],
    ]) {
      const read = await wd.executeAsync(APPEARANCE, [published])
      if (!read?.ok) throw new Error(`the ${name} appearance is not measurable: ${read?.why}`)
      results.appearance[name] = read
    }

    /*
     * The settings page's own preview — the last step, because it *navigates*: the app page is a
     * different document from `desktop-pet.html`, and every reading above is already in hand. The
     * blob is written first, on the pet page's origin (the two pages are the same origin: one dev
     * server), so the app page reads it as its window comes up — which is when the appearance store
     * is built (`AppShell.vue`'s setup), not after some later read.
     */
    stage('the app’s settings page')
    await wd.execute(
      `localStorage.setItem('nekowite.appearance', JSON.stringify({ bodyFontSize: ${CORRUPT_BODY_SIZE} })); return true;`,
    )
    const appUrl = `http://127.0.0.1:${vitePort}/`
    await wd.navigate(appUrl)
    await wd.setWindowRect({
      width: APP_WINDOW.width,
      height: APP_WINDOW.height + WINDOW_CHROME_PX,
      x: 0,
      y: 0,
    })
    await until(() => wd.execute('return Boolean(document.querySelector(".shell"));'), {
      timeout: 20_000,
      what: 'the app page to draw its shell',
    })
    // The settings dialog, opened the way a user opens it: the status bar's own button. A page with
    // no vault still draws the bar — the note columns are what a vault decides — which is what makes
    // this reachable here at all.
    const opened = await wd.execute(
      `const buttons = Array.from(document.querySelectorAll('.status-btn'));
       const last = buttons[buttons.length - 1];
       if (last) last.click();
       return buttons.length;`,
    )
    if (!opened) throw new Error('the app page drew no status button to open the settings with')
    await until(() => wd.execute('return Boolean(document.querySelector(".settings-overlay"));'), {
      timeout: 10_000,
      what: 'the settings dialog to open',
    })
    // The rail's second row is Appearance (`SettingsNavigation`'s own table is general, appearance,
    // …), which is the row the Chromium case clicks for the same reason: a label would need this
    // file to know the locale.
    await wd.execute(
      `const rows = document.querySelectorAll('.dialog-nav .nav-row');
       if (rows[1]) rows[1].click();
       return rows.length;`,
    )
    /*
     * The appearance is driven to a value the page's own defaults cannot produce, through the same
     * controls the Chromium case clicks: dark, the `forest` scheme, and the serif interface font.
     *
     * **The reason it is driven at all**, and not read where it already stands: the three fences in
     * the `preview` checks below compare the dialog against the *page root*, and the page root only
     * differs from the shell when the user has chosen something. A run that left the appearance at
     * its clean-install defaults would have the two answers be the same number, and every one of
     * those checks would pass without testing anything — the vacuity this file's Chromium half
     * fences in its own words.
     *
     * The body size is deliberately **not** touched: the `overRange` check depends on the shell
     * still drawing the `99` its stored blob was seeded with (clamped to the control's ceiling).
     */
    // **Dark only, and the scheme deliberately left alone.** The `overRange` publish above left the
    // pet window's page on `dark`/`default`, and the box check compares the two pages' *palette-
    // derived* properties as well (`--app-shadow-card` and `--app-border`, in `boxShadow` and
    // `borderColor`). Clicking a colour scheme here would move the app's palette and not the pet
    // page's, and the two readings would then differ for a reason that is the instrument's ordering
    // rather than either surface's — which is exactly what the first run of this step measured.
    await wd.execute(
      `const dark = document.querySelectorAll('.dialog-content .view-modes .switch-option')[1];
       if (dark) dark.click();
       return true;`,
    )
    await until(
      () => wd.execute('return document.querySelector(".shell").getAttribute("data-theme") === "dark";'),
      { timeout: 10_000, what: 'the app to switch to the dark theme' },
    )
    // The leading, through the field's own `change` — the event a blur produces, and the same door
    // the Chromium case uses. The *second* numeric field: the Appearance section declares the body
    // size first and the leading second.
    await wd.execute(
      `const fields = document.querySelectorAll('.dialog-content input[type="number"]');
       const leading = fields[1];
       if (leading) { leading.value = '2'; leading.dispatchEvent(new Event('change', { bubbles: true })); }
       return fields.length;`,
    )
    // The interface font, through its own select: the trigger, then the option the store knows by
    // id. The popup is teleported to `body` by the component (`SelectMenu.vue:297`), so it is found
    // at the top level and not inside the dialog.
    await wd.execute(
      `const trigger = document.querySelector('#settings-ui-font');
       if (trigger) trigger.click();
       return Boolean(trigger);`,
    )
    await until(
      () =>
        wd.execute(
          'return Boolean(document.querySelector(".select-popup .select-option[data-value=\'serif\']"));',
        ),
      { timeout: 10_000, what: 'the interface-font popup to open' },
    )
    await wd.execute(
      `const option = document.querySelector('.select-popup .select-option[data-value=\\'serif\\']');
       if (option) option.click();
       return Boolean(option);`,
    )
    await until(
      () =>
        wd.execute(
          'return getComputedStyle(document.querySelector(".shell")).fontFamily.indexOf("Source Serif") >= 0;',
        ),
      { timeout: 10_000, what: 'the chosen interface font to reach the shell' },
    )
    await until(
      () =>
        wd.execute(
          'return getComputedStyle(document.querySelector(".shell")).getPropertyValue("--app-line-height").trim() === "2";',
        ),
      { timeout: 10_000, what: 'the leading the field was given to reach the shell' },
    )
    results.preview = await wd.executeAsync(PREVIEW, [MESSAGE_SIZE])
    if (!results.preview?.ok) {
      throw new Error(`the settings preview is not measurable: ${results.preview?.why}`)
    }

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
