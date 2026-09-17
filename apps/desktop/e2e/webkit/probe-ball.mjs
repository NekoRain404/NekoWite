/**
 * The floating ball, in the engine that ships.
 *
 * ---- Why this file exists
 *
 * `PetFloatingBall.vue` is D11b's surface and the one component in this feature that **no product
 * code mounts**: `.superpowers/sdd/roadmap/reports/unreachable-inventory.md` F5 found it with no
 * importer outside its own test, and the pet window's root renders the sprite, the bubble and the
 * menu instead. So this is the only place it runs in WebKitGTK at all, and the only place two of
 * its properties can be measured rather than argued:
 *
 *   1. **The face is 32 CSS px.** `FACE_RATIO` draws the character at 58% of a 56px orb, and
 *      `fitFrame` is asked to fit a whole sprite row into that box at this display's pixel ratio.
 *      The same maths is measured at 160x180 by the sprite step in `pet-probe.mjs`; a floor that
 *      collapses at 32px would leave a blank orb and every unit test would still pass, because
 *      happy-dom implements no canvas at all.
 *   2. **A character that cannot be drawn must not leave a frame timer behind.** `SpritePlayer`
 *      arms its loop in the constructor and `IdlePlaylist` arms one of its own, so the loop is
 *      already running *before* anything knows the canvas will never be painted. Two defects met
 *      here: the ball passed neither `on-load-error` nor `on-unavailable`, so a broken character
 *      was silent, and the branch that would have been refused stayed mounted, so the loop went on
 *      ticking at 3-8 Hz with nothing to do (`pet-failure-recovery.md` §7.3). The fix is the
 *      refusal, which unmounts the sprite and destroys the player — and "destroyed" is what the
 *      timer count reads, where "hidden" would read the same as a loop that never stopped.
 *
 * ---- How the timer is read
 *
 * `setTimeout`/`clearTimeout` are counted while the ball is up. A handle that *fires* is dropped
 * from the set as well, because `SpritePlayer.schedule` reschedules from inside its own callback
 * and never clears the handle it just ran — a counter that only listened to `clearTimeout` would
 * count every frame the loop had ever drawn and grow forever (measured: it made the first run of
 * this check read 5, 7, 11, 15 across four phases of one ball).
 *
 * Every reading is then taken **relative to a hidden ball read next to it**, because this page
 * arms timers of its own and an absolute number would be about the harness. `up` must be *above*
 * its reference — a drawing sprite holds the timer — and `broken` must *equal* its own, which is
 * the claim: the ball holding nothing at all, not merely one timer fewer.
 *
 * ---- What it does not measure
 *
 * Nothing about the window. There is no floating-ball window in this app (`window_host.rs` mints
 * `pet-N` character windows only), so the ball is mounted in `desktop-pet.html`, the page
 * `PetSprite` and `DesktopPetRoot` already live on. MiniBrowser is also a different embedding from
 * `wry` — no transparency, no always-on-top, no input regions — so §7.2's compositor rows get no
 * evidence here, and the drag/snap gestures are left to `pet-ball-input.test.ts`.
 */

/** The box the reference builds for the ball: 80x80 with the 56px orb inside (`lib.rs:311-312`). */
export const BALL_BOX = 80

/**
 * Mount the ball the way a shell would, with the instrument it needs to be measured by.
 *
 * The sheet is the one `pet-probe.mjs`'s sprite step already built and handed over, so the ball is
 * given the same pixels every other measurement in this harness is about.
 */
export const MOUNT_BALL = `
const sheetUrl = arguments[0], done = arguments[arguments.length - 1];
(async () => {
  const entry = await (await fetch('/src/app/desktop-pet-entry.ts')).text();
  const vueUrl = entry.match(/["']([^"']*\\/deps\\/vue\\.js[^"']*)["']/)?.[1];
  if (!vueUrl) { done({ ok: false, why: 'the dev server serves no vue dependency' }); return; }
  const vue = await import(vueUrl);
  const ball = await import('/src/features/desktop-pet/components/PetFloatingBall.vue');

  const host = document.createElement('div');
  host.id = 'probe-ball';
  host.style.cssText = 'width:80px;height:80px;display:flex;align-items:center;justify-content:center';
  document.body.append(host);

  const live = new Set();
  const realSet = window.setTimeout, realClear = window.clearTimeout;
  window.setTimeout = function (handler, ms) {
    const id = realSet.call(this, function () { live.delete(id); return handler.apply(this, arguments); }, ms);
    live.add(id);
    return id;
  };
  window.clearTimeout = function (id) { live.delete(id); return realClear.call(this, id); };
  // Before the ball exists, so the entry's own timers cancel out of every reading below.
  const baseline = live.size;

  const url = vue.ref(sheetUrl);
  const shown = vue.ref(true);
  const failures = [];
  const app = vue.createApp({
    render: () => vue.h(ball.default, {
      imageUrl: url.value,
      visible: shown.value,
      onDrawFailure: (notice) => { failures.push(notice); },
    }),
  });
  app.mount(host);

  const realGetContext = HTMLCanvasElement.prototype.getContext;
  window.__petBall = {
    sprite: () => Boolean(document.querySelector('#probe-ball canvas.pet-sprite')),
    plain: () => Boolean(document.querySelector('#probe-ball .pet-ball__highlight')),
    timers: () => live.size - baseline,
    failure: () => (failures.length ? failures[failures.length - 1] : null),
    choose: (next) => { url.value = next; },
    show: (on) => { shown.value = on; },
    refuseContext: (refuse) => {
      HTMLCanvasElement.prototype.getContext = refuse
        ? function (type, ...rest) {
            // Only this host's canvas: the sheet the sprite step built is drawn on a detached one.
            if (type === '2d' && this.closest('#probe-ball')) return null;
            return realGetContext.call(this, type, ...rest);
          }
        : realGetContext;
    },
    restore: () => {
      window.setTimeout = realSet;
      window.clearTimeout = realClear;
      HTMLCanvasElement.prototype.getContext = realGetContext;
    },
  };
  // The sheet is a data URL and its decode is asynchronous even so: a read taken before it commits
  // measures an empty host and calls it a failure.
  await new Promise((resolve) => realSet(resolve, 500));
  done({ ok: true });
})().catch((error) => done({ ok: false, why: String((error && error.message) || error) }));
`

/** One of the ball's own transitions, settled before the driver reads the page again. */
export const BALL_ACTION = `
const fn = arguments[0], arg = arguments[1], done = arguments[arguments.length - 1];
window.__petBall[fn](arg);
setTimeout(() => done(true), 400);
`

/**
 * Drive the ball through the five moments the checks above are about, and return what was read.
 *
 * The driver-side gestures, kept here with the instrument for the same reason: `DIGEST` and the
 * step labels come from the probe because they are its vocabulary, and everything that is about
 * the ball — which states to visit, and in what order — is this file's.
 */
export async function driveBall(wd, { digest, sheetUrl, stage }) {
  /** One page read, not three: three round-trips can describe three different moments. */
  const read = async (name, into) => {
    const [sprite, plain, timers, failure] = await wd.execute(
      'const b = window.__petBall; return [b.sprite(), b.plain(), b.timers(), b.failure()];',
    )
    const shot = sprite ? await wd.executeAsync(digest, ['#probe-ball']) : null
    into[name] = { sprite, plain, timers, failure, digest: shot }
  }
  // Showing and hiding is the ball's own remount (`visible` is §5.1's 显示): a context refused for
  // an element is refused for good, so the retry is a canvas that has never been asked.
  const cycle = async () => {
    await wd.executeAsync(BALL_ACTION, ['show', false])
    await wd.executeAsync(BALL_ACTION, ['show', true])
  }
  const act = (fn, arg) => wd.executeAsync(BALL_ACTION, [fn, arg])

  const out = {}
  stage('mount the floating ball')
  const mounted = await wd.executeAsync(MOUNT_BALL, [sheetUrl])
  if (!mounted?.ok) throw new Error(`the ball mount failed: ${mounted?.why}`)

  stage('ball: while it is drawing')
  await read('up', out)
  // The reference every timer reading below is compared against: the same page with the ball's
  // whole tree unmounted. Taken next to each reading it is used with, because the page arms
  // timers of its own and a baseline from minutes earlier would answer a different question.
  stage('ball: hidden, which is this page with nothing of the ball in it')
  await act('show', false)
  await read('hidden', out)
  stage('ball: shown again')
  await act('show', true)
  await read('again', out)
  stage('ball: a character that will not load')
  await act('choose', '/__no-such-character__.png')
  await read('broken', out)
  // And the same reference again, on the far side of the failure: `broken.timers` equal to this
  // is the reading that says the ball is holding nothing at all — not one timer fewer, none.
  stage('ball: hidden again, after the character failed')
  await act('show', false)
  await read('brokenHidden', out)
  await act('show', true)
  stage('ball: the user picks a character that loads')
  await act('choose', sheetUrl)
  await read('recovered', out)
  stage('ball: a canvas whose 2D context is refused')
  await wd.execute('window.__petBall.refuseContext(true); return true;')
  await cycle()
  await read('unavailable', out)
  stage('ball: the context is back')
  await wd.execute('window.__petBall.refuseContext(false); return true;')
  await cycle()
  await read('restored', out)
  // Both patches are put back before anything else runs on the page: a patched `setTimeout` left
  // in place would count the next step's own mounts, whose readings would then be about this one.
  await wd.execute('window.__petBall.restore(); return true;')
  return out
}

/**
 * The ball's invariants, each named with the mutation that would turn it red.
 *
 * Returned as checks rather than pushed into the caller's list so the seam is the one this file is
 * about: the probe keeps the rules, and everything behind `window.__petBall` is here.
 */
export function verifyBall(ball) {
  const checks = []
  const run = (name, detail, holds) => checks.push({ name, detail, holds: Boolean(holds) })

  // FAILS IF: a 32px face is not worth drawing — `fitFrame`'s integer scale floors to zero at this
  // size, the backing store rounds away, or the orb's own layout gives the canvas no box. The
  // sprite step in `pet-probe.mjs` measures the same maths at 160x180, which is why this is asked
  // apart: it is the only reading of the fit at the size the ball actually draws.
  run(
    'the ball draws its character into the orb',
    `backing ${ball.up?.digest?.backing.width}x${ball.up?.digest?.backing.height} for a ${ball.up?.digest?.client.width}x${ball.up?.digest?.client.height} css face (dpr ${ball.up?.digest?.dpr}), opaque ${ball.up?.digest?.opaque}, timers ${ball.up?.timers}`,
    ball.up?.sprite === true &&
      ball.up?.digest?.ok === true &&
      ball.up.digest.opaque > 0 &&
      ball.up.digest.backing.width === ball.up.digest.client.width * ball.up.digest.dpr,
  )
  // FAILS IF: the ball passes neither handler — the defect the inventory found, where a character
  // that fails to load fails silently. `plain` is the other half: upstream's orb is what is left,
  // so the window is not an empty box either. Measured red: reverting the component to the commit
  // before the fix gives "sprite true, plain false, notice null".
  run(
    'a character that will not load is stated, and the orb is what is left',
    `sprite ${ball.broken?.sprite}, plain ${ball.broken?.plain}, notice ${JSON.stringify(ball.broken?.failure)}`,
    ball.broken?.sprite === false &&
      ball.broken?.plain === true &&
      /did not load/.test(ball.broken?.failure ?? ''),
  )
  // FAILS IF: the branch is refused only visually — the canvas hidden, or left mounted with its
  // player alive. Measured red: the same revert reads "drawing 3 vs hidden 2; broken 3 vs hidden 2"
  // — the drawing ball's own timer, still held by a ball whose character is gone. The `hidden`
  // halves are the same page with the ball's tree unmounted, taken next to each reading.
  run(
    'a refused branch holds no frame timer, and a drawing one does',
    `timers: drawing ${ball.up?.timers} vs hidden ${ball.hidden?.timers}; broken ${ball.broken?.timers} vs hidden ${ball.brokenHidden?.timers}`,
    (ball.up?.timers ?? 0) > (ball.hidden?.timers ?? Infinity) &&
      ball.broken?.timers === ball.brokenHidden?.timers &&
      ball.hidden?.sprite === false,
  )
  // FAILS IF: `on-unavailable` is not passed. That state is the one the loop is at its worst in —
  // the context is refused *after* the player was built, so nothing but the refusal stops it.
  // Measured red on the same revert: "sprite true, plain false, notice null, timers 3 vs hidden 2".
  run(
    'a canvas with no 2D context is stated too, and holds no timer either',
    `sprite ${ball.unavailable?.sprite}, plain ${ball.unavailable?.plain}, notice ${JSON.stringify(ball.unavailable?.failure)}, timers ${ball.unavailable?.timers} vs hidden ${ball.brokenHidden?.timers}`,
    ball.unavailable?.sprite === false &&
      ball.unavailable?.plain === true &&
      /no 2D context/.test(ball.unavailable?.failure ?? '') &&
      ball.unavailable?.timers === ball.brokenHidden?.timers,
  )
  // FAILS IF: the report outlives what failed — the branch stays refused for a character that
  // draws, which is a report a user cannot get rid of. The pair is the discriminator, and the
  // `restored` half is the same direction for the canvas.
  run(
    'and neither failure outlives what failed',
    `recovered: sprite ${ball.recovered?.sprite}, notice ${JSON.stringify(ball.recovered?.failure)}, timers ${ball.recovered?.timers}; restored: sprite ${ball.restored?.sprite}, notice ${JSON.stringify(ball.restored?.failure)}`,
    ball.recovered?.sprite === true &&
      ball.recovered?.failure === null &&
      (ball.recovered?.timers ?? 0) > (ball.brokenHidden?.timers ?? Infinity) &&
      ball.restored?.sprite === true &&
      ball.restored?.failure === null,
  )
  // FAILS IF: the drawing states start firing while the ball is fine — a report a host would show
  // for a ball that is working, which is how a real one gets ignored.
  run(
    'and a ball that is drawing reports nothing',
    `up ${JSON.stringify(ball.up?.failure)}`,
    ball.up?.failure === null,
  )

  return checks
}
